const {
  HTM_ST,
  consumeInitPayload,
  parseControlStream,
  parseLayout,
  collectPaneIds,
  firstPaneId,
  classifyGatewayKey,
  cmdRefreshClient,
  cmdSplitWindow,
  cmdNewWindow,
  cmdKillPane,
  cmdDetach,
  cmdKillServer,
  GATEWAY_MENU,
  cmdSendKeys,
  createScreenTitleFilter,
} = require("./htm-core");

let appRef = null;
const htm = {
  gateway: null,
  leaderUid: null,
  nextSessionHtmId: null,
  pendingHost: null,
  waitingForInit: false,
  initializedSessions: new Set(),
  pendingFollowers: [],
  htmHyperUidMap: new Map(),
  hyperHtmUidMap: new Map(),
  paneHost: new Map(),
  tmuxWindowHost: new Map(),
  windowPanes: new Map(),
  paneWindows: new Map(),
  paneOutputBuffer: new Map(),
  paneTitleFilters: new Map(),
  // iTerm2-compatible OS-window affinities: each inner list is the set of
  // tmux window ids that share one Hyper OS window (Cmd+T tabs).
  affinities: [],
  lastAffinities: null,
  // Most recent %window-add that still needs a pane binding (tmux sometimes
  // omits the initial %layout-change after control-mode new-window).
  pendingNewWindowId: null,
  htmBuffer: "",
  htmProcessing: false,
  htmProcessAgain: false,
  htmProcessScheduled: false,
  logging: false,
  awaitingCommand: false,
  commandBuffer: "",
  commandQueue: [],
  reply: null,
  hadPanes: false,
};

const snooze = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitWhile = async (predicate, timeoutMs = 15000, intervalMs = 50) => {
  const start = Date.now();
  while (predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for HTM session");
    }
    await snooze(intervalMs);
  }
};

const paneKey = (paneId) => String(paneId);

const eachHyperWindow = (fn) => {
  if (appRef && typeof appRef.getWindows === "function") {
    for (const win of appRef.getWindows()) {
      fn(win);
    }
    return;
  }
  if (htm.gateway) {
    fn(htm.gateway);
  }
};

const hostForUid = (uid) => {
  let found = null;
  eachHyperWindow((win) => {
    if (!found && win.sessions && win.sessions.has(uid)) {
      found = win;
    }
  });
  return found || htm.pendingHost || htm.gateway;
};

const hostForPane = (paneId) =>
  htm.paneHost.get(paneKey(paneId)) || htm.gateway;

const leaderPty = () => {
  if (!htm.gateway || !htm.leaderUid) {
    return null;
  }
  const session = htm.gateway.sessions.get(htm.leaderUid);
  return session && session.pty ? session.pty : null;
};

const emitGateway = (text) => {
  if (!htm.gateway || !htm.leaderUid || !text) {
    return;
  }
  htm.gateway.rpc.emit("session data", htm.leaderUid + text);
};

const tmuxMessage = (line) => {
  emitGateway(`${line}\r\n`);
};

const writeToLeader = (command, options = {}) => {
  if (!command) {
    return false;
  }
  const pty = leaderPty();
  if (!pty) {
    console.warn("HTM leader pty is not available; dropping command");
    return false;
  }
  const line = command.endsWith("\n") ? command : `${command}\n`;
  htm.commandQueue.push({
    command,
    printOutput: !!options.printOutput,
  });
  if (htm.logging) {
    tmuxMessage(`> ${line.replace(/\n$/, "")}`);
  }
  pty.write(line);
  return true;
};

/** Persist affinities without occupying the command-reply queue. */
const writeRaw = (command) => {
  if (!command) {
    return false;
  }
  const pty = leaderPty();
  if (!pty) {
    return false;
  }
  const line = command.endsWith("\n") ? command : `${command}\n`;
  if (htm.logging) {
    tmuxMessage(`> ${line.replace(/\n$/, "")}`);
  }
  pty.write(line);
  return true;
};

const affinitiesPayload = () =>
  htm.affinities
    .map((group) =>
      group
        .slice()
        .sort((a, b) => a - b)
        .join(",")
    )
    .join(" ");

const saveAffinities = () => {
  const payload = affinitiesPayload();
  if (payload === htm.lastAffinities) {
    return;
  }
  htm.lastAffinities = payload;
  writeRaw(`set @affinities "${payload}"`);
};

