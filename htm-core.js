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
const HTM_INIT = "\u001b[###q";
const HTM_EXIT = "\u001b[$$$q";

const encodeLength = (length) => {
  const buf = Buffer.allocUnsafe(4);
  buf.writeInt32LE(length, 0);
  return buf.toString("base64");
};

const decodeLength = (b64) => {
  return Buffer.from(b64, "base64").readInt32LE(0);
};

const longestInitPrefix = (data, pattern) => {
  const needle = pattern || HTM_INIT;
  const max = Math.min(data.length, needle.length - 1);
  for (let n = max; n > 0; n--) {
    if (needle.startsWith(data.slice(-n))) {
      return n;
    }
  }
  return 0;
};

/**
 * Parse complete HTM packets from a string buffer.
 * SESSION_END is a 1-byte packet and must be recognized without waiting
 * for the 8-byte length field used by every other message.
 */
const parseHtmPackets = (buffer) => {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    const header = buffer[offset];
    if (header === SESSION_END) {
      packets.push({ header, payload: "" });
      offset += 1;
      break;
    }
    if (buffer.length - offset < 9) {
      break;
    }
    const length = decodeLength(buffer.substring(offset + 1, offset + 9));
    if (length < 0) {
      packets.push({ header, error: "invalid length", length });
      break;
    }
    if (buffer.length - offset - 9 < length) {
      break;
    }
    packets.push({
      header,
      payload: buffer.substring(offset + 9, offset + 9 + length),
    });
    offset += 9 + length;
  }
  return { packets, rest: buffer.slice(offset) };
};

/**
 * Detect HTM init/exit in a (possibly chunked) payload.
 * Holds back a partial init prefix so split PTY reads still match.
 */
const consumeInitPayload = (pending, payload) => {
  const data = (pending || "") + payload;
  const initAt = data.indexOf(HTM_INIT);
  if (initAt !== -1) {
    return {
      matched: true,
      prefix: data.slice(0, initAt),
      remainder: data.slice(initAt + HTM_INIT.length),
      pending: "",
    };
  }
  const hold = longestInitPrefix(data, HTM_INIT);
  if (hold > 0) {
    return {
      matched: false,
      prefix: data.slice(0, data.length - hold),
      remainder: "",
      pending: data.slice(-hold),
    };
  }
  return { matched: false, prefix: data, remainder: "", pending: "" };
};

module.exports = {
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
  HTM_INIT,
  HTM_EXIT,
  encodeLength,
  decodeLength,
  longestInitPrefix,
  parseHtmPackets,
  consumeInitPayload,
};
