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

const UUID_LENGTH = 36;

exports.onWindow = function(window) {
  console.log('GOT WINDOW: ' + window);
  if (typeof window.oldInitSession !== 'undefined') {
    // Already managed by a plugin
    console.log('A plugin is already managing this window');
    return;
  }

  let waitingForInit = false;
  const sessions = window.sessions;
  const htmRegexp = new RegExp(/\u001b\u005b###q/);
  window.leaderUid = null;
  window.initializedSessions = new Set();

  window.getFirstSessionId = (htmState, paneOrSplit) => {
    if (htmState.panes[paneOrSplit]) {
      return paneOrSplit;
    } else {
      return window.getFirstSessionId(htmState, htmState.splits[paneOrSplit].panesOrSplits[0]);
    }
  };

  window.createSessionForSplit = function(htmState, panesOrSplits, vertical, i, callback) {
    if (i >= panesOrSplits.length) {
      setTimeout(() => {
        callback();
      }, 100);
      return;
    }

    const sourceId = window.getFirstSessionId(htmState, panesOrSplits[i - 1]);
    const newId = window.getFirstSessionId(htmState, panesOrSplits[i]);

    if (vertical) {
      window.rpc.emit('split request vertical', {sourceUid: sourceId, sessionUid: newId, follower: true});
    } else {
      window.rpc.emit('split request horizontal', {sourceUid: sourceId, sessionUid: newId, follower: true});
    }
    window.initializedSessions.add(newId);

    setTimeout(() => {
      window.createSessionForSplit(htmState, panesOrSplits, vertical, i + 1, callback);
    }, 100);
  };

  window.createSplit = function(htmState, split) {
    const panesOrSplits = split.panesOrSplits;
    // Create the top-level panes (except the first one, which already exists)
    window.createSessionForSplit(htmState, panesOrSplits, split.vertical, 1, () => {
      // Go through the list looking for splits and handling accordingly.
      for (var a = 0; a < panesOrSplits.length; a++) {
        const innerSplit = htmState.splits[panesOrSplits[a]];
        if (innerSplit) {
          // We found a split, recurse
          window.createSplit(htmState, innerSplit);
        }
      }
    });
  };

  window.createTab = function(htmState, currentTab) {
    // When we create a tab (a term group in hyperjs terms), we must also create a session.
    // We pick the first session and create it with the tab
    const firstSessionId = window.getFirstSessionId(htmState, currentTab.paneOrSplit);
    window.rpc.emit('termgroup add req', {termGroupUid: currentTab.id, sessionUid: firstSessionId, follower: true});
    window.initializedSessions.add(firstSessionId);
    if (htmState.splits && htmState.splits[currentTab.paneOrSplit]) {
      setTimeout(() => {
        window.createSplit(htmState, htmState.splits[currentTab.paneOrSplit]);
      }, 100);
    }
  };

  window.initHtm = function(htmState) {
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
        window.createTab(htmState, tab);
      }
    }
  };

  window.oldInitSession = window.initSession;
  window.initSession = (opts, fn_) => {
    if (window.leaderUid) {
      const htmSession = sessions.get(window.leaderUid);
      if (opts.sessionUid) {
        // This is part of htm initialization
      } else if (opts.splitDirection) {
        // We are splitting an existing tab
        console.log('Creating new split for htm');
        opts.sessionUid = uuid.v4();
        const splitFromUid = opts.activeUid;
        const newSessionUid = opts.sessionUid;
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
        opts.sessionUid = uuid.v4();
        opts.termGroupUid = uuid.v4();
        console.log('CREATING NEW TAB FOR HTM: ' + opts.termGroupUid + ' ' + opts.sessionUid);
        const length = opts.termGroupUid.length + opts.sessionUid.length;
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32LE(length, 0);
        const b64Length = buf.toString('base64');
        const packet = NEW_TAB + b64Length + opts.termGroupUid + opts.sessionUid;
        htmSession.pty.write(packet);
        window.initializedSessions.add(opts.sessionUid);
      }
      let sessionUid = null;
      if (opts.sessionUid) {
        // The session Uid is provided.
        sessionUid = opts.sessionUid;
      } else {
        sessionUid = uuid.v4();
      }
      fn_(sessionUid, new FollowerSession(window, sessionUid, sessions.get(window.leaderUid).shell));
    } else {
      window.oldInitSession(opts, fn_);
    }
  };

  window.processHtmData = function() {
    console.log(new Date().toLocaleTimeString() + ' Buffer length: ' + window.htmBuffer.length);
    while (window.htmBuffer.length >= 9) {
      if (waitingForInit) {
        setTimeout(window.processHtmData, 100);
        return;
      }
      const packetHeader = window.htmBuffer[0];
      console.log(new Date().toLocaleTimeString() + 'GOT PACKET WITH HEADER: ' + packetHeader);
      let length = Buffer.from(window.htmBuffer.substring(1, 9), 'base64').readInt32LE(0);
      console.log(new Date().toLocaleTimeString() + 'length needed: ' + length);
      if (window.htmBuffer.length - 9 < length) {
        // Not enough data
        break;
      }
      switch (packetHeader) {
        case INIT_STATE: {
          const rawJsonData = window.htmBuffer.substring(9, 9 + length);
          window.htmBuffer = window.htmBuffer.slice(9 + length);
          const htmState = JSON.parse(rawJsonData);
          window.htmShell = htmState.shell;
          console.log('INITIALIZING HTM');
          waitingForInit = true;
          window.initHtm(htmState);
          // TODO: Replace this with somethign that waits until the init is done
          setTimeout(() => {
            waitingForInit = false;
          }, 1000);
          break;
        }
        case APPEND_TO_PANE: {
          const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
          let paneData = window.htmBuffer.substring(9 + UUID_LENGTH, 9 + length);
          paneData = Buffer.from(paneData, 'base64').toString('utf8');
          window.htmBuffer = window.htmBuffer.slice(9 + length);
          window.rpc.emit('session data', {uid: sessionId, data: paneData});
          break;
        }
        case SERVER_CLOSE_PANE: {
          const sessionId = window.htmBuffer.substring(9, 9 + UUID_LENGTH);
          window.htmBuffer = window.htmBuffer.slice(9 + length);
          console.log('CLOSING SESSION ' + sessionId);
          window.rpc.emit('session exit', {sessionId});
          const sessionToClose = sessions.get(sessionId);
          if (sessionToClose) {
            sessionToClose.exit();
            sessions.delete(sessionId);
          }
          break;
        }
        default: {
          // Ignore
          console.error('Ignoring packet with header: ' + packetHeader);
          window.htmBuffer = window.htmBuffer.slice(9 + length);
          break;
        }
      }
    }
  };

  console.log(window.handleSessionData);
  window.handleSessionData = (uid, data, handleSessionCallback) => {
    console.log('IN CUSTOM SESSION DATA HANDLER');
    if (window.leaderUid) {
      window.htmBuffer += data;
      window.processHtmData();
    } else {
      if (htmRegexp.test(data)) {
        console.log('Enabling HTM mode');
        window.leaderUid = uid;
        window.htmBuffer = data.substring(data.search(htmRegexp) + 6);
        window.processHtmData();
      } else {
        handleSessionCallback(uid, data);
      }
    }
  };
  console.log(window.handleSessionData);

  window.followerWrite = (uid, data) => {
    if (!window.initializedSessions.has(uid)) {
      console.log('Waiting to write to ' + uid);
      setTimeout(() => {
        window.followerWrite(uid, data);
      }, 100);
      return;
    }
    const length = uid.length + data.length;
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32LE(length, 0);
    const b64Length = buf.toString('base64');
    const packet = INSERT_KEYS + b64Length + uid + data;
    sessions.get(window.leaderUid).pty.write(packet);
  };

  window.followerResize = (uid, cols, rows) => {
    if (!window.initializedSessions.has(uid)) {
      console.log('Waiting to resize ' + uid);
      setTimeout(() => {
        window.followerResize(uid, cols, rows);
      }, 100);
      return;
    }
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32LE(cols, 0);
    const b64Cols = buf.toString('base64');
    buf.writeInt32LE(rows, 0);
    const b64Rows = buf.toString('base64');
    const length = b64Cols.length + b64Rows.length + uid.length;
    buf.writeInt32LE(length, 0);
    const b64Length = buf.toString('base64');
    const packet = RESIZE_PANE + b64Length + b64Cols + b64Rows + uid;
    sessions.get(window.leaderUid).pty.write(packet);
  };

  window.oldDeleteSession = window.deleteSession;
  window.deleteSession = uid => {
    const session = sessions.get(uid);
    if (session) {
      if (window.leaderUid) {
        if (window.leaderUid === uid) {
          console.log("Closing leader");
          // Closing the leader causes the entire window to collapse
          window.close();
        } else {
          console.log("Closing follower");
          const length = uid.length;
          const buf = Buffer.allocUnsafe(4);
          buf.writeInt32LE(length, 0);
          const b64Length = buf.toString('base64');
          const packet = CLIENT_CLOSE_PANE + b64Length + uid;
          sessions.get(window.leaderUid).pty.write(packet);
        }
      }
    } else {
      //eslint-disable-next-line no-console
      console.log('session not found by', uid);
    }
    window.oldDeleteSession(uid);
  };

  window.oldSessionInput = window.handleSessionInput;
  window.handleSessionInput = (uid, data, escaped) => {
    if (uid == window.leaderUid) {
      // For now, ignore input to the htm session
      return;
    }
    window.oldSessionInput(uid, data, escaped);
  }
};
