const { randomUUID } = require("crypto");
const {
  INSERT_KEYS,
  INIT_STATE,
  CLIENT_CLOSE_PANE,
  APPEND_TO_PANE,
  NEW_TAB,
  SERVER_CLOSE_PANE,
  NEW_SPLIT,
  RESIZE_PANE,
  DEBUG_LOG,
  INSERT_DEBUG_KEYS,
  SESSION_END,
  UUID_LENGTH,
  HTM_EXIT,
  encodeLength,
  parseHtmPackets,
  consumeInitPayload,
} = require("./htm-core");

// Main-process BrowserWindow currently managed by this plugin.
// Hyper calls decorateSessionClass per session, so this is read at construction time.
let window = null;

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

const getFirstSessionId = (htmState, paneOrSplit) => {
  if (htmState.panes[paneOrSplit]) {
    return paneOrSplit;
  }
  return getFirstSessionId(
    htmState,
    htmState.splits[paneOrSplit].panesOrSplits[0]
  );
};

const addToUidBimap = (win, htmUid, hyperUid) => {
  console.log("MAPPING HTM TO HYPER:", htmUid, "<->", hyperUid);
  win.htmHyperUidMap.set(htmUid, hyperUid);
  win.hyperHtmUidMap.set(hyperUid, htmUid);
};

const leaderPty = () => {
  if (!window || !window.leaderHyperUid) {
    return null;
  }
  const session = window.sessions.get(window.leaderHyperUid);
  return session && session.pty ? session.pty : null;
};

const writeToLeader = (packet) => {
  const pty = leaderPty();
  if (!pty) {
    console.warn("HTM leader pty is not available; dropping packet");
    return false;
  }
  pty.write(packet);
  return true;
};

const createSessionForSplit = async (
  win,
  htmState,
  panesOrSplits,
  vertical,
  i
) => {
  const sourceId = getFirstSessionId(htmState, panesOrSplits[i - 1]);
  const newId = getFirstSessionId(htmState, panesOrSplits[i]);

  win.nextSessionHtmId = newId;
  if (vertical) {
    win.rpc.emit("split request vertical", {
      activeUid: win.htmHyperUidMap.get(sourceId),
    });
  } else {
    win.rpc.emit("split request horizontal", {
      activeUid: win.htmHyperUidMap.get(sourceId),
    });
  }
  await waitWhile(() => win.nextSessionHtmId);
  win.initializedSessions.add(newId);
};

const createSplit = async (win, htmState, split) => {
  const panesOrSplits = split.panesOrSplits;
  for (let a = 1; a < panesOrSplits.length; a++) {
    await createSessionForSplit(
      win,
      htmState,
      panesOrSplits,
      split.vertical,
      a
    );
  }
  for (let a = 0; a < panesOrSplits.length; a++) {
    const innerSplit = htmState.splits[panesOrSplits[a]];
    if (innerSplit) {
      await createSplit(win, htmState, innerSplit);
    }
  }
};

const createTab = async (win, htmState, currentTab, previousTabHyperId) => {
  const firstSessionId = getFirstSessionId(htmState, currentTab.paneOrSplit);
  win.nextSessionHtmId = firstSessionId;
  console.log("CREATING TAB:", win.nextSessionHtmId);
  win.rpc.emit("termgroup add req", {
    activeUid: previousTabHyperId,
  });
  await waitWhile(() => win.nextSessionHtmId);
  console.log("TAB EXISTS");
  win.initializedSessions.add(firstSessionId);
  if (htmState.splits && htmState.splits[currentTab.paneOrSplit]) {
    await createSplit(win, htmState, htmState.splits[currentTab.paneOrSplit]);
  }
  const tabHyperId = win.htmHyperUidMap.get(firstSessionId);
  if (!tabHyperId) {
    throw new Error("Could not find hyper tab id");
  }
  return tabHyperId;
};

const initHtm = async (win, htmState) => {
  let previousTabHyperId = win.leaderHyperUid;
  for (let order = 0; order < Object.keys(htmState.tabs).length; order++) {
    for (const property of Object.keys(htmState.tabs)) {
      const tab = htmState.tabs[property];
      // Values omitted by proto -> JSON are treated as order 0
      if (tab.order != order && !(typeof tab.order === "undefined" && order == 0)) {
        continue;
      }
      previousTabHyperId = await createTab(
        win,
        htmState,
        tab,
        previousTabHyperId
      );
    }
  }
};

