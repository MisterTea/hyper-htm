# hyper-htm

HTM (headless terminal multiplexer) support for [Hyper](https://hyper.is) 3.4+.

When a session prints the HTM init sequence (`ESC[###q`), this plugin takes over splits and tabs so they map onto `htmd` panes.

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

## Compatibility

Tested with Hyper 3.4.1 (Electron 20 / node-pty 0.10). PTY output is intercepted on the Session `data` event because node-pty 0.10 no longer emits EventEmitter `'data'`, and Hyper batches chunks before they reach the renderer.
