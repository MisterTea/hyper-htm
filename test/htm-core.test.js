const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  INSERT_KEYS,
  INIT_STATE,
  SESSION_END,
  HTM_INIT,
  encodeLength,
  decodeLength,
  longestInitPrefix,
  parseHtmPackets,
  consumeInitPayload,
} = require("../htm-core");

describe("encodeLength / decodeLength", () => {
  it("round-trips common payload sizes", () => {
    for (const n of [0, 1, 36, 72, 73, 128, 1024]) {
      assert.equal(decodeLength(encodeLength(n)), n);
    }
  });

  it("preserves negative int32 values used as invalid lengths", () => {
    assert.equal(decodeLength(encodeLength(-1)), -1);
  });
});

describe("longestInitPrefix", () => {
  it("returns 0 when there is no prefix", () => {
    assert.equal(longestInitPrefix("hello"), 0);
    assert.equal(longestInitPrefix(""), 0);
  });

  it("holds a split ESC[###q prefix", () => {
    assert.equal(longestInitPrefix("\u001b"), 1);
    assert.equal(longestInitPrefix("\u001b["), 2);
    assert.equal(longestInitPrefix("\u001b[##"), 4);
    assert.equal(longestInitPrefix("\u001b[###"), 5);
  });

  it("does not treat a full match as a hold-back prefix", () => {
    assert.equal(longestInitPrefix(HTM_INIT), 0);
  });
});

describe("consumeInitPayload", () => {
  it("matches when the sequence arrives in one chunk", () => {
    const result = consumeInitPayload("", "pre" + HTM_INIT + "rest");
    assert.equal(result.matched, true);
    assert.equal(result.prefix, "pre");
    assert.equal(result.remainder, "rest");
    assert.equal(result.pending, "");
  });

  it("holds a trailing partial sequence across chunks", () => {
    const first = consumeInitPayload("", "abc\u001b[");
    assert.equal(first.matched, false);
    assert.equal(first.prefix, "abc");
    assert.equal(first.pending, "\u001b[");

    const second = consumeInitPayload(first.pending, "###qINIT");
    assert.equal(second.matched, true);
    assert.equal(second.prefix, "");
    assert.equal(second.remainder, "INIT");
  });

  it("passes through data with no init sequence", () => {
    const result = consumeInitPayload("", "plain output");
    assert.equal(result.matched, false);
    assert.equal(result.prefix, "plain output");
    assert.equal(result.pending, "");
  });
});

describe("parseHtmPackets", () => {
  it("parses a complete INIT_STATE packet", () => {
    const payload = "{\"panes\":{}}";
    const buffer = INIT_STATE + encodeLength(payload.length) + payload;
    const parsed = parseHtmPackets(buffer);
    assert.equal(parsed.packets.length, 1);
    assert.equal(parsed.packets[0].header, INIT_STATE);
    assert.equal(parsed.packets[0].payload, payload);
    assert.equal(parsed.rest, "");
  });

  it("recognizes a 1-byte SESSION_END without waiting for a length", () => {
    const parsed = parseHtmPackets(SESSION_END);
    assert.equal(parsed.packets.length, 1);
    assert.equal(parsed.packets[0].header, SESSION_END);
    assert.equal(parsed.packets[0].payload, "");
    assert.equal(parsed.rest, "");
  });

  it("holds a partial packet until the payload arrives", () => {
    const payload = "abc";
    const full = INSERT_KEYS + encodeLength(payload.length) + payload;
    const parsed = parseHtmPackets(full.slice(0, 5));
    assert.equal(parsed.packets.length, 0);
    assert.equal(parsed.rest, full.slice(0, 5));

    const complete = parseHtmPackets(full);
    assert.equal(complete.packets.length, 1);
    assert.equal(complete.packets[0].payload, payload);
  });

  it("surfaces an invalid negative length", () => {
    const parsed = parseHtmPackets(INSERT_KEYS + encodeLength(-3));
    assert.equal(parsed.packets.length, 1);
    assert.equal(parsed.packets[0].error, "invalid length");
  });

  it("stops after SESSION_END even if more bytes follow", () => {
    const parsed = parseHtmPackets(SESSION_END + INSERT_KEYS + "junk");
    assert.equal(parsed.packets.length, 1);
    assert.equal(parsed.packets[0].header, SESSION_END);
    assert.ok(parsed.rest.startsWith(INSERT_KEYS));
  });
});
