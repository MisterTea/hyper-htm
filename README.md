# hyper-htm

HTM (headless terminal multiplexer) support for [Hyper](https://hyper.is) 3.4+.

When a session prints the tmux control-mode DCS (`ESC P 1000 p`), this plugin takes over splits and tabs so they map onto `htmd` panes.

## Install (Hyper 3.4)

From a clone of this repo:

```bash
mkdir -p ~/.hyper_plugins/local
ln -sfn "$(pwd)" ~/.hyper_plugins/local/hyper-htm
```

Then in `~/.hyper.js`:

```js
localPlugins: ['hyper-htm'],
```

To prefer a locally built `htm`/`htmd` (Hyper's config VM cannot use `process.env`):

```js
config: {
  env: {
    HTM_BIN_DIR: '/path/to/EternalTerminal/build',
  },
},
```

The plugin prepends `HTM_BIN_DIR` to `PATH` for new sessions. Reload Hyper (View → Full Reload), then run `htm`.

## Tests

Unit tests stay in this repo:

```bash
npm test
```

GUI e2e lives in [Eternal Terminal](https://github.com/MisterTea/EternalTerminal) next to the iTerm2 suite. After installing this plugin (see above) and building `htm`/`htmd`, from the EternalTerminal checkout:

```bash
python3 test/system_tests/hyper_htm_e2e.py --htm build/htm --htmd build/htmd
```

## Compatibility

Tested with Hyper 3.4.1 (Electron 20 / node-pty 0.10). PTY output is intercepted on the Session `data` event because node-pty 0.10 no longer emits EventEmitter `'data'`, and Hyper batches chunks before they reach the renderer.

Requires Eternal Terminal HTM that speaks tmux `-CC` (DCS 1000p), not the older private opcode protocol.
