const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  HTM_DCS,
  HTM_ST,
  longestInitPrefix,
  consumeInitPayload,
  unescapeOctal,
  parseLayout,
  collectPaneIds,
  firstPaneId,
  parseControlStream,
  parseReplyGuard,
  classifyGatewayKey,
  cmdRefreshClient,
  cmdSplitWindow,
  cmdNewWindow,
  cmdKillPane,
  cmdDetach,
  cmdKillServer,
  GATEWAY_MENU,
  cmdSendKeys,
  filterKeyboardInput,
  createScreenTitleFilter,
} = require("../htm-core");

describe("longestInitPrefix", () => {
  it("returns 0 when there is no prefix", () => {
    assert.equal(longestInitPrefix("hello"), 0);
    assert.equal(longestInitPrefix(""), 0);
  });

  it("holds a split ESC P 1000 p prefix", () => {
    assert.equal(longestInitPrefix("\u001b"), 1);
    assert.equal(longestInitPrefix("\u001bP"), 2);
    assert.equal(longestInitPrefix("\u001bP1000"), 6);
  });

  it("does not treat a full match as a hold-back prefix", () => {
    assert.equal(longestInitPrefix(HTM_DCS), 0);
  });
});

describe("consumeInitPayload", () => {
  it("matches when the DCS arrives in one chunk", () => {
    const result = consumeInitPayload("", "pre" + HTM_DCS + "%begin");
    assert.equal(result.matched, true);
    assert.equal(result.prefix, "pre");
    assert.equal(result.remainder, "%begin");
    assert.equal(result.pending, "");
  });

  it("holds a trailing partial sequence across chunks", () => {
    const first = consumeInitPayload("", "abc\u001bP");
    assert.equal(first.matched, false);
    assert.equal(first.prefix, "abc");
    assert.equal(first.pending, "\u001bP");

    const second = consumeInitPayload(first.pending, "1000p%session-changed $1");
    assert.equal(second.matched, true);
    assert.equal(second.prefix, "");
    assert.equal(second.remainder, "%session-changed $1");
  });

  it("passes through data with no DCS", () => {
    const result = consumeInitPayload("", "plain output");
    assert.equal(result.matched, false);
    assert.equal(result.prefix, "plain output");
    assert.equal(result.pending, "");
  });
});

describe("unescapeOctal", () => {
  it("decodes tmux %output escapes", () => {
    assert.equal(unescapeOctal("ab"), "ab");
    assert.equal(unescapeOctal("a\\012b"), "a\nb");
    assert.equal(unescapeOctal("\\033[0m"), "\u001b[0m");
    assert.equal(unescapeOctal("\\134"), "\\");
  });
});

describe("parseLayout", () => {
  it("parses a single pane with checksum", () => {
    const tree = parseLayout("abcd,80x24,0,0,0");
    assert.equal(tree.type, "pane");
    assert.equal(tree.id, 0);
    assert.equal(tree.cols, 80);
    assert.equal(tree.rows, 24);
    assert.deepEqual(collectPaneIds(tree), [0]);
  });

  it("parses a side-by-side split", () => {
    const tree = parseLayout("80x24,0,0{40x24,0,0,0,39x24,41,0,1}");
    assert.equal(tree.type, "sidebyside");
    assert.deepEqual(collectPaneIds(tree), [0, 1]);
    assert.equal(firstPaneId(tree), 0);
    assert.equal(tree.children[1].id, 1);
  });

  it("parses a stacked split", () => {
    const tree = parseLayout("ffff,80x24,0,0[12x24,0,0,2,11x24,0,13,3]");
    assert.equal(tree.type, "stacked");
    assert.deepEqual(collectPaneIds(tree), [2, 3]);
  });

  it("parses nested splits", () => {
    const tree = parseLayout(
      "80x24,0,0{40x24,0,0[20x12,0,0,0,20x11,0,13,1],39x24,41,0,2}"
    );
    assert.equal(tree.type, "sidebyside");
    assert.deepEqual(collectPaneIds(tree), [0, 1, 2]);
    assert.equal(tree.children[0].type, "stacked");
  });
});

describe("parseControlStream", () => {
  it("parses %output with octal data", () => {
    const parsed = parseControlStream("%output %0 hello\\012world\n");
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].type, "output");
    assert.equal(parsed.events[0].paneId, 0);
    assert.equal(parsed.events[0].data, "hello\nworld");
    assert.equal(parsed.rest, "");
  });

  it("parses layout-change and holds a partial line", () => {
    const first = parseControlStream("%layout-change @0 abcd,80x24,0,0,0 abcd");
    assert.equal(first.events.length, 0);
    assert.ok(first.rest.startsWith("%layout-change"));

    const full = parseControlStream(first.rest + ",80x24,0,0,0\n");
    assert.equal(full.events.length, 1);
    assert.equal(full.events[0].type, "layout-change");
    assert.equal(full.events[0].windowId, 0);
    assert.equal(full.events[0].layout, "abcd,80x24,0,0,0");
  });

  it("treats ST as session end", () => {
    const parsed = parseControlStream("%output %0 x\n" + HTM_ST + "junk");
    assert.equal(parsed.events[0].type, "output");
    assert.equal(parsed.events[1].type, "exit");
    assert.equal(parsed.rest, "junk");
  });

  it("parses %exit and %window-close", () => {
    const parsed = parseControlStream("%window-close @1\n%exit\n");
    assert.equal(parsed.events[0].type, "window-close");
    assert.equal(parsed.events[0].windowId, 1);
    assert.equal(parsed.events[1].type, "exit");
  });

  it("parses %begin/%end flags for client vs server replies", () => {
    const parsed = parseControlStream(
      "%begin 1 1 0\n%end 1 1 0\n%begin 2 2 1\n@0 80x24\n%end 2 2 1\n"
    );
    assert.equal(parsed.events[0].type, "reply");
    assert.equal(parsed.events[0].kind, "begin");
    assert.equal(parsed.events[0].clientOriginated, false);
    assert.equal(parsed.events[1].kind, "end");
    assert.equal(parsed.events[2].clientOriginated, true);
    assert.equal(parsed.events[3].type, "other");
    assert.equal(parsed.events[3].line, "@0 80x24");
    assert.equal(parsed.events[4].kind, "end");
  });
});

