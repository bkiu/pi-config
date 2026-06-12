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

## Install

On a new machine, clone into `~/.pi`:

```bash
git clone git@github.com:bkiu/pi-config.git ~/.pi
```

## What's excluded

- `sessions/` — session history (generated per machine)
- `bin/` — binary tools
- `auth.json` — auth tokens (machine-specific)
