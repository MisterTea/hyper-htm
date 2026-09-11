const HTM_DCS = "\u001bP1000p";
const HTM_ST = "\u001b\\";

const longestInitPrefix = (data, pattern) => {
  const needle = pattern || HTM_DCS;
  const max = Math.min(data.length, needle.length - 1);
  for (let n = max; n > 0; n--) {
    if (needle.startsWith(data.slice(-n))) {
      return n;
    }
  }
  return 0;
};

/**
 * Detect the tmux -CC DCS (ESC P 1000 p) in a possibly chunked payload.
 * Holds back a partial prefix so split PTY reads still match.
 */
const consumeInitPayload = (pending, payload) => {
  const data = (pending || "") + payload;
  const initAt = data.indexOf(HTM_DCS);
  if (initAt !== -1) {
    return {
      matched: true,
      prefix: data.slice(0, initAt),
      remainder: data.slice(initAt + HTM_DCS.length),
      pending: "",
    };
  }
  const hold = longestInitPrefix(data, HTM_DCS);
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

const unescapeOctal = (text) => {
  if (!text) {
    return "";
  }
  return text.replace(/\\([0-7]{3})/g, (_, oct) =>
    String.fromCharCode(parseInt(oct, 8))
  );
};

const stripLayoutChecksum = (layout) => {
  if (/^[0-9a-fA-F]{4},\d+x\d+/.test(layout)) {
    return layout.slice(5);
  }
  return layout;
};

const parseLayoutNode = (s, i) => {
  const size = /^(\d+)x(\d+),(\d+),(\d+)/.exec(s.slice(i));
  if (!size) {
    throw new Error(`invalid tmux layout at ${i}: ${s.slice(i, i + 32)}`);
  }
  i += size[0].length;
  const node = {
    cols: Number(size[1]),
    rows: Number(size[2]),
    x: Number(size[3]),
    y: Number(size[4]),
  };
  if (s[i] === "{" || s[i] === "[") {
    const stacked = s[i] === "[";
    const close = stacked ? "]" : "}";
    i += 1;
    node.type = stacked ? "stacked" : "sidebyside";
    node.children = [];
    while (i < s.length && s[i] !== close) {
      if (s[i] === ",") {
        i += 1;
      }
      const child = parseLayoutNode(s, i);
      node.children.push(child.node);
      i = child.i;
    }
    if (s[i] === close) {
      i += 1;
    }
    return { node, i };
  }
  if (s[i] === ",") {
    i += 1;
    const idm = /^\d+/.exec(s.slice(i));
    node.type = "pane";
    node.id = idm ? Number(idm[0]) : 0;
    i += idm ? idm[0].length : 0;
    return { node, i };
  }
  node.type = "empty";
  return { node, i };
};

/** Parse a tmux layout string (with or without checksum) into a tree. */
const parseLayout = (layout) => {
  if (!layout) {
    return { type: "empty" };
  }
  const body = stripLayoutChecksum(layout);
  return parseLayoutNode(body, 0).node;
};

const collectPaneIds = (node, out) => {
  const ids = out || [];
  if (!node) {
    return ids;
  }
  if (node.type === "pane") {
    ids.push(node.id);
  } else if (node.children) {
    for (const child of node.children) {
      collectPaneIds(child, ids);
    }
  }
  return ids;
};

const firstPaneId = (node) => {
  const ids = collectPaneIds(node);
  return ids.length ? ids[0] : null;
};

const parseControlLine = (line) => {
  if (line === "%exit" || line.startsWith("%exit ")) {
    return { type: "exit", line };
  }
  if (line.startsWith("%output ")) {
    const match = /^%output %(\d+) ?(.*)$/.exec(line);
    if (!match) {
      return { type: "other", line };
    }
    return {
      type: "output",
      paneId: Number(match[1]),
      data: unescapeOctal(match[2] || ""),
      line,
    };
  }
  if (line.startsWith("%extended-output ")) {
    const match = /^%extended-output %(\d+) \d+ : (.*)$/.exec(line);
    if (!match) {
      return { type: "other", line };
    }
    return {
      type: "output",
      paneId: Number(match[1]),
      data: unescapeOctal(match[2] || ""),
      line,
    };
  }
  if (line.startsWith("%layout-change ")) {
    const parts = line.split(" ");
    const windowId = Number(String(parts[1] || "").replace(/^@/, ""));
    return {
      type: "layout-change",
      windowId,
      layout: parts[2] || "",
      line,
    };
  }
  if (line.startsWith("%window-add ")) {
    return {
      type: "window-add",
      windowId: Number(String(line.split(" ")[1] || "").replace(/^@/, "")),
      line,
    };
  }
  if (line.startsWith("%window-close ")) {
    return {
      type: "window-close",
      windowId: Number(String(line.split(" ")[1] || "").replace(/^@/, "")),
      line,
    };
  }
  if (line.startsWith("%session-changed ")) {
    return { type: "session-changed", line };
  }
  if (
    line.startsWith("%begin ") ||
    line.startsWith("%end ") ||
    line.startsWith("%error ")
  ) {
    const guard = parseReplyGuard(line);
    return guard ? { type: "reply", ...guard, line } : { type: "reply", line };
  }
  return { type: "other", line };
};

/** Parse `%begin|%end|%error <time> <number> [flags]`. flags bit 0 = client-originated. */
const parseReplyGuard = (line) => {
  const match = /^%(begin|end|error) (\d+) (\d+)(?: (\d+))?$/.exec(line || "");
  if (!match) {
    return null;
  }
  const flags = match[4] != null ? Number(match[4]) : 1;
  return {
    kind: match[1],
    time: Number(match[2]),
    number: Number(match[3]),
    flags,
    clientOriginated: !!(flags & 1),
  };
};

/**
 * Classify a gateway key chunk the way iTerm2's TMUX_GATEWAY handler does.
 * Escape sequences (arrows, etc.) are ignored; only a lone ESC detaches.
 * Hyper sends unmodified letter keys as lowercase, so accept either case.
 */
const classifyGatewayKey = (data) => {
  if (data == null || data === "") {
    return "ignore";
  }
  if (data.charCodeAt(0) === 0x1b) {
    return data.length === 1 ? "detach" : "ignore";
  }
  const key = data.toUpperCase();
  if (key === "X") {
    return "force-quit";
  }
  if (key === "L") {
    return "toggle-log";
  }
  if (key === "C") {
    return "start-command";
  }
  return "ignore";
};

/**
 * Split a control-mode byte stream into events. Incomplete trailing data
 * stays in ``rest``. A raw ST (ESC \) is treated as session end.
 */
const parseControlStream = (buffer) => {
  const events = [];
  let rest = buffer || "";
  while (rest.length) {
    const stAt = rest.indexOf(HTM_ST);
    const nl = rest.search(/\r?\n/);
    if (stAt !== -1 && (nl === -1 || stAt <= nl)) {
      const before = rest.slice(0, stAt);
      if (before.length) {
        const trimmed = before.replace(/\r?\n$/, "");
        if (trimmed) {
          for (const piece of trimmed.split(/\r?\n/)) {
            if (piece) {
              events.push(parseControlLine(piece));
            }
          }
        }
      }
      events.push({ type: "exit", line: "" });
      rest = rest.slice(stAt + HTM_ST.length);
      continue;
    }
    if (nl === -1) {
      break;
    }
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl).replace(/^\r?\n/, "");
    if (line) {
      events.push(parseControlLine(line));
    }
  }
  return { events, rest };
};

