const uuid = require('uuid');
const FollowerSession = require('./follower-session');

const INSERT_KEYS = '1';
const INIT_STATE = '2';
const CLIENT_CLOSE_PANE = '3';
const APPEND_TO_PANE = '4';
const NEW_TAB = '5';
const SERVER_CLOSE_PANE = '8';
const NEW_SPLIT = '9';
const RESIZE_PANE = 'A';
const DEBUG_LOG = 'B';
const INSERT_DEBUG_KEYS = 'C';

const UUID_LENGTH = 36;
const htmInitRegexp = new RegExp(/\u001b\u005b###q/);
const htmExitRegexp = new RegExp(/\u001b\u005b\$\$\$q/);

let window = null;

const getFirstSessionId = (htmState, paneOrSplit) => {
  if (htmState.panes[paneOrSplit]) {
    return paneOrSplit;
  } else {
    return getFirstSessionId(htmState, htmState.splits[paneOrSplit].panesOrSplits[0]);
  }
};

const addToUidBimap = function(htmUid, hyperUid) {
  console.log('MAPPING HTM TO HYPER: ' + htmUid + ' <-> ' + hyperUid + ' ' + typeof hyperUid);
  window.htmHyperUidMap.set(htmUid, hyperUid);
  window.hyperHtmUidMap.set(hyperUid, htmUid);
};

const createSessionForSplit = function(htmState, panesOrSplits, vertical, i, callback) {
  if (i >= panesOrSplits.length) {
    setTimeout(() => {
      callback();
    }, 100);
    return;
  }

  const sourceId = getFirstSessionId(htmState, panesOrSplits[i - 1]);
  const newId = getFirstSessionId(htmState, panesOrSplits[i]);
  addToUidBimap(newId, uuid.v4());

  window.serverDefinedSessions.add(newId);
  if (vertical) {
    window.rpc.emit('split request vertical', {
      activeUid: window.htmHyperUidMap.get(sourceId),
      sessionUid: window.htmHyperUidMap.get(newId),
      follower: true
    });
  } else {
    window.rpc.emit('split request horizontal', {
      activeUid: window.htmHyperUidMap.get(sourceId),
      sessionUid: window.htmHyperUidMap.get(newId),
      follower: true
    });
  }
  window.initializedSessions.add(newId);

  setTimeout(() => {
    createSessionForSplit(htmState, panesOrSplits, vertical, i + 1, callback);
  }, 100);
};

const createSplit = function(htmState, split) {
  const panesOrSplits = split.panesOrSplits;
  // Create the top-level panes (except the first one, which already exists)
  createSessionForSplit(htmState, panesOrSplits, split.vertical, 1, () => {
    // Go through the list looking for splits and handling accordingly.
    for (var a = 0; a < panesOrSplits.length; a++) {
      const innerSplit = htmState.splits[panesOrSplits[a]];
      if (innerSplit) {
        // We found a split, recurse
        createSplit(htmState, innerSplit);
      }
    }
  });
};

const createTab = function(htmState, currentTab) {
  // When we create a tab (a term group in hyperjs terms), we must also create a session.
  // We pick the first session and create it with the tab
  const firstSessionId = getFirstSessionId(htmState, currentTab.paneOrSplit);
  window.serverDefinedSessions.add(firstSessionId);
  addToUidBimap(firstSessionId, uuid.v4());
  window.rpc.emit('termgroup add req', {
    termGroupUid: currentTab.id,
    sessionUid: window.htmHyperUidMap.get(firstSessionId),
    follower: true
  });
  window.initializedSessions.add(firstSessionId);
  if (htmState.splits && htmState.splits[currentTab.paneOrSplit]) {
    setTimeout(() => {
      createSplit(htmState, htmState.splits[currentTab.paneOrSplit]);
    }, 100);
  }
};

const initHtm = function(htmState) {
  for (var order = 0; order < Object.keys(htmState.tabs).length; order++) {
    for (var property in htmState.tabs) {
      if (!htmState.tabs.hasOwnProperty(property)) {
        continue;
      }
      // Values set to 0 are not defined in proto -> JSON
      const tab = htmState.tabs[property];
      if (tab.order != order && !(typeof tab.order === 'undefined' && order == 0)) {
        continue;
      }
      createTab(htmState, tab);
    }
  }
};

const processHtmData = function() {
  if (window.sessions.size == 0) {
    // The window has been cleaned up.  Bail.
    return;
  }
  console.log('# window.sessions: ' + window.sessions.size);

  console.log(new Date().toLocaleTimeString() + ' Buffer length: ' + window.htmBuffer.length);
  while (window.htmBuffer.length >= 9) {
    if (window.waitingForInit) {
      setTimeout(processHtmData, 100);
      return;
    }
    const packetHeader = window.htmBuffer[0];
    console.log(new Date().toLocaleTimeString() + 'GOT PACKET WITH HEADER: ' + packetHeader);
    let length = Buffer.from(window.htmBuffer.substring(1, 9), 'base64').readInt32LE(0);
    if (length < 0) {
      console.log("Invalid length, shutting down");
      window.clean();
      window.close();
      return;
    }
    console.log(new Date().toLocaleTimeString() + 'length needed: ' + length);
    if (window.htmBuffer.length - 9 < length) {
      // Not enough data
      break;
    }
    switch (packetHeader) {
      case INIT_STATE: {
        const rawJsonData = window.htmBuffer.substring(9, 9 + length);
        const htmState = JSON.parse(rawJsonData);
        console.log('INITIALIZING HTM');
        window.waitingForInit = true;
        initHtm(htmState);
        setTimeout(() => {
          window.waitingForInit = false;
        }, 1000);
        break;
      }
      case APPEND_TO_PANE: {
        const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
        let paneData = window.htmBuffer.substring(9 + UUID_LENGTH, 9 + length);
        paneData = Buffer.from(paneData, 'base64').toString('utf8');
        window.rpc.emit('session data', {uid: window.htmHyperUidMap.get(sessionId), data: paneData});
        break;
      }
      case DEBUG_LOG: {
        let paneData = window.htmBuffer.substring(9, 9 + length);
        paneData = Buffer.from(paneData, 'base64').toString('utf8');
        console.log('GOT DEBUG LOG: ' + paneData);
        window.rpc.emit('session data', {uid: window.leaderUid, data: paneData});
        break;
      }
      case SERVER_CLOSE_PANE: {
        const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
        console.log('CLOSING SESSION ' + sessionId);
        window.rpc.emit('session exit', {uid: window.htmHyperUidMap.get(sessionId)});
        window.sessions.delete(window.htmHyperUidMap.get(sessionId));
        break;
      }
      default: {
        // Ignore
        console.error('Ignoring packet with header: ' + packetHeader);
        break;
      }
    }
    window.htmBuffer = window.htmBuffer.slice(9 + length);
  }
};

exports.extendSession = function(opts, newSession) {
  const uid = opts.sessionUid;
  if (window.leaderUid) {
    const htmSession = window.sessions.get(window.leaderUid);
    console.log('CHECKING FOR ' + opts.sessionUid);
    console.log(window.hyperHtmUidMap);
    if (window.hyperHtmUidMap.has(opts.sessionUid)) {
      console.log('FOUND.  NOT SENDING HTM COMMAND');
      // This is part of htm initialization.  Don't tell HTM to create anything.
    } else if (opts.splitDirection) {
      // We are splitting an existing tab
      const splitFromUid = window.hyperHtmUidMap.get(opts.activeUid);

      addToUidBimap(uuid.v4(), opts.sessionUid);
      const newSessionUid = window.hyperHtmUidMap.get(opts.sessionUid);
      console.log('Creating new split for htm: ' + opts.sessionUid + ' -> ' + newSessionUid);

      const vertical = opts.splitDirection == 'VERTICAL';
      const length = splitFromUid.length + newSessionUid.length + 1;
      const buf = Buffer.allocUnsafe(4);
      buf.writeInt32LE(length, 0);
      const b64Length = buf.toString('base64');
      const directionString = vertical ? '1' : '0';
      const packet = NEW_SPLIT + b64Length + splitFromUid + newSessionUid + directionString;
      htmSession.pty.write(packet);
      window.initializedSessions.add(newSessionUid);
    } else {
      // We are creating a new tab.  Get the termgroup uid and inform htm.
      addToUidBimap(uuid.v4(), opts.sessionUid);
      const newSessionUid = window.hyperHtmUidMap.get(opts.sessionUid);

      console.log('CREATING NEW TAB FOR HTM: ' + opts.termGroupUid + ' ' + opts.sessionUid + ' -> ' + newSessionUid);
      const length = opts.termGroupUid.length + newSessionUid.length;
      const buf = Buffer.allocUnsafe(4);
      buf.writeInt32LE(length, 0);
      const b64Length = buf.toString('base64');
      const packet = NEW_TAB + b64Length + opts.termGroupUid + newSessionUid;
      htmSession.pty.write(packet);
      window.initializedSessions.add(newSessionUid);
    }
    return new FollowerSession(window, window.hyperHtmUidMap.get(opts.sessionUid), window.sessions.get(window.leaderUid).shell);
  } else {
    // Swap out the read function on the session with one that handles htm
    newSession.oldRead = newSession.read;
    newSession.read = function(data) {
      if (window.leaderUid) {
        console.log('IN CUSTOM SESSION DATA HANDLER');
        if (htmExitRegexp.test(data)) {
          console.log('Exiting HTM mode');
          const sessionsToClose = [];
          window.sessions.forEach((session, key) => {
            if (key != window.leaderUid) {
              console.log('CLOSING ' + key);
              sessionsToClose.push(key);
            } else {
              console.log('NOT CLOSING: ' + key);
            }
          });
          // Reset htm state
          window.leaderUid = null;
          window.initializedSessions.clear();
          window.serverDefinedSessions.clear();

          // Close all followers (slowly so the UI has time to adjust)
          const closeSessions = function(i) {
            if (i == sessionsToClose.length) {
              return;
            }
            window.rpc.emit('session exit', {uid: sessionsToClose[i]});
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
        console.log("Testing for HTM");
        if (htmInitRegexp.test(data)) {
          // TODO: Close all other window.sessions
          console.log('Enabling HTM mode');
          window.leaderUid = uid;
          window.leaderUid = uid;
          window.htmBuffer = data.substring(data.search(htmInitRegexp) + 6);
          processHtmData();
        } else {
          newSession.oldRead(data);
        }
      }
    };
    newSession.oldDestroy = newSession.destroy;
    newSession.destroy = function() {
      if (window.leaderUid && window.leaderUid === uid) {
        console.log('Closing leader');
        // Closing the leader causes the entire window to collapse
        window.clean();
        window.close();
      } else {
        newSession.oldDestroy();
      }
    };
    newSession.oldWrite = newSession.write;
    newSession.write = function(data) {
      if (uid == window.leaderUid) {
        const length = data.length;
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32LE(length, 0);
        const b64Length = buf.toString('base64');
        const packet = INSERT_DEBUG_KEYS + b64Length + data;
        newSession.oldWrite(packet);
      } else {
        newSession.oldWrite(data);
      }
    };
    return newSession;
  }
};

exports.onWindow = function(window_) {
  console.log('GOT WINDOW: ' + window_);
  window = window_;
  if (window.htmMode) {
    // Already managed by a plugin
    console.log('A plugin is already managing this window');
    return;
  }

  window.htmMode = true;
  window.waitingForInit = false;
  window.leaderUid = null;
  window.initializedSessions = new Set();
  window.serverDefinedSessions = new Set();

  // This bimap is needed to avoid recycling uuids in hyper since hyper doesn't clean up window.sessions.
  // Note that only follower window.sessions are mapped.  The leader retains it's uuid.
  window.htmHyperUidMap = new Map();
  window.hyperHtmUidMap = new Map();
  window.htmBuffer = '';
};
