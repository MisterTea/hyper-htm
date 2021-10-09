const uuid = require("uuid");
const FollowerSession = require("./follower-session");

const INSERT_KEYS = "1";
const INIT_STATE = "2";
const CLIENT_CLOSE_PANE = "3";
const APPEND_TO_PANE = "4";
const NEW_TAB = "5";
const SERVER_CLOSE_PANE = "8";
const NEW_SPLIT = "9";
const RESIZE_PANE = "A";
const DEBUG_LOG = "B";
const INSERT_DEBUG_KEYS = "C";
const SESSION_END = "D";

const UUID_LENGTH = 36;
const htmInitRegexp = new RegExp(/\u001b\u005b###q/);
const htmExitRegexp = new RegExp(/\u001b\u005b\$\$\$q/);

var window = null;

const snooze = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFirstSessionId = (htmState, paneOrSplit) => {
  if (htmState.panes[paneOrSplit]) {
    return paneOrSplit;
  } else {
    return getFirstSessionId(
      htmState,
      htmState.splits[paneOrSplit].panesOrSplits[0]
    );
  }
};

const addToUidBimap = function (window, htmUid, hyperUid) {
  console.log(
    "MAPPING HTM TO HYPER: " +
      htmUid +
      " <-> " +
      hyperUid +
      " " +
      typeof hyperUid
  );
  window.htmHyperUidMap.set(htmUid, hyperUid);
  window.hyperHtmUidMap.set(hyperUid, htmUid);
};

const createSessionForSplit = async function (
  window,
  htmState,
  panesOrSplits,
  vertical,
  i
) {
  const sourceId = getFirstSessionId(htmState, panesOrSplits[i - 1]);
  const newId = getFirstSessionId(htmState, panesOrSplits[i]);

  window.nextSessionHtmId = newId;
  if (vertical) {
    window.rpc.emit("split request vertical", {
      activeUid: window.htmHyperUidMap.get(sourceId),
    });
  } else {
    window.rpc.emit("split request horizontal", {
      activeUid: window.htmHyperUidMap.get(sourceId),
    });
  }
  while (window.nextSessionHtmId) {
    await snooze(1000);
  }
  window.initializedSessions.add(newId);
};

const createSplit = async function (window, htmState, split) {
  const panesOrSplits = split.panesOrSplits;
  // Create the top-level panes (except the first one, which already exists)
  for (var a = 1; a < panesOrSplits.length; a++) {
    await createSessionForSplit(
      window,
      htmState,
      panesOrSplits,
      split.vertical,
      a
    );
  }
  // Go through the list looking for splits and handling accordingly.
  for (var a = 0; a < panesOrSplits.length; a++) {
    const innerSplit = htmState.splits[panesOrSplits[a]];
    if (innerSplit) {
      // We found a split, recurse
      await createSplit(window, htmState, innerSplit);
    }
  }
};

const createTab = async function (
  window,
  htmState,
  currentTab,
  previousTabHyperId
) {
  // When we create a tab (a term group in hyperjs terms), we must also create a session.
  // We pick the first session and create it with the tab
  const firstSessionId = getFirstSessionId(htmState, currentTab.paneOrSplit);
  window.nextSessionHtmId = firstSessionId;
  console.log("CREATING TAB: " + window.nextSessionHtmId);
  window.rpc.emit("termgroup add req", {
    activeUid: previousTabHyperId,
  });
  while (window.nextSessionHtmId) {
    console.log("WAITING FOR TAB TO EXIST");
    await snooze(1000);
  }
  console.log("TAB EXISTS");
  window.initializedSessions.add(firstSessionId);
  if (htmState.splits && htmState.splits[currentTab.paneOrSplit]) {
    await createSplit(
      window,
      htmState,
      htmState.splits[currentTab.paneOrSplit]
    );
  }
  const tabHyperId = window.htmHyperUidMap.get(firstSessionId);
  if (tabHyperId) {
    return tabHyperId;
  } else {
    throw Exception("Could not find hyper tab id");
  }
};

const initHtm = async function (window, htmState) {
  var previousTabHyperId = window.leaderHyperUid;
  for (var order = 0; order < Object.keys(htmState.tabs).length; order++) {
    for (var property in htmState.tabs) {
      if (!htmState.tabs.hasOwnProperty(property)) {
        continue;
      }
      // Values set to 0 are not defined in proto -> JSON
      const tab = htmState.tabs[property];
      if (
        tab.order != order &&
        !(typeof tab.order === "undefined" && order == 0)
      ) {
        continue;
      }
      previousTabHyperId = await createTab(
        window,
        htmState,
        tab,
        previousTabHyperId
      );
    }
  }
};

const processHtmData = function () {
  if (window.sessions.size == 0) {
    // The window has been cleaned up.  Bail.
    return;
  }

  while (window.htmBuffer.length >= 9) {
    if (window.waitingForInit) {
      setTimeout(function () {
        processHtmData();
      }, 100);
      return;
    }
    const packetHeader = window.htmBuffer[0];
    if (packetHeader == SESSION_END) {
      console.log("Got shutdown");

      console.log("Exiting HTM mode");
      const sessionsToClose = [];
      window.sessions.forEach((session, key) => {
        if (key != window.leaderHyperUid) {
          console.log("CLOSING " + key);
          sessionsToClose.push(key);
        } else {
          console.log("NOT CLOSING: " + key);
        }
      });
      // Reset htm state
      window.leaderHyperUid = null;
      window.initializedSessions.clear();

      // Close all followers (slowly so the UI has time to adjust)
      const closeSessions = function (i) {
        if (i == sessionsToClose.length) {
          return;
        }
        window.rpc.emit("session exit", { uid: sessionsToClose[i] });
        window.sessions.delete(sessionsToClose[i]);
        setTimeout(() => {
          closeSessions(i + 1);
        }, 100);
      };
      closeSessions(0);
      return;
    }
    let buf = Buffer.from(window.htmBuffer.substring(1, 9), "base64");
    let length = buf.readInt32LE(0);
    if (length < 0) {
      console.log("Invalid length, shutting down");
      window.clean();
      window.close();
      return;
    }
    if (window.htmBuffer.length - 9 < length) {
      // Not enough data
      break;
    }
    switch (packetHeader) {
      case INIT_STATE: {
        const rawJsonData = window.htmBuffer.substring(9, 9 + length);
        const htmState = JSON.parse(rawJsonData);
        console.log("INITIALIZING HTM");
        window.waitingForInit = true;
        initHtm(window, htmState).then(() => {
          setTimeout(() => {
            window.waitingForInit = false;
          }, 1000);
        });
        break;
      }
      case APPEND_TO_PANE: {
        const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
        var paneData = window.htmBuffer.substring(9 + UUID_LENGTH, 9 + length);
        paneData = Buffer.from(paneData, "base64").toString("utf8");
        window.rpc.emit(
          "session data",
          window.htmHyperUidMap.get(sessionId) + paneData
        );
        break;
      }
      case DEBUG_LOG: {
        var paneData = window.htmBuffer.substring(9, 9 + length);
        paneData = Buffer.from(paneData, "base64").toString("utf8");
        console.log("GOT DEBUG LOG: " + paneData);
        window.rpc.emit("session data", window.leaderHyperUid + paneData);
        break;
      }
      case SERVER_CLOSE_PANE: {
        const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
        console.log("CLOSING SESSION " + sessionId);
        window.rpc.emit("session exit", {
          uid: window.htmHyperUidMap.get(sessionId),
        });
        window.sessions.delete(window.htmHyperUidMap.get(sessionId));
        break;
      }
      default: {
        // Ignore
        console.error("Ignoring packet with header: " + packetHeader);
        break;
      }
    }
    window.htmBuffer = (" " + window.htmBuffer).slice(1 + 9 + length);
  }
};

exports.decorateSessionClass = (Session) => {
  if (window && window.leaderHyperUid) {
    return class HtmFollowerSession extends Session {
      constructor(options) {
        super(options);
        this.uid = options.uid;
        console.log("CREATING FOLLOWING SESSION: " + options.uid);
        if (window.nextSessionHtmId == null) {
          this.htmId = uuid.v4();
          addToUidBimap(window, this.htmId, options.uid);
          if (options.splitDirection) {
            // We are splitting an existing tab
            const splitFromUid = window.hyperHtmUidMap.get(options.activeUid);

            console.log(
              "Creating new split for htm: " + options.uid + " -> " + this.htmId
            );

            const vertical = options.splitDirection == "VERTICAL";
            const length = splitFromUid.length + this.htmId.length + 1;
            const buf = Buffer.allocUnsafe(4);
            buf.writeInt32LE(length, 0);
            const b64Length = buf.toString("base64");
            const directionString = vertical ? "1" : "0";
            const packet =
              NEW_SPLIT +
              b64Length +
              splitFromUid +
              this.htmId +
              directionString;
            window.initializedSessions.add(this.htmId);
            window.sessions.get(window.leaderHyperUid).pty.write(packet);
          } else {
            // We are creating a new tab.  Get the termgroup uid and inform htm.
            let tabUid = uuid.v4();
            console.log(
              "CREATING NEW TAB FOR HTM: " +
                tabUid +
                " " +
                options.uid +
                " -> " +
                this.htmId
            );
            const length = tabUid.length + this.htmId.length;
            const buf = Buffer.allocUnsafe(4);
            buf.writeInt32LE(length, 0);
            const b64Length = buf.toString("base64");
            const packet = NEW_TAB + b64Length + tabUid + this.htmId;
            window.initializedSessions.add(this.htmId);
            window.sessions.get(window.leaderHyperUid).pty.write(packet);
          }
        } else {
          this.htmId = window.nextSessionHtmId;
        }
        addToUidBimap(window, this.htmId, this.uid);
        window.nextSessionHtmId = null;
        console.log("DONE WITH CONSTRUCTOR");
      }

      init(_) {}

      exit() {
        this.destroy();
      }

      recieveData(data) {
        this.emit("data", data);
      }

      write(data) {
        if (!window.initializedSessions.has(this.htmId)) {
          if (window.leaderHyperUid == null) {
            // HTM has ended.
            return;
          }
          console.log("Waiting to write to " + this.htmId);
          setTimeout(() => {
            this.write(data);
          }, 100);
          return;
        }
        const b64Data = Buffer.from(data).toString("base64");
        const length = this.htmId.length + b64Data.length;
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32LE(length, 0);
        const b64Length = buf.toString("base64");
        const packet = INSERT_KEYS + b64Length + this.htmId + b64Data;
        window.sessions.get(window.leaderHyperUid).pty.write(packet);
      }

      resize({ cols, rows }) {
        if (!window.initializedSessions.has(this.htmId)) {
          if (window.leaderHyperUid == null) {
            // HTM has ended.
            return;
          }
          console.log("Waiting to resize " + this.htmId);
          setTimeout(() => {
            this.resize({ cols, rows });
          }, 100);
          return;
        }
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32LE(cols, 0);
        const b64Cols = buf.toString("base64");
        buf.writeInt32LE(rows, 0);
        const b64Rows = buf.toString("base64");
        const length = b64Cols.length + b64Rows.length + this.htmId.length;
        buf.writeInt32LE(length, 0);
        const b64Length = buf.toString("base64");
        const packet = RESIZE_PANE + b64Length + b64Cols + b64Rows + this.htmId;
        console.log("LEADER UID: " + window.leaderHyperUid);
        window.sessions.get(window.leaderHyperUid).pty.write(packet);
      }

      destroy() {
        console.log("Closing follower");
        /*
        const length = this.htmId.length;
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32LE(length, 0);
        const b64Length = buf.toString('base64');
        const packet = CLIENT_CLOSE_PANE + b64Length + this.htmId;
        const leaderSession = window.sessions.get(window.leaderHyperUid);
        if (leaderSession) {
          leaderSession.pty.write(packet);
        }
        */
        this.emit("exit");
        this.ended = true;
      }
    };
  } else {
    return class HtmLeaderSession extends Session {
      constructor(options) {
        super(options);
        this.uid = options.uid;
      }

      init(options) {
        super.init(options);

        this.pty.removeAllListeners("data");
        this.pty.on("data", (chunk) => {
          if (this.ended) {
            return;
          }
          this.read(chunk);
        });
      }

      read(data) {
        if (window.leaderHyperUid == this.uid) {
          if (htmExitRegexp.test(data)) {
            console.log("Exiting HTM mode");
            const sessionsToClose = [];
            window.sessions.forEach((session, key) => {
              if (key != window.leaderHyperUid) {
                console.log("CLOSING " + key);
                sessionsToClose.push(key);
              } else {
                console.log("NOT CLOSING: " + key);
              }
            });
            // Reset htm state
            window.leaderHyperUid = null;
            window.initializedSessions.clear();

            // Close all followers (slowly so the UI has time to adjust)
            const closeSessions = function (i) {
              if (i == sessionsToClose.length) {
                return;
              }
              window.rpc.emit("session exit", { uid: sessionsToClose[i] });
              window.sessions.delete(sessionsToClose[i]);
              setTimeout(() => {
                closeSessions(i + 1);
              }, 500);
            };
            closeSessions(0);
            return;
          }
          window.htmBuffer += data;
          processHtmData();
        } else {
          if (htmInitRegexp.test(data)) {
            // TODO: Close all other window.sessions
            console.log("Enabling HTM mode");
            window.leaderHyperUid = this.uid;
            window.htmBuffer = data.substring(data.search(htmInitRegexp) + 6);
            processHtmData();
          } else {
            this.batcher.write(data);
          }
        }
      }

      destroy() {
        if (window.leaderHyperUid && window.leaderHyperUid === this.uid) {
          window.leaderHyperUid = null;
          console.log("Closing leader");
          // Closing the leader causes the entire window to collapse
          window.clean();
          window.close();
        }
        super.destroy();
      }

      write(data) {
        if (this.uid == window.leaderHyperUid) {
          const length = data.length;
          const buf = Buffer.allocUnsafe(4);
          buf.writeInt32LE(length, 0);
          const b64Length = buf.toString("base64");
          const packet = INSERT_DEBUG_KEYS + b64Length + data;
          super.write(packet);
        } else {
          super.write(data);
        }
      }
    };
  }
};

exports.onWindow = function (window_) {
  window = window_;
  if (window.htmMode) {
    // Already managed by a plugin
    console.log("A plugin is already managing this window");
    return;
  }

  window.htmMode = true;
  window.waitingForInit = false;
  window.leaderHyperUid = null;
  window.nextSessionHtmId = null;
  window.initializedSessions = new Set();

  // This bimap is needed to avoid recycling uuids in hyper since hyper doesn't clean up window.sessions.
  // Note that only follower window.sessions are mapped.  The leader retains it's uuid.
  window.htmHyperUidMap = new Map();
  window.hyperHtmUidMap = new Map();
  window.htmBuffer = "";
};