const groupIndexForHost = (host) => {
  if (!host) {
    return -1;
  }
  for (let i = 0; i < htm.affinities.length; i++) {
    for (const wid of htm.affinities[i]) {
      if (htm.tmuxWindowHost.get(String(wid)) === host) {
        return i;
      }
    }
  }
  return -1;
};

const noteWindowOnHost = (windowId, host) => {
  if (windowId == null || !host) {
    return;
  }
  const wid = Number(String(windowId).replace(/^@/, ""));
  if (!Number.isFinite(wid)) {
    return;
  }
  htm.affinities = htm.affinities
    .map((group) => group.filter((id) => id !== wid))
    .filter((group) => group.length > 0);
  const gi = groupIndexForHost(host);
  if (gi < 0) {
    htm.affinities.push([wid]);
  } else if (!htm.affinities[gi].includes(wid)) {
    htm.affinities[gi].push(wid);
  }
  htm.tmuxWindowHost.set(String(wid), host);
  saveAffinities();
};

const dropWindowAffinity = (windowId) => {
  if (windowId == null) {
    return;
  }
  const wid = Number(String(windowId).replace(/^@/, ""));
  htm.affinities = htm.affinities
    .map((group) => group.filter((id) => id !== wid))
    .filter((group) => group.length > 0);
  htm.tmuxWindowHost.delete(String(wid));
  htm.tmuxWindowHost.delete(wid);
  saveAffinities();
};

/**
 * Rebuild ``@affinities`` from which Hyper OS window hosts each tmux window.
 * Called after layout changes so Cmd+T tabs (pending followers) and
 * createWindow materializations stay in sync without relying on a single
 * call site.
 */
const syncAffinitiesFromHosts = () => {
  const byHost = new Map();
  for (const [windowId, panes] of htm.windowPanes.entries()) {
    const wid = Number(String(windowId).replace(/^@/, ""));
    if (!Number.isFinite(wid) || !panes || panes.size === 0) {
      continue;
    }
    let host = htm.tmuxWindowHost.get(String(wid)) || htm.tmuxWindowHost.get(wid);
    if (!host) {
      for (const paneKeyId of panes) {
        host = htm.paneHost.get(paneKey(paneKeyId));
        if (host) {
          break;
        }
      }
    }
    // Fall back to any still-known host for this window's panes via gateway
    // only when we already recorded a host mapping (do not invent affinities
    // for unbound panes during Cmd+T races).
    if (!host) {
      continue;
    }
    htm.tmuxWindowHost.set(String(wid), host);
    if (!byHost.has(host)) {
      byHost.set(host, []);
    }
    const group = byHost.get(host);
    if (!group.includes(wid)) {
      group.push(wid);
    }
  }
  // Never clobber a non-empty @affinities with [] because a transient layout
  // left windowPanes without resolvable hosts (Cmd+T race).
  if (byHost.size === 0 && htm.affinities.length > 0) {
    return;
  }
  htm.affinities = [...byHost.values()].filter((group) => group.length > 0);
  saveAffinities();
};

const printTmuxCommandOutput = (response) => {
  for (const aLine of String(response == null ? "" : response).split("\n")) {
    tmuxMessage(aLine.replace(/\r/g, ""));
  }
};

const addToUidBimap = (htmPaneId, hyperUid, host) => {
  const key = paneKey(htmPaneId);
  console.log("MAPPING HTM TO HYPER:", key, "<->", hyperUid);
  htm.htmHyperUidMap.set(key, hyperUid);
  htm.hyperHtmUidMap.set(hyperUid, key);
  if (host) {
    htm.paneHost.set(key, host);
  }
};

const flushPaneBuffer = (paneId) => {
  const key = paneKey(paneId);
  const buffered = htm.paneOutputBuffer.get(key);
  if (!buffered) {
    return;
  }
  htm.paneOutputBuffer.delete(key);
  const hyperUid = htm.htmHyperUidMap.get(key);
  const host = hostForPane(key);
  if (hyperUid && host) {
    host.rpc.emit("session data", hyperUid + buffered);
  }
};

const bindPane = (paneId, hyperUid, session) => {
  const key = paneKey(paneId);
  if (session) {
    session.htmId = key;
  }
  const host = hostForUid(hyperUid);
  addToUidBimap(key, hyperUid, host);
  htm.initializedSessions.add(key);
  htm.hadPanes = true;
  htm.pendingHost = null;
  flushPaneBuffer(key);
};

