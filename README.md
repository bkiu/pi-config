# pi-config

Pi agent configuration — sync agents, extensions, prompts, models, and settings across machines.

## Contents

| Directory | Description |
|---|---|
| `agent/agents/` | Custom agent definitions |
| `agent/extensions/` | Custom extensions |
| `agent/prompts/` | Prompt templates |
| `agent/models.json` | Model choices |
| `agent/settings.json` | Settings |
| `agent/remote-control.json` | pi-server address for remote monitoring |
| `agent/gondolin-sandbox/` | micro-VM tool sandbox for remotely-spawned sessions (loaded via `pi -e`, not auto-loaded) |

## Install

On a new machine, clone into `~/.pi`:

```bash
git clone git@github.com:bkiu/pi-config.git ~/.pi
```

## Remote control

`agent/extensions/remote-control.ts` mirrors sessions to a [pi-server](https://git.stargazer-darter.ts.net/brendankiu/pi-server) instance for web-based monitoring and remote input. The server address lives in `agent/remote-control.json`:

```json
{ "url": "wss://pi.stargazer-darter.ts.net" }
```

`PI_REMOTE_URL` / `PI_REMOTE_NAME` env vars override the file; without any url the extension does nothing. It is on automatically; a green `rc` indicator appears on the footer model line while connected. `/rc` shows status, `/rc off` / `/rc on` toggle it for the session.

The server requires a machine token: the extension reads `PI_REMOTE_TOKEN`, or the file named by `tokenFile` in `remote-control.json`, or `~/.config/pi-remote/token` (copy it from `data/agent-token` on the server). The token deliberately lives outside this repo — pi-config is publicly clonable.

`auto-permission.ts` publishes its permission mode on the extension event bus (`autoperm:mode`) and accepts remote switches (`autoperm:set`), so the mode can be changed from the pi-server web UI as well as with `/auto`; both directions stay in sync.

Beyond mirroring the transcript and accepting remote input/abort, the extension also mirrors UI dialogs (`ctx.ui.select/confirm/input` — including auto-permission's permission prompts) to the web UI, where they can be answered remotely; the remote answer races the local dialog and the loser is dismissed. It publishes the session's usable model list so the web UI can switch the active model with `pi.setModel()`.

`agent/gondolin-sandbox/index.ts` (adapted from pi's gondolin example) routes all built-in tools into a gondolin micro-VM with only the working directory mounted at `/workspace`. It deliberately lives outside `extensions/` so it never auto-loads; [pi-daemon](https://git.stargazer-darter.ts.net/brendankiu/pi-daemon) starts remotely-spawned sessions with `pi -e ~/.pi/agent/gondolin-sandbox/index.ts`. Requires qemu on PATH (pi-daemon's service provides it).

## What's excluded

- `sessions/` — session history (generated per machine)
- `bin/` — binary tools
- `auth.json` — auth tokens (machine-specific)