const closeFollowerSessions = (sessionsToClose, delayMs) => {
  const closeSessions = (i) => {
    if (!window || i === sessionsToClose.length) {
      return;
    }
    window.rpc.emit("session exit", { uid: sessionsToClose[i] });
    window.sessions.delete(sessionsToClose[i]);
    setTimeout(() => {
      closeSessions(i + 1);
    }, delayMs);
  };
  closeSessions(0);
};

const exitHtmMode = (delayMs) => {
  console.log("Exiting HTM mode");
  const sessionsToClose = [];
  window.sessions.forEach((_session, key) => {
    if (key != window.leaderHyperUid) {
      sessionsToClose.push(key);
    }
  });
  window.leaderHyperUid = null;
  window.initializedSessions.clear();
  closeFollowerSessions(sessionsToClose, delayMs);
};

const scheduleWhenReady = (htmId, fn, retriesLeft = 50) => {
  if (!window || window.leaderHyperUid == null) {
    return;
  }
  if (window.initializedSessions.has(htmId)) {
    fn();
    return;
  }
  if (retriesLeft <= 0) {
    console.warn("HTM session never initialized:", htmId);
    return;
  }
  setTimeout(() => scheduleWhenReady(htmId, fn, retriesLeft - 1), 100);
};

const processHtmData = function () {
  if (!window || window.sessions.size == 0) {
    return;
  }

  if (window.htmProcessing) {
    window.htmProcessAgain = true;
    return;
  }

  if (window.waitingForInit) {
    if (!window.htmProcessScheduled) {
      window.htmProcessScheduled = true;
      setTimeout(() => {
        window.htmProcessScheduled = false;
        processHtmData();
      }, 50);
    }
    return;
  }

  window.htmProcessing = true;
  try {

  const parsed = parseHtmPackets(window.htmBuffer);
  window.htmBuffer = parsed.rest;

  for (const packet of parsed.packets) {
    if (packet.error === "invalid length") {
      console.error("Invalid HTM packet length; leaving HTM mode");
      exitHtmMode(0);
      return;
    }
    const packetHeader = packet.header;
    const payload = packet.payload || "";
    if (packetHeader == SESSION_END) {
      console.log("Got shutdown");
      exitHtmMode(100);
      return;
    }
    switch (packetHeader) {
      case INIT_STATE: {
        const htmState = JSON.parse(payload);
        console.log("INITIALIZING HTM");
        window.waitingForInit = true;
        initHtm(window, htmState)
          .then(() => {
            if (window) {
              window.waitingForInit = false;
              processHtmData();
            }
          })
          .catch((err) => {
            console.error("HTM init failed:", err);
            if (window) {
              window.waitingForInit = false;
              processHtmData();
            }
          });
        return;
      }
      case APPEND_TO_PANE: {
        const sessionId = payload.substring(0, UUID_LENGTH);
        let paneData = payload.substring(UUID_LENGTH);
        paneData = Buffer.from(paneData, "base64").toString("utf8");
        const hyperUid = window.htmHyperUidMap.get(sessionId);
        if (hyperUid) {
          window.rpc.emit("session data", hyperUid + paneData);
        } else {
          console.warn("No Hyper session mapped for pane", sessionId);
        }
        break;
      }
      case DEBUG_LOG: {
        let paneData = Buffer.from(payload, "base64").toString("utf8");
        console.log("GOT DEBUG LOG:", paneData);
        window.rpc.emit("session data", window.leaderHyperUid + paneData);
        break;
      }
      case SERVER_CLOSE_PANE: {
        const sessionId = payload.substring(0, UUID_LENGTH);
        console.log("CLOSING SESSION", sessionId);
        const hyperUid = window.htmHyperUidMap.get(sessionId);
        if (hyperUid) {
          window.rpc.emit("session exit", { uid: hyperUid });
          window.sessions.delete(hyperUid);
        }
        break;
      }
      default: {
        console.error("Ignoring packet with header:", packetHeader);
        break;
      }
    }
  }
  } finally {
    window.htmProcessing = false;
    if (window && window.htmProcessAgain) {
      window.htmProcessAgain = false;
      setTimeout(processHtmData, 0);
    }
  }
};

