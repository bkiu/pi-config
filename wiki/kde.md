# KDE Plasma configuration map

Plasma 6.5 on Wayland on [leftoverburrito](leftoverburrito.md). KDE has no single config file — everything is INI files under `~/.config/`.

## Config file map (~/.config/)
- `kwinrc` — KWin compositor: effects, tiling, virtual desktops, screen edges
- `kwinrulesrc` — per-window rules
- `kscreenlockerrc` — screen locker: timeout, lock on resume, wallpaper
- `kglobalshortcutsrc` — global keyboard shortcuts
- `plasmarc`, `plasmashellrc` — plasma shell/theme bits
- `plasma-org.kde.plasma.desktop-appletsrc` — desktop layout, panels, widgets (fragile; back up before editing)
- `kdeglobals` — colors, fonts, single/double click, misc defaults
- `powermanagementprofilesrc` — power/suspend behavior (powerdevil)
- `kactivitymanagerdrc` — activities
- `dolphinrc`, `konsolerc`, `katerc` — per-app settings
- autostart: desktop files in `~/.config/autostart/`
- monitor layout (Wayland): `~/.local/share/kscreen/`

## CLI tools
- read a key: `kreadconfig6 --file kscreenlockerrc --group Daemon --key Timeout`
- write a key: `kwriteconfig6 --file kscreenlockerrc --group Daemon --key Timeout 10`
- many components only re-read config on restart (see below) or via
  `qdbus6 org.kde.KWin /KWin reconfigure` for KWin

## Restarting components (Plasma 6, systemd user units)
- plasmashell: `systemctl --user restart plasma-plasmashell.service`
- kwin (Wayland session — restarting logs you out; prefer reconfigure): unit `plasma-kwin_wayland.service`
- whole session services list: `systemctl --user list-units 'plasma-*'`
- SDDM (login manager, system level): config `/etc/sddm.conf.d/`, unit `sddm.service`

## Debugging
- session log: `journalctl --user -b` (plasmashell, kwin crashes land here)
- coredumps: `coredumpctl list`, `coredumpctl info <pid>`