const emitPaneOutput = (paneId, data) => {
  const key = paneKey(paneId);
  let filter = htm.paneTitleFilters.get(key);
  if (!filter) {
    filter = createScreenTitleFilter();
    htm.paneTitleFilters.set(key, filter);
  }
  const filtered = filter(data);
  if (!filtered) {
    return;
  }
  const hyperUid = htm.htmHyperUidMap.get(key);
  const host = hostForPane(key);
  if (hyperUid && host) {
    host.rpc.emit("session data", hyperUid + filtered);
    return;
  }
  const prev = htm.paneOutputBuffer.get(key) || "";
  htm.paneOutputBuffer.set(key, prev + filtered);
};

const createSessionForSplit = async (sourcePaneId, newPaneId, sideBySide) => {
  const sourceHyper = htm.htmHyperUidMap.get(paneKey(sourcePaneId));
  const host = hostForPane(sourcePaneId);
  htm.nextSessionHtmId = paneKey(newPaneId);
  htm.pendingHost = host;
  if (sideBySide) {
    host.rpc.emit("split request vertical", { activeUid: sourceHyper });
  } else {
    host.rpc.emit("split request horizontal", { activeUid: sourceHyper });
  }
  await waitWhile(() => htm.nextSessionHtmId);
  htm.initializedSessions.add(paneKey(newPaneId));
};

const createNativeWindow = async (firstPaneIdValue, tmuxWindowId) => {
  htm.nextSessionHtmId = paneKey(firstPaneIdValue);
  if (appRef && typeof appRef.createWindow === "function") {
    appRef.createWindow((win) => {
      htm.pendingHost = win;
      win.rpc.emit("termgroup add req", {});
    });
  } else if (htm.gateway) {
    htm.pendingHost = htm.gateway;
    htm.gateway.rpc.emit("termgroup add req", {
      activeUid: htm.leaderUid,
    });
  } else {
    throw new Error("Hyper app is not ready to create an HTM window");
  }
  await waitWhile(() => htm.nextSessionHtmId);
  htm.initializedSessions.add(paneKey(firstPaneIdValue));
  const tabHyperId = htm.htmHyperUidMap.get(paneKey(firstPaneIdValue));
  if (!tabHyperId) {
    throw new Error("Could not find hyper session for new HTM window");
  }
  const host = hostForPane(firstPaneIdValue);
  if (host && tmuxWindowId != null) {
    noteWindowOnHost(tmuxWindowId, host);
  }
  return tabHyperId;
};

const materializeLayout = async (node, tmuxWindowId, isWindowRoot) => {
  if (!node || node.type === "empty") {
    return;
  }
  if (node.type === "pane") {
    if (!htm.htmHyperUidMap.has(paneKey(node.id)) && isWindowRoot) {
      await createNativeWindow(node.id, tmuxWindowId);
    }
    return;
  }
  await materializeLayout(node.children[0], tmuxWindowId, isWindowRoot);
  const sideBySide = node.type === "sidebyside";
  for (let i = 1; i < node.children.length; i++) {
    const src = firstPaneId(node.children[i - 1]);
    const dst = firstPaneId(node.children[i]);
    if (dst != null && !htm.htmHyperUidMap.has(paneKey(dst))) {
      await createSessionForSplit(src, dst, sideBySide);
    }
    await materializeLayout(node.children[i], tmuxWindowId, false);
  }
};

const bindPendingFollowers = (paneIds, windowId) => {
  const wid = Number(String(windowId).replace(/^@/, ""));
  const windowAlreadyHosted =
    htm.tmuxWindowHost.has(String(wid)) || htm.tmuxWindowHost.has(wid);

  for (const paneId of paneIds) {
    const key = paneKey(paneId);
    if (htm.htmHyperUidMap.has(key)) {
      continue;
    }
    const follower = htm.pendingFollowers[0];
    if (!follower) {
      break;
    }
    // Cmd+T (new-window) followers must not attach to panes of an already
    // hosted tmux window. A layout-change for the old window often races
    // ahead of %layout-change for the new one and would steal the tab,
    // leaving @affinities stuck on the first window only.
    if (follower.htmIsNewWindow && windowAlreadyHosted) {
      break;
    }
    htm.pendingFollowers.shift();
    bindPane(paneId, follower.uid, follower);
    const host = hostForUid(follower.uid);
    if (host && windowId != null) {
      // Cmd+T (and similar): tab lands in the Hyper OS window that created
      // the follower, so join that window's affinity group.
      noteWindowOnHost(windowId, host);
    }
  }
};

