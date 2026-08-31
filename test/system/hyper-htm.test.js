const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const HYPER_APP = "/Applications/Hyper.app";
const HTM_BIN = "/Users/jjg/github/EternalTerminal/build/htm";
const SKIP_REASON = (() => {
  if (process.platform !== "darwin") {
    return "Hyper system tests require macOS";
  }
  if (!fs.existsSync(HYPER_APP)) {
    return "Hyper.app is not installed";
  }
  if (!fs.existsSync(HTM_BIN)) {
    return "htm binary is not built";
  }
  return null;
})();

const TMP = "/tmp";
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const asQuote = (s) => `"${String(s).replace(/"/g, '""')}"`;

const osascript = (script) => {
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 20000,
    });
  } catch (err) {
    const output = `${err.stderr || ""} ${err.stdout || ""} ${err.message || ""}`;
    if (
      output.includes("not allowed assistive access") ||
      output.includes("osascript is not allowed") ||
      output.includes("-1719") ||
      output.includes("-1743")
    ) {
      const skip = new Error(
        "Hyper system tests need Accessibility permission for osascript"
      );
      skip.code = "ERR_TEST_SKIP";
      throw skip;
    }
    throw err;
  }
};

const hyperWasRunning = () => {
  try {
    execSync("pgrep -x Hyper >/dev/null 2>&1");
    return true;
  } catch {
    return false;
  }
};

const waitForHyperWindow = async (timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = osascript(
        'tell application "System Events" to tell process "Hyper" to get count of windows'
      );
      if (parseInt(out, 10) > 0) {
        return;
      }
    } catch {
      // Process may not be up yet.
    }
    await sleep(200);
  }
  throw new Error("Hyper did not open a window");
};

const listHtmdLogs = () => {
  try {
    return fs
      .readdirSync(TMP)
      .filter(
        (name) =>
          name.startsWith("htmd-") &&
          name.endsWith(".log") &&
          !name.includes("stderr")
      )
      .map((name) => path.join(TMP, name));
  } catch {
    return [];
  }
};

const headerCount = (text, code) =>
  text.split(`Got message header: ${code}`).length - 1;

const insertedKeysFromLog = (text) => {
  const parts = [];
  const re = new RegExp(`READ FROM ${UUID_RE}:(.*?) (\\d+)\\s*$`, "gm");
  let match;
  while ((match = re.exec(text))) {
    parts.push(match[1]);
  }
  return parts.join("");
};

const paneIdsFromPattern = (text, pattern) => {
  const ids = [];
  const re = new RegExp(pattern, "g");
  let match;
  while ((match = re.exec(text))) {
    ids.push(match[1]);
  }
  return ids;
};

const writingPaneIds = (text) =>
  paneIdsFromPattern(text, `WRITING TO (${UUID_RE}):`);

const readFromPaneIds = (text) =>
  paneIdsFromPattern(text, `READ(?:ING)? FROM (${UUID_RE})`);

const unique = (ids) => [...new Set(ids)];

const newestLog = (logs) => {
  let best = null;
  let bestMtime = 0;
  for (const file of logs) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        best = file;
      }
    } catch {
      // ignore
    }
  }
  return best;
};

const readLog = (file) => {
  if (!file) {
    return "";
  }
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const waitForLog = async (predicate, timeoutMs = 25000) => {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const file = newestLog(listHtmdLogs());
    last = readLog(file);
    if (predicate(last, file)) {
      return { file, text: last };
    }
    await sleep(200);
  }
  throw new Error(
    `Timed out waiting for htmd log condition. Last log tail:\n${last.slice(-2000)}`
  );
};

const focusHyper = () => {
  osascript('tell application "Hyper" to activate');
  osascript(
    'tell application "System Events" to tell process "Hyper" to set frontmost to true'
  );
};

const keystroke = (keys, using) => {
  focusHyper();
  const usingClause = using ? ` using ${using}` : "";
  osascript(
    `tell application "System Events" to keystroke ${keys}${usingClause}`
  );
};

const keyCode = (code, using) => {
  focusHyper();
  const usingClause = using ? ` using ${using}` : "";
  osascript(
    `tell application "System Events" to key code ${code}${usingClause}`
  );
};

const typeLine = async (line) => {
  focusHyper();
  osascript(
    `tell application "System Events" to keystroke ${asQuote(line)}`
  );
  keyCode("36");
  await sleep(400);
};

const startPanePrinter = async (marker) => {
  // zsh `repeat` avoids quotes/braces that AppleScript keystroke mangles.
  // Keep the rate low so APPEND_TO_PANE cannot stall the leader PTY.
  await typeLine(`repeat 40; do echo ${marker}; sleep 0.4; done &`);
};