describe("parseReplyGuard", () => {
  it("treats flags bit 0 as client-originated", () => {
    const server = parseReplyGuard("%begin 1710000000 1 0");
    assert.equal(server.kind, "begin");
    assert.equal(server.clientOriginated, false);
    const client = parseReplyGuard("%end 1710000000 2 1");
    assert.equal(client.kind, "end");
    assert.equal(client.clientOriginated, true);
    const error = parseReplyGuard("%error 1 3 1");
    assert.equal(error.kind, "error");
    assert.equal(error.clientOriginated, true);
    const omitted = parseReplyGuard("%begin 1 1");
    assert.equal(omitted.clientOriginated, true);
  });
});

describe("classifyGatewayKey", () => {
  it("accepts Hyper's lowercase keys and iTerm2's uppercase keys", () => {
    assert.equal(classifyGatewayKey("\u001b"), "detach");
    assert.equal(classifyGatewayKey("x"), "force-quit");
    assert.equal(classifyGatewayKey("X"), "force-quit");
    assert.equal(classifyGatewayKey("l"), "toggle-log");
    assert.equal(classifyGatewayKey("L"), "toggle-log");
    assert.equal(classifyGatewayKey("c"), "start-command");
    assert.equal(classifyGatewayKey("C"), "start-command");
    assert.equal(classifyGatewayKey("\u001b[A"), "ignore");
    assert.equal(classifyGatewayKey("a"), "ignore");
  });
});

describe("command builders", () => {
  it("builds split, tab, resize, kill, and send-keys commands", () => {
    assert.equal(cmdSplitWindow(0, true), "split-window -h -t %0");
    assert.equal(cmdSplitWindow(1, false), "split-window -v -t %1");
    assert.equal(cmdSplitWindow(null, true), "split-window -h");
    assert.equal(cmdSplitWindow(undefined, false), "split-window -v");
    assert.equal(cmdNewWindow(), "new-window");
    assert.equal(cmdRefreshClient(80, 24), "refresh-client -C 80x24");
    assert.equal(cmdKillPane(2), "kill-pane -t %2");
    assert.equal(cmdDetach(), "detach");
    assert.equal(cmdKillServer(), "kill-server");
    assert.equal(cmdSendKeys(0, "ab"), "send -t %0 -H 61 62");
    assert.equal(cmdSendKeys(0, ""), null);
  });
});

describe("filterKeyboardInput", () => {
  it("drops focus and DA replies but keeps arrows and text", () => {
    assert.equal(filterKeyboardInput("\u001b[I"), "");
    assert.equal(filterKeyboardInput("\u001b[O"), "");
    assert.equal(filterKeyboardInput("\u001b[?1;2c"), "");
    assert.equal(filterKeyboardInput("\u001b[1;1R"), "");
    assert.equal(filterKeyboardInput("\u001b[A"), "\u001b[A");
    assert.equal(filterKeyboardInput("hi\u001b[Ithere"), "hithere");
    assert.equal(filterKeyboardInput("echo ok\r"), "echo ok\r");
  });
});

describe("GATEWAY_MENU", () => {
  it("matches iTerm2's tmux -CC command menu", () => {
    assert.equal(
      GATEWAY_MENU,
      [
        "** tmux mode started **",
        "",
        "Command Menu",
        "----------------------------",
        "esc    Detach cleanly.",
        "  X    Force-quit tmux mode.",
        "  L    Toggle logging.",
        "  C    Run tmux command.",
        "",
      ].join("\r\n")
    );
  });
});

describe("createScreenTitleFilter", () => {
  it("rewrites ESC k TITLE ST to OSC 2", () => {
    const filter = createScreenTitleFilter();
    const out = filter("pwd\r\n\u001bkpwd\u001b\\/tmp\r\n");
    assert.equal(out.includes("\u001bk"), false);
    assert.equal(out.includes("\u001b]2;pwd\u0007"), true);
    assert.equal(out.includes("pwd\r\n"), true);
    assert.equal(out.includes("/tmp"), true);
  });

  it("rewrites BEL-terminated titles and spans chunks", () => {
    const filter = createScreenTitleFilter();
    let out = filter("pwd\r\n\u001bk");
    out += filter("pwd");
    out += filter("\u0007/tmp\r\n");
    assert.equal(out.includes("\u001bk"), false);
    assert.equal(out.includes("\u001b]2;pwd\u0007"), true);
    assert.equal(out.includes("/tmp"), true);
  });

  it("passes through unrelated escape sequences", () => {
    const filter = createScreenTitleFilter();
    assert.equal(filter("\u001b[31mred\u001b[0m"), "\u001b[31mred\u001b[0m");
  });
});