const unmapPane = (oldKey, emitExit = true) => {
  const hyperUid = htm.htmHyperUidMap.get(oldKey);
  const host = hostForPane(oldKey);
  if (hyperUid && host && emitExit) {
    try {
      host.rpc.emit("session exit", { uid: hyperUid });
    } catch (err) {
      console.warn("Failed to emit session exit:", err);
    }
    if (host.sessions) {
      host.sessions.delete(hyperUid);
    }
    htm.hyperHtmUidMap.delete(hyperUid);
  } else if (hyperUid) {
    htm.hyperHtmUidMap.delete(hyperUid);
  }
  htm.htmHyperUidMap.delete(oldKey);
  htm.paneHost.delete(oldKey);
  htm.initializedSessions.delete(oldKey);
  htm.paneWindows.delete(oldKey);
  htm.paneOutputBuffer.delete(oldKey);
  htm.paneTitleFilters.delete(oldKey);
};

const maybeKillServerIfEmpty = () => {
  if (htm.leaderUid && htm.hadPanes && htm.htmHyperUidMap.size === 0) {
    writeToLeader(cmdKillServer());
  }
};

const closeRemovedPanes = (windowId, paneIds) => {
  const next = new Set(paneIds.map(paneKey));
  const prev = htm.windowPanes.get(windowId) || new Set();
  htm.windowPanes.set(windowId, next);
  for (const paneId of paneIds) {
    htm.paneWindows.set(paneKey(paneId), windowId);
  }
  for (const oldKey of prev) {
    if (!next.has(oldKey)) {
      unmapPane(oldKey);
    }
  }
};

const closeWindowPanes = (windowId) => {
  const panes = htm.windowPanes.get(windowId) || new Set();
  for (const key of [...panes]) {
    unmapPane(key);
  }
  htm.windowPanes.delete(windowId);
  dropWindowAffinity(windowId);
  maybeKillServerIfEmpty();
};

const closeFollowerSessions = (sessionsToClose, delayMs) => {
  const closeSessions = (i) => {
    if (i === sessionsToClose.length) {
      return;
    }
    const { host, uid } = sessionsToClose[i];
    if (host && host.rpc) {
      try {
        host.rpc.emit("session exit", { uid });
        if (host.sessions) {
          host.sessions.delete(uid);
        }
      } catch (err) {
        console.warn("Failed to close HTM follower session:", err);
      }
    }
    setTimeout(() => {
      closeSessions(i + 1);
    }, delayMs);
  };
  closeSessions(0);
};

const resetHtmState = () => {
  htm.leaderUid = null;
  htm.nextSessionHtmId = null;
  htm.pendingHost = null;
  htm.waitingForInit = false;
  htm.initializedSessions.clear();
  htm.pendingFollowers = [];
  htm.htmHyperUidMap.clear();
  htm.hyperHtmUidMap.clear();
  htm.paneHost.clear();
  htm.tmuxWindowHost.clear();
  htm.windowPanes.clear();
  htm.paneWindows.clear();
  htm.paneOutputBuffer.clear();
  htm.paneTitleFilters.clear();
  htm.affinities = [];
  htm.lastAffinities = null;
  htm.pendingNewWindowId = null;
  htm.htmBuffer = "";
  htm.awaitingCommand = false;
  htm.commandBuffer = "";
  htm.commandQueue = [];
  htm.reply = null;
  htm.logging = false;
  htm.hadPanes = false;
};

const exitHtmMode = (delayMs, detachedMessage) => {
  console.log("Exiting HTM mode");
  if (detachedMessage) {
    tmuxMessage(detachedMessage);
  }
  const sessionsToClose = [];
  eachHyperWindow((win) => {
    if (!win.sessions) {
      return;
    }
    win.sessions.forEach((_session, uid) => {
      if (uid !== htm.leaderUid) {
        sessionsToClose.push({ host: win, uid });
      }
    });
  });
  resetHtmState();
  closeFollowerSessions(sessionsToClose, delayMs);
};

const scheduleWhenReady = (session, fn, retriesLeft = 50) => {
  if (!htm.leaderUid) {
    return;
  }
  if (session.htmId && htm.initializedSessions.has(session.htmId)) {
    fn();
    return;
  }
  if (retriesLeft <= 0) {
    console.warn("HTM session never initialized:", session.htmId);
    return;
  }
  setTimeout(() => scheduleWhenReady(session, fn, retriesLeft - 1), 100);
};