exports.decorateSessionClass = (Session) => {
  if (window && window.leaderHyperUid) {
    return class HtmFollowerSession extends Session {
      constructor(options) {
        super(options);
        this.uid = options.uid;
        console.log("CREATING FOLLOWING SESSION:", options.uid);
        if (window.nextSessionHtmId == null) {
          this.htmId = randomUUID();
          addToUidBimap(window, this.htmId, options.uid);
          const splitFromUid =
            options.splitDirection &&
            window.hyperHtmUidMap.get(options.activeUid);
          if (splitFromUid) {
            console.log(
              "Creating new split for htm:",
              options.uid,
              "->",
              this.htmId
            );
            const vertical = options.splitDirection == "VERTICAL";
            const length = splitFromUid.length + this.htmId.length + 1;
            const directionString = vertical ? "1" : "0";
            const packet =
              NEW_SPLIT +
              encodeLength(length) +
              splitFromUid +
              this.htmId +
              directionString;
            window.initializedSessions.add(this.htmId);
            writeToLeader(packet);
          } else {
            const tabUid = randomUUID();
            console.log(
              "CREATING NEW TAB FOR HTM:",
              tabUid,
              options.uid,
              "->",
              this.htmId
            );
            const length = tabUid.length + this.htmId.length;
            const packet = NEW_TAB + encodeLength(length) + tabUid + this.htmId;
            window.initializedSessions.add(this.htmId);
            writeToLeader(packet);
          }
        } else {
          this.htmId = window.nextSessionHtmId;
        }
        addToUidBimap(window, this.htmId, this.uid);
        window.nextSessionHtmId = null;
        console.log("DONE WITH CONSTRUCTOR");
      }

      // Followers have no local pty; pane I/O is multiplexed through the leader.
      init() {}

      exit() {
        this.destroy();
      }

      recieveData(data) {
        this.emit("data", data);
      }

      write(data) {
        scheduleWhenReady(this.htmId, () => {
          const b64Data = Buffer.from(data).toString("base64");
          const length = this.htmId.length + b64Data.length;
          const packet =
            INSERT_KEYS + encodeLength(length) + this.htmId + b64Data;
          writeToLeader(packet);
        });
      }

      resize({ cols, rows }) {
        scheduleWhenReady(this.htmId, () => {
          const buf = Buffer.allocUnsafe(4);
          buf.writeInt32LE(cols, 0);
          const b64Cols = buf.toString("base64");
          buf.writeInt32LE(rows, 0);
          const b64Rows = buf.toString("base64");
          const length = b64Cols.length + b64Rows.length + this.htmId.length;
          const packet =
            RESIZE_PANE + encodeLength(length) + b64Cols + b64Rows + this.htmId;
          writeToLeader(packet);
        });
      }

      destroy() {
        console.log("Closing follower");
        if (window && window.leaderHyperUid && this.htmId) {
          const packet =
            CLIENT_CLOSE_PANE +
            encodeLength(this.htmId.length) +
            this.htmId;
          writeToLeader(packet);
          window.initializedSessions.delete(this.htmId);
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
      // Intercept at Session.emit: node-pty 0.10 uses onData() (not
      // EventEmitter 'data'), and Hyper's DataBatcher prefixes the uid
      // before emitting. This is the stream the renderer actually sees.
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
      if (!window) {
        return false;
      }
      if (window.leaderHyperUid == this.uid) {
        if (payload.indexOf(HTM_EXIT) !== -1) {
          exitHtmMode(500);
          return true;
        }
        window.htmBuffer += payload;
        processHtmData();
        return true;
      }

      const result = consumeInitPayload(this._htmPending, payload);
      this._htmPending = result.pending;
      if (result.prefix) {
        this._origEmit("data", this.uid + result.prefix);
      }
      if (result.matched) {
        console.log("Enabling HTM mode");
        window.leaderHyperUid = this.uid;
        window.htmBuffer = result.remainder;
        processHtmData();
        return true;
      }
      return result.pending.length > 0 || result.prefix.length > 0;
    }

    destroy() {
      if (window.leaderHyperUid && window.leaderHyperUid === this.uid) {
        window.leaderHyperUid = null;
        console.log("Closing leader");
        window.clean();
        window.close();
      }
      super.destroy();
    }

    write(data) {
      if (this.uid == window.leaderHyperUid) {
        const packet = INSERT_DEBUG_KEYS + encodeLength(data.length) + data;
        super.write(packet);
      } else {
        super.write(data);
      }
    }
  };
};

exports.decorateEnv = function (env) {
  if (env.HTM_BIN_DIR) {
    env.PATH = env.HTM_BIN_DIR + (env.PATH ? ":" + env.PATH : "");
  }
  return env;
};

exports.onWindow = function (window_) {
  window = window_;
  if (window.htmMode) {
    console.log("A plugin is already managing this window");
    return;
  }

  window.htmMode = true;
  window.waitingForInit = false;
  window.leaderHyperUid = null;
  window.nextSessionHtmId = null;
  window.initializedSessions = new Set();
  window.htmHyperUidMap = new Map();
  window.hyperHtmUidMap = new Map();
  window.htmBuffer = "";
  window.htmProcessing = false;
  window.htmProcessAgain = false;
  window.htmProcessScheduled = false;
};
