# Global context

This machine is LeftoverBurrito: Fedora Kinoite (rpm-ostree, immutable /usr — plain dnf does not work on the host) with KDE Plasma 6.

A maintained sysadmin wiki lives at `~/.pi/wiki`. Protocol:

- Before answering system-administration questions or doing sysadmin work (packages, systemd, KDE, distro specifics, this machine's services, the NixOS box), read `~/.pi/wiki/index.md` and then the relevant linked pages. Prefer wiki facts over memory — recall of distro-specific commands, file paths, and unit names is unreliable; the wiki is authoritative.
- When you learn a new durable fact about a machine, or fix something non-obvious, update the relevant wiki page (or create one and add it to index.md), and append a line to `~/.pi/wiki/log.md` in the format `## [YYYY-MM-DD] <verb> | <summary>`.
- Never record secrets in the wiki.