describe(
  "Hyper HTM system tests",
  {
    timeout: 180000,
    ...(SKIP_REASON ? { skip: SKIP_REASON } : {}),
  },
  () => {
    let wasRunning = false;

    before(async () => {
      wasRunning = hyperWasRunning();
      try {
        osascript('tell application "Hyper" to quit');
      } catch {
        // Hyper may not have been running.
      }
      await sleep(1500);
      osascript('tell application "Hyper" to activate');
      await waitForHyperWindow();
      osascript(
        'tell application "System Events" to tell process "Hyper" to set frontmost to true'
      );
      await sleep(800);
    });

    after(async () => {
      try {
        keystroke('"w"', "{command down, shift down}");
        await sleep(300);
      } catch {
        // Window may already be gone.
      }
      if (!wasRunning) {
        try {
          osascript('tell application "Hyper" to quit');
        } catch {
          // ignore
        }
      }
    });

    it(
      "splits, opens tabs, and streams concurrent output on several panes",
      { timeout: 150000 },
      async () => {
        const startedAt = Date.now() - 1000;
        const stamp = `${Date.now()}`;
        const paneA = `HTM_PANE_A_${stamp}`;
        const paneB = `HTM_PANE_B_${stamp}`;
        const paneC = `HTM_PANE_C_${stamp}`;
        const paneD = `HTM_PANE_D_${stamp}`;

        osascript(
          `tell application "System Events" to keystroke ${asQuote(
            `${HTM_BIN} -x`
          )}`
        );
        keyCode("36");

        const init = await waitForLog((text, file) => {
          if (!file) {
            return false;
          }
          const mtime = fs.statSync(file).mtimeMs;
          return (
            mtime >= startedAt &&
            (text.includes("Starting terminal") ||
              text.includes("SENDING INIT") ||
              text.includes("HTM initialized"))
          );
        });
        const logFile = init.file;
        const waitPinned = async (predicate, timeoutMs = 25000) => {
          const start = Date.now();
          let last = "";
          while (Date.now() - start < timeoutMs) {
            last = readLog(logFile);
            if (predicate(last)) {
              return last;
            }
            await sleep(200);
          }
          throw new Error(
            `Timed out waiting for htmd log condition in ${logFile}. ` +
              `headers 49/51/53/57/65=${headerCount(last, 49)}/${headerCount(last, 51)}/${headerCount(last, 53)}/${headerCount(last, 57)}/${headerCount(last, 65)}. ` +
              `writePanes=${unique(writingPaneIds(last)).length} ` +
              `readPanes=${unique(readFromPaneIds(last)).length} ` +
              `inserted=${JSON.stringify(insertedKeysFromLog(last).slice(-120))}. ` +
              `Last log tail:\n${last.slice(-2000)}`
          );
        };

        await sleep(2000);
        focusHyper();
        await sleep(300);

        // Build the layout first so PTY output does not race split/tab creation.
        keystroke('"d"', "command down");
        await waitPinned((text) => headerCount(text, 57) >= 1);
        await sleep(500);

        keystroke('"t"', "command down");
        await waitPinned((text) => headerCount(text, 53) >= 1);
        await sleep(500);

        keystroke('"d"', "{command down, shift down}");
        await waitPinned((text) => headerCount(text, 57) >= 2);
        await sleep(500);

        // Focus is the new bottom pane on tab 2. Start a printer, then walk
        // pane-prev and tab-prev so each surface gets its own loop.
        await startPanePrinter(paneD);
        await waitPinned((text) => insertedKeysFromLog(text).includes(paneD));

        keystroke('"["', "command down");
        await sleep(400);
        await startPanePrinter(paneC);
        await waitPinned((text) => insertedKeysFromLog(text).includes(paneC));

        keystroke('"["', "{command down, shift down}");
        await sleep(500);
        await startPanePrinter(paneB);
        await waitPinned((text) => insertedKeysFromLog(text).includes(paneB));

        keystroke('"]"', "command down");
        await sleep(400);
        await startPanePrinter(paneA);
        await waitPinned((text) => insertedKeysFromLog(text).includes(paneA));

        const afterInput = readLog(logFile);
        const typedPanes = unique(readFromPaneIds(afterInput));
        assert.ok(
          typedPanes.length >= 3,
          `expected INSERT_KEYS on at least 3 panes, got ${typedPanes.length}`
        );
        for (const marker of [paneA, paneB, paneC, paneD]) {
          assert.ok(
            insertedKeysFromLog(afterInput).includes(marker),
            `missing typed marker ${marker}`
          );
        }

        // Background jobs keep printing; htmd should multiplex several PTYs at once.
        const concurrent = await waitPinned((text) => {
          const ids = writingPaneIds(text);
          if (unique(ids).length < 3) {
            return false;
          }
          const recent = ids.slice(-30);
          return unique(recent).length >= 2;
        }, 20000);

        const livePanes = unique(writingPaneIds(concurrent));
        assert.ok(
          livePanes.length >= 3,
          `expected concurrent output from at least 3 panes, got ${livePanes.join(",")}`
        );
        assert.ok(
          unique(writingPaneIds(concurrent).slice(-30)).length >= 2,
          "expected interleaved WRITING TO lines from more than one pane"
        );
        assert.ok(headerCount(concurrent, 57) >= 2, "expected two NEW_SPLIT packets");
        assert.ok(headerCount(concurrent, 53) >= 1, "expected a NEW_TAB packet");
        assert.ok(headerCount(concurrent, 65) >= 1, "expected RESIZE_PANE after splits");

        // Printers are still running; write on the focused pane and its neighbor.
        const rwA = `HTM_RW_A_${stamp}`;
        const rwB = `HTM_RW_B_${stamp}`;
        await typeLine(`echo ${rwA}`);
        keystroke('"["', "command down");
        await sleep(300);
        await typeLine(`echo ${rwB}`);

        const afterRw = await waitPinned((text) => {
          const keys = insertedKeysFromLog(text);
          return (
            keys.includes(rwA) &&
            keys.includes(rwB) &&
            unique(writingPaneIds(text)).length >= 3
          );
        }, 20000);
        assert.ok(
          insertedKeysFromLog(afterRw).includes(rwA),
          `missing concurrent write marker ${rwA}`
        );
        assert.ok(
          insertedKeysFromLog(afterRw).includes(rwB),
          `missing concurrent write marker ${rwB}`
        );

        // Close the focused split pane.
        await sleep(400);
        keystroke('"w"', "command down");
        await waitPinned((text) => headerCount(text, 51) >= 1);
      }
    );
  }
);