const handleGatewayKeys = (data) => {
  if (data == null || data === "") {
    return;
  }
  if (htm.awaitingCommand) {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const command = htm.commandBuffer.trim();
        htm.awaitingCommand = false;
        htm.commandBuffer = "";
        emitGateway("\r\n");
        if (command) {
          tmuxMessage(`Run command "${command}"`);
          writeToLeader(command, { printOutput: true });
        }
      } else if (ch === "\u007f" || ch === "\b") {
        if (htm.commandBuffer.length) {
          htm.commandBuffer = htm.commandBuffer.slice(0, -1);
          emitGateway("\b \b");
        }
      } else if (ch === "\u001b") {
        htm.awaitingCommand = false;
        htm.commandBuffer = "";
        tmuxMessage("Cancelled.");
      } else if (ch >= " ") {
        htm.commandBuffer += ch;
        emitGateway(ch);
      }
    }
    return;
  }

  // Arrow keys etc. arrive as CSI; iTerm2 never sees those as gateway commands.
  if (data.charCodeAt(0) === 0x1b && data.length > 1) {
    return;
  }

  for (let i = 0; i < data.length; i++) {
    if (htm.awaitingCommand) {
      handleGatewayKeys(data.slice(i));
      return;
    }
    const action = classifyGatewayKey(data[i]);
    if (action === "detach") {
      tmuxMessage("Detaching...");
      writeToLeader(cmdDetach());
      return;
    }
    if (action === "force-quit") {
      tmuxMessage("Exiting tmux mode, but tmux client may still be running.");
      exitHtmMode(100);
      return;
    }
    if (action === "toggle-log") {
      htm.logging = !htm.logging;
      tmuxMessage(`tmux logging ${htm.logging ? "on" : "off"}`);
      continue;
    }
    if (action === "start-command") {
      htm.awaitingCommand = true;
      htm.commandBuffer = "";
      tmuxMessage("Enter command to send tmux:");
    }
  }
};

