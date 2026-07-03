# systemd reference

Recipes that come up in real debugging. Used everywhere; host specifics in [leftoverburrito](leftoverburrito.md).

## journalctl recipes
- previous boot: `journalctl -b -1` (current boot is `-b`; list boots: `journalctl --list-boots`)
- one unit: `journalctl -u foo.service -b`; user unit: `journalctl --user -u foo.service`
- errors only: `-p err` (or `-p warning`); kernel only: `-k`
- follow: `-f`; since: `--since "2026-07-01 03:00"` / `--since -1h`
- disk usage / trim: `journalctl --disk-usage`, `sudo journalctl --vacuum-size=500M`

## Failure forensics
- `systemctl --failed` — list failed units
- `systemctl status foo.service` — last result + recent log lines
- unit `Result=` values you'll see in "Failed with result '...'": `exit-code`, `signal`, `oom-kill`, `timeout`, `start-limit-hit`, `dependency`, `core-dump`
- restart loops end with `start-limit-hit` (default: 5 starts in 10 s); the *first* failure before the loop is the root cause
- "Dependency failed for X" → walk down to the mount/device unit that actually failed
- coredumps: `coredumpctl list`, `coredumpctl gdb <pid>`

## Unit name escaping
- unit names encode paths: `/` → `-`, and special chars (including `-`) become `\xNN`
- mount unit for /srv/backup → `srv-backup.mount`; for /mnt/media-drive → `mnt-media\x2ddrive.mount` (the dash in "media-drive" becomes `\x2d`)
- never hand-compute: `systemd-escape -p --suffix=mount /mnt/media-drive`

## Editing units safely
- `systemctl edit foo.service` → writes a drop-in override to `/etc/systemd/system/foo.service.d/override.conf` (never edit files in /usr/lib/systemd)
- full copy override: `systemctl edit --full`; after manual file edits: `systemctl daemon-reload`
- lint a unit file: `systemd-analyze verify foo.service`

## Timers / OnCalendar
- syntax `DOW YYYY-MM-DD HH:MM:SS` with `*` wildcards; e.g. daily 03:30 → `*-*-* 03:30:00`
- shortcuts: `hourly`, `daily`, `weekly` (weekly normalizes to `Mon *-*-* 00:00:00`)
- always check with `systemd-analyze calendar '<expr>'` (shows normalized form + next elapse)
- `Persistent=true` catches up runs missed while powered off; list timers: `systemctl list-timers`
