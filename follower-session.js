const {EventEmitter} = require('events');

module.exports = class HtmSession extends EventEmitter {
  constructor(window, htmId, shell) {
    super();
    this.window = window;
    this.htmId = htmId;
    this.shell = shell;
  }

  exit() {
    this.destroy();
  }

  recieveData(data) {
    this.emit('data', data);
  }

  write(data) {
    this.window.followerWrite(this.htmId, data);
  }

  resize({cols, rows}) {
    this.window.followerResize(this.htmId, cols, rows);
  }

  destroy() {
    this.emit('exit');
    this.ended = true;
  }
};