const processHtmData = function () {
  if (!htm.gateway) {
    return;
  }

  if (htm.htmProcessing) {
    htm.htmProcessAgain = true;
    return;
  }

  htm.htmProcessing = true;
  try {
    const parsed = parseControlStream(htm.htmBuffer);
    htm.htmBuffer = parsed.rest;

    for (const event of parsed.events) {
      if (htm.logging && event.line) {
        tmuxMessage(`< ${event.line}`);
      }
      if (event.type === "exit") {
        console.log("Got shutdown");
        exitHtmMode(100, "Detached");
        return;
      }
      if (htm.reply) {
        if (event.type === "reply" && (event.kind === "end" || event.kind === "error")) {
          if (htm.logging && htm.reply.pending) {
            tmuxMessage(
              `[Normal response to “${htm.reply.pending.command}”]`
            );
          }
          if (htm.reply.pending && htm.reply.pending.printOutput) {
            printTmuxCommandOutput(htm.reply.body.join("\n"));
          }
          htm.reply = null;
          continue;
        }
        // Control-mode notifications (%layout-change, %output, …) can arrive
        // interleaved with %begin/%end command replies. Swallowing them here
        // drops Cmd+T's new window layout and breaks @affinities.
        if (
          event.type !== "layout-change" &&
          event.type !== "output" &&
          event.type !== "window-close" &&
          event.type !== "window-add" &&
          event.type !== "exit"
        ) {
          if (event.line) {
            htm.reply.body.push(event.line);
          }
          continue;
        }
      }
      if (event.type === "reply" && event.kind === "begin") {
        let pending = null;
        if (event.clientOriginated) {
          pending = htm.commandQueue.shift() || null;
          if (htm.logging && pending) {
            tmuxMessage(`[Begin response for ${pending.command}]`);
          }
        }
        htm.reply = { pending, body: [] };
        continue;
      }
      if (event.type === "window-add") {
        htm.pendingNewWindowId = event.windowId;
        continue;
      }
      if (event.type === "output") {
        const outKey = paneKey(event.paneId);
        // tmux control mode often emits %window-add + %output for a new
        // window's first pane without a matching %layout-change. Bind the
        // pending Cmd+T follower from that output so @affinities updates.
        if (
          !htm.htmHyperUidMap.has(outKey) &&
          htm.pendingNewWindowId != null
        ) {
          const idx = htm.pendingFollowers.findIndex((f) => f.htmIsNewWindow);
          if (idx >= 0) {
            const follower = htm.pendingFollowers.splice(idx, 1)[0];
            bindPane(event.paneId, follower.uid, follower);
            htm.initializedSessions.add(outKey);
            const host = hostForUid(follower.uid);
            const wid = htm.pendingNewWindowId;
            const panes = htm.windowPanes.get(wid) || new Set();
            panes.add(outKey);
            htm.windowPanes.set(wid, panes);
            htm.paneWindows.set(outKey, wid);
            if (host) {
              noteWindowOnHost(wid, host);
            }
            htm.pendingNewWindowId = null;
          }
        }
        emitPaneOutput(event.paneId, event.data);
        continue;
      }
      if (event.type === "window-close") {
        if (htm.pendingNewWindowId === event.windowId) {
          htm.pendingNewWindowId = null;
        }
        closeWindowPanes(event.windowId);
        continue;
      }
      if (event.type === "layout-change") {
        if (htm.waitingForInit) {
          const idx = parsed.events.indexOf(event);
          const leftover = parsed.events
            .slice(idx)
            .map((ev) => ev.line)
            .filter(Boolean)
            .join("\n");
          htm.htmBuffer =
            (leftover ? leftover + "\n" : "") + (parsed.rest || "");
          return;
        }
        let tree;
        try {
          tree = parseLayout(event.layout);
        } catch (err) {
          console.error("HTM layout parse failed:", err);
          continue;
        }
        const paneIds = collectPaneIds(tree);
        bindPendingFollowers(paneIds, event.windowId);
        const unknown = paneIds.filter(
          (id) => !htm.htmHyperUidMap.has(paneKey(id))
        );
        const wid = Number(String(event.windowId).replace(/^@/, ""));
        const alreadyHosted =
          htm.tmuxWindowHost.has(String(wid)) || htm.tmuxWindowHost.has(wid);
        // Capture before closeRemovedPanes unmaps panes missing from this layout.
        const donorBeforeClose = [...htm.htmHyperUidMap.keys()].find((k) => {
          const w = htm.paneWindows.get(k);
          return w === event.windowId || w === wid || Number(w) === wid;
        });
        closeRemovedPanes(event.windowId, paneIds);
        if (!unknown.length) {
          syncAffinitiesFromHosts();
          continue;
        }
        // Cmd+T in flight: a layout for the old window must not steal the
        // pending new-window follower (handled above) and must not enter
        // waitingForInit rematerialization — that blocks %layout-change for
        // the new tmux window and leaves @affinities incomplete.
        if (
          alreadyHosted &&
          htm.pendingFollowers.some((f) => f.htmIsNewWindow)
        ) {
          syncAffinitiesFromHosts();
          continue;
        }
        htm.waitingForInit = true;
        const apply = alreadyHosted
          ? (async () => {
              // Rematerialize missing panes inside this OS window. Never call
              // createNativeWindow here — that would open a second Hyper window
              // for an already-hosted tmux window.
              const donor =
                paneIds.find((id) => htm.htmHyperUidMap.has(paneKey(id))) ??
                donorBeforeClose;
              if (donor != null) {
                for (const id of unknown) {
                  if (!htm.htmHyperUidMap.has(paneKey(id))) {
                    await createSessionForSplit(donor, id, true);
                  }
                }
              }
            })()
          : materializeLayout(tree, event.windowId, true);
        apply
          .then(() => {
            syncAffinitiesFromHosts();
            htm.waitingForInit = false;
            processHtmData();
          })
          .catch((err) => {
            console.error("HTM layout apply failed:", err);
            htm.waitingForInit = false;
            processHtmData();
          });
        return;
      }
    }
  } finally {
    htm.htmProcessing = false;
    if (htm.htmProcessAgain) {
      htm.htmProcessAgain = false;
      setTimeout(processHtmData, 0);
    }
  }
};

exports.onApp = (app) => {
  appRef = app;
};

