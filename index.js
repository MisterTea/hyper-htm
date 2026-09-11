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

const createNativeWindow = async (firstPaneIdValue) => {
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
  return tabHyperId;
};

const materializeLayout = async (node, tmuxWindowId, isWindowRoot) => {
  if (!node || node.type === "empty") {
    return;
  }
  if (node.type === "pane") {
    if (!htm.htmHyperUidMap.has(paneKey(node.id)) && isWindowRoot) {
      await createNativeWindow(node.id);
      const host = hostForPane(node.id);
      if (host) {
        htm.tmuxWindowHost.set(tmuxWindowId, host);
      }
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

const bindPendingFollowers = (paneIds) => {
  for (const paneId of paneIds) {
    const key = paneKey(paneId);
    if (htm.htmHyperUidMap.has(key)) {
      continue;
    }
    const follower = htm.pendingFollowers.shift();
    if (!follower) {
      break;
    }
    bindPane(paneId, follower.uid, follower);
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
  htm.tmuxWindowHost.delete(windowId);
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
        if (event.line) {
          htm.reply.body.push(event.line);
        }
        continue;
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
      if (event.type === "output") {
        emitPaneOutput(event.paneId, event.data);
        continue;
      }
      if (event.type === "window-close") {
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
        bindPendingFollowers(paneIds);
        const unknown = paneIds.filter(
          (id) => !htm.htmHyperUidMap.has(paneKey(id))
        );
        closeRemovedPanes(event.windowId, paneIds);
        if (!unknown.length) {
          continue;
        }
        htm.waitingForInit = true;
        materializeLayout(tree, event.windowId, true)
          .then(() => {
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
          htm.pendingFollowers.push(this);
          const splitFromPane =
            options.splitDirection &&
            htm.hyperHtmUidMap.get(options.activeUid);
          if (splitFromPane != null) {
            const sideBySide = options.splitDirection == "VERTICAL";
            console.log(
              "Creating new split for htm:",
              options.uid,
              "from",
              splitFromPane
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
