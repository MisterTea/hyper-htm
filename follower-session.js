const { EventEmitter } = require("events");
const {
  cmdSendKeys,
  cmdKillPane,
  cmdRefreshClient,
  filterKeyboardInput,
} = require("./htm-core");

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
    const keys = filterKeyboardInput(data);
    const command = cmdSendKeys(this.htmId, keys);
    const leader = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (command && leader && leader.pty) {
      leader.pty.write(command.endsWith("\n") ? command : `${command}\n`);
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
    const command = cmdRefreshClient(cols, rows);
    const leader = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (leader && leader.pty) {
      leader.pty.write(command + "\n");
    }
  }

  destroy() {
    console.log("Closing follower");
    const command = cmdKillPane(this.htmId);
    const leaderSession = this.htmPlugin.sessions.get(this.htmPlugin.leaderUid);
    if (leaderSession && leaderSession.pty) {
      leaderSession.pty.write(command + "\n");
    }
    this.emit("exit");
    this.ended = true;
  }
};
