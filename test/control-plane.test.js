const { EventEmitter } = require("events");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const UID = "12345678-1234-1234-1234-123456789abc";
const DCS = "\u001bP1000p";

const startGateway = () => {
  delete require.cache[require.resolve("../index")];
  const plugin = require("../index");
  const writes = [];
  const baseWrites = [];
  const output = [];

  class FakeSession extends EventEmitter {
    constructor(options) {
      super();
      this.uid = options.uid;
      this.cols = 80;
      this.rows = 24;
      this.pty = { write: (data) => writes.push(data) };
    }

    init() {}

    write(data) {
      baseWrites.push(data);
    }

    destroy() {}
  }

  const host = {
    sessions: new Map(),
    rpc: {
      emit(event, data) {
        if (event === "session data") {
          output.push(data.slice(UID.length));
        }
      },
    },
  };

  plugin.onWindow(host);
  const GatewaySession = plugin.decorateSessionClass(FakeSession);
  const session = new GatewaySession({ uid: UID });
  host.sessions.set(UID, session);
  session.init({ uid: UID });
  session.consumeHtm(DCS);

  return {
    session,
    writes,
    baseWrites,
    text: () => output.join(""),
  };
};

describe("Hyper control plane", () => {
  it("toggles logging and runs a tmux command with lowercase keys", () => {
    const gateway = startGateway();
    assert.match(gateway.text(), /^\*\* tmux mode started \*\*\r\n/);
    assert.equal(gateway.writes[0], "refresh-client -C 80x24\n");

    // Complete the startup refresh reply before issuing an interactive command.
    gateway.session.consumeHtm("%begin 1 1 1\n%end 1 1 1\n");

    gateway.session.write("l");
    assert.match(gateway.text(), /tmux logging enabled\r\n/);

    gateway.session.write("c");
    gateway.session.write("list-windows\r");
    assert.equal(gateway.writes.at(-1), "list-windows\n");
    assert.match(gateway.text(), /Enter command to send tmux:\r\n/);
    assert.match(gateway.text(), /Run command "list-windows"\r\n/);

    gateway.session.consumeHtm(
      "%begin 2 2 1\n@0 80x24 layout\n%end 2 2 1\n"
    );
    assert.match(gateway.text(), /> list-windows\r\n/);
    assert.match(gateway.text(), /< %begin 2 2 1\r\n/);
    assert.match(gateway.text(), /@0 80x24 layout\r\n/);

    gateway.session.write("l");
    assert.match(gateway.text(), /tmux logging disabled\r\n/);
  });

  it("detaches cleanly with Escape", () => {
    const gateway = startGateway();
    gateway.session.write("\u001b");

    assert.equal(gateway.writes.at(-1), "detach\n");
    assert.match(gateway.text(), /Detaching\.\.\.\r\n/);

    gateway.session.consumeHtm("%exit\n");
    assert.match(gateway.text(), /Detached\r\n/);
  });

  it("force-quits tmux mode with lowercase x", () => {
    const gateway = startGateway();
    gateway.session.write("x");

    assert.match(
      gateway.text(),
      /Exiting tmux mode, but tmux client may still be running\.\r\n/
    );
    assert.notEqual(gateway.writes.at(-1), "detach\n");

    gateway.session.write("ordinary shell input");
    assert.deepEqual(gateway.baseWrites, ["ordinary shell input"]);
  });
});