exports.decorateSessionClass = (Session) => {
  if (htm.leaderUid) {
    return class HtmFollowerSession extends Session {
      constructor(options) {
        super(options);
        this.uid = options.uid;
        console.log("CREATING FOLLOWING SESSION:", options.uid);
        if (htm.nextSessionHtmId == null) {
          this.htmId = null;
          // Cmd+T / new tab: no splitDirection. Must not be stolen by a
          // layout-change for an already-hosted tmux window.
          this.htmIsNewWindow = !options.splitDirection;
          htm.pendingFollowers.push(this);
          if (options.splitDirection) {
            // Cmd+D / Cmd+Shift+D. If focus is on the gateway (or any uid
            // not yet mapped), still split tmux's current pane — do not
            // fall through to new-window.
            const sideBySide = options.splitDirection == "VERTICAL";
            const splitFromPane = htm.hyperHtmUidMap.get(options.activeUid);
            console.log(
              "Creating new split for htm:",
              options.uid,
              "from",
              splitFromPane != null ? splitFromPane : "(tmux current)"
            );
            writeToLeader(cmdSplitWindow(splitFromPane, sideBySide));
          } else {
            console.log("CREATING NEW WINDOW FOR HTM:", options.uid);
            writeToLeader(cmdNewWindow());
          }
        } else {
          this.htmId = htm.nextSessionHtmId;
          bindPane(this.htmId, options.uid, this);
        }
        htm.nextSessionHtmId = null;
        console.log("DONE WITH CONSTRUCTOR");
      }

      init() {}

      exit() {
        this.destroy();
      }

      recieveData(data) {
        this.emit("data", data);
      }

      write(data) {
        scheduleWhenReady(this, () => {
          writeToLeader(cmdSendKeys(this.htmId, data));
        });
      }

      resize({ cols, rows }) {
        scheduleWhenReady(this, () => {
          writeToLeader(cmdRefreshClient(cols, rows));
        });
      }

      destroy() {
        console.log("Closing follower");
        if (htm.leaderUid && this.htmId) {
          writeToLeader(cmdKillPane(this.htmId));
          unmapPane(this.htmId, false);
          maybeKillServerIfEmpty();
        }
        this.emit("exit");
        this.ended = true;
      }
    };
  }

  return class HtmLeaderSession extends Session {
    constructor(options) {
      super(options);
      this.uid = options.uid;
    }

    init(options) {
      super.init(options);
      this.uid = options.uid;
      this._htmPending = "";
      this._origEmit = this.emit.bind(this);
      this.emit = (event, ...args) => {
        if (event === "data") {
          const bundled = args[0] || "";
          const payload = bundled.length > 36 ? bundled.slice(36) : bundled;
          if (this.consumeHtm(payload)) {
            return false;
          }
        }
        return this._origEmit(event, ...args);
      };
    }

    consumeHtm(payload) {
      if (htm.leaderUid == this.uid) {
        const stAt = payload.indexOf(HTM_ST);
        if (stAt !== -1) {
          const before = payload.slice(0, stAt);
          const after = payload.slice(stAt + HTM_ST.length);
          if (before) {
            htm.htmBuffer += before;
            processHtmData();
          }
          exitHtmMode(100, "Detached");
          if (after) {
            this._origEmit("data", this.uid + after);
          }
          return true;
        }
        htm.htmBuffer += payload;
        processHtmData();
        return true;
      }

      const result = consumeInitPayload(this._htmPending, payload);
      this._htmPending = result.pending;
      if (result.prefix) {
        this._origEmit("data", this.uid + result.prefix);
      }
      if (result.matched) {
        console.log("Enabling HTM control mode");
        htm.gateway = hostForUid(this.uid);
        htm.leaderUid = this.uid;
        htm.htmBuffer = result.remainder;
        emitGateway(GATEWAY_MENU);
        writeToLeader(cmdRefreshClient(this.cols || 80, this.rows || 24));
        processHtmData();
        return true;
      }
      return result.pending.length > 0 || result.prefix.length > 0;
    }

    destroy() {
      if (htm.leaderUid && htm.leaderUid === this.uid) {
        writeToLeader(cmdDetach());
        exitHtmMode(100);
        console.log("Closing leader");
      }
      super.destroy();
    }

    write(data) {
      if (this.uid == htm.leaderUid) {
        handleGatewayKeys(data);
        return;
      }
      super.write(data);
    }
  };
};

exports.decorateEnv = function (env) {
  if (env.HTM_BIN_DIR) {
    env.PATH = env.HTM_BIN_DIR + (env.PATH ? ":" + env.PATH : "");
  }
  return env;
};

exports.onWindow = function (win) {
  if (!htm.leaderUid) {
    htm.gateway = win;
  }
};
