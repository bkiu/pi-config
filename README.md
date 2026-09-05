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

`PI_REMOTE_URL` / `PI_REMOTE_NAME` env vars override the file; without any url the extension does nothing. `/remote` shows connection status in a session.

## What's excluded

- `sessions/` — session history (generated per machine)
- `bin/` — binary tools
- `auth.json` — auth tokens (machine-specific)
