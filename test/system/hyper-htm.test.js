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
const MARKER = `HTM_SYS_${Date.now()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// INSERT_KEYS are logged one character per line as "READ FROM <uid>:<char> <len>".
const insertedKeysFromLog = (text) => {
  const parts = [];
  const re = /READ FROM [0-9a-f-]+:(.*?) (\d+)\s*$/gm;
  let match;
  while ((match = re.exec(text))) {
    parts.push(match[1]);
  }
  return parts.join("");
};

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
      "starts HTM and exercises split, tab, input, and pane close",
      { timeout: 120000 },
      async () => {
        const startedAt = Date.now() - 1000;

        osascript(
          `tell application "System Events" to keystroke "${HTM_BIN} -x"`
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
              `headers 49/51/53/57=${headerCount(last, 49)}/${headerCount(last, 51)}/${headerCount(last, 53)}/${headerCount(last, 57)}. ` +
              `inserted=${JSON.stringify(insertedKeysFromLog(last).slice(-80))}. ` +
              `Last log tail:\n${last.slice(-2000)}`
          );
        };

        // Let Hyper finish creating follower sessions from INIT_STATE.
        await sleep(2000);
        focusHyper();
        await sleep(300);

        keystroke('"d"', "command down");
        await waitPinned((text) => headerCount(text, 57) >= 1);

        osascript(
          `tell application "System Events" to keystroke "echo ${MARKER}"`
        );
        keyCode("36");
        await waitPinned((text) => insertedKeysFromLog(text).includes(MARKER));

        keystroke('"t"', "command down");
        await waitPinned((text) => headerCount(text, 53) >= 1);

        keystroke('"d"', "{command down, shift down}");
        await waitPinned((text) => headerCount(text, 57) >= 2);

        // The new split pane is focused. Do not cycle sessions first:
        // Cmd+Shift+] can land on the leader, and closing that disconnects
        // htm without a CLIENT_CLOSE_PANE packet.
        await sleep(400);
        keystroke('"w"', "command down");
        await waitPinned((text) => headerCount(text, 51) >= 1);

        assert.ok(init.file, "htmd wrote an init log");
      }
    );
  }
);