const cmdRefreshClient = (cols, rows) =>
  `refresh-client -C ${cols}x${rows}`;

const cmdSplitWindow = (sourcePaneId, sideBySide) => {
  const flag = sideBySide ? "-h" : "-v";
  if (sourcePaneId == null) {
    return `split-window ${flag}`;
  }
  return `split-window ${flag} -t %${sourcePaneId}`;
};

const cmdNewWindow = () => "new-window";

const cmdKillPane = (paneId) => `kill-pane -t %${paneId}`;

const cmdDetach = () => "detach";

const cmdKillServer = () => "kill-server";

/** iTerm2's tmux -CC gateway banner (PTYSession printTmuxMessage). */
const GATEWAY_MENU = [
  "** tmux mode started **",
  "",
  "Command Menu",
  "----------------------------",
  "esc Detach cleanly.",
  " X Force-quit tmux mode.",
  " L Toggle logging.",
  " C Run tmux command.",
].join("\r\n") + "\r\n";

const cmdSendKeys = (paneId, data) => {
  const buf = Buffer.from(data == null ? "" : data, "utf8");
  if (!buf.length) {
    return null;
  }
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `send -t %${paneId} -H ${hex}`;
};

/**
 * TERM=screen shells (zsh preexec) emit screen(1) titles: ESC k TITLE ST|BEL.
 * tmux -CC clients (iTerm2) consume those as title updates. xterm.js does not,
 * so the TITLE text would paint as a second command echo. Rewrite to OSC 2,
 * which Hyper/xterm.js understand. Stateful so titles may span %output chunks.
 */
const createScreenTitleFilter = () => {
  const Normal = 0;
  const Escape = 1;
  const Title = 2;
  const TitleEscape = 3;
  let state = Normal;
  let title = "";

  const emitOsc = (out) => {
    out.push("\u001b]2;" + title + "\u0007");
    title = "";
    state = Normal;
  };

  return (chunk) => {
    if (chunk == null || chunk === "") {
      return "";
    }
    const out = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      switch (state) {
        case Normal:
          if (c === "\u001b") {
            state = Escape;
          } else {
            out.push(c);
          }
          break;
        case Escape:
          if (c === "k") {
            state = Title;
            title = "";
          } else {
            out.push("\u001b");
            if (c === "\u001b") {
              state = Escape;
            } else {
              out.push(c);
              state = Normal;
            }
          }
          break;
        case Title:
          if (c === "\u001b") {
            state = TitleEscape;
          } else if (c === "\u0007") {
            emitOsc(out);
          } else {
            title += c;
          }
          break;
        case TitleEscape:
          if (c === "\\") {
            emitOsc(out);
          } else if (c !== "\u001b") {
            title += c;
            state = Title;
          }
          break;
        default:
          state = Normal;
          out.push(c);
          break;
      }
    }
    return out.join("");
  };
};

module.exports = {
  HTM_DCS,
  HTM_ST,
  longestInitPrefix,
  consumeInitPayload,
  unescapeOctal,
  parseLayout,
  collectPaneIds,
  firstPaneId,
  parseControlLine,
  parseReplyGuard,
  parseControlStream,
  classifyGatewayKey,
  cmdRefreshClient,
  cmdSplitWindow,
  cmdNewWindow,
  cmdKillPane,
  cmdDetach,
  cmdKillServer,
  GATEWAY_MENU,
  cmdSendKeys,
  createScreenTitleFilter,
};
