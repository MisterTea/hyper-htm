const { EventEmitter } = require("events");

const INSERT_KEYS = "1";
const CLIENT_CLOSE_PANE = "3";
const RESIZE_PANE = "A";

module.exports = class HtmSession extends EventEmitter {
  constructor(htmPlugin, htmId, shell) {
    super();
    this.htmPlugin = htmPlugin;
    this.htmId = htmId;
    this.shell = shell;
  }

  init() {}

  exit() {
    this.destroy();
  }

  recieveData(data) {
    this.emit("data", data);
  }

  write(data) {
    if (!this.htmPlugin.initializedSessions.has(this.htmId)) {
      if (this.htmPlugin.leaderUid == null) {
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
    const leader = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (leader && leader.pty) {
      leader.pty.write(packet);
    }
  }

  resize({ cols, rows }) {
    if (!this.htmPlugin.initializedSessions.has(this.htmId)) {
      if (this.htmPlugin.leaderUid == null) {
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
    const leader = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (leader && leader.pty) {
      leader.pty.write(packet);
    }
  }

  destroy() {
    console.log("Closing follower");
    const length = this.htmId.length;
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32LE(length, 0);
    const b64Length = buf.toString("base64");
    const packet = CLIENT_CLOSE_PANE + b64Length + this.htmId;
    const leaderSession = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (leaderSession && leaderSession.pty) {
      leaderSession.pty.write(packet);
    }
    this.emit("exit");
    this.ended = true;
  }
};
