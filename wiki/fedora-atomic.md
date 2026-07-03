# Fedora Atomic (Kinoite / Silverblue) operations

Image-based Fedora: `/usr` is read-only, the OS is a versioned ostree image. Plain `dnf install` does NOT work on the host. Used on [leftoverburrito](leftoverburrito.md).

## Installing software — decision order
1. GUI app → Flatpak (`flatpak install flathub <app>`)
2. Dev/CLI tooling you only need in a shell → toolbox container (`toolbox create; toolbox enter; dnf install ...` inside)
3. Needs to be on the real host (drivers, shells, system daemons) → layer it: `rpm-ostree install <pkg>`

## rpm-ostree essentials
- `rpm-ostree install <pkg>` — layer a package into the base image permanently (takes effect next boot)
- `rpm-ostree apply-live` — apply the pending deployment to the running system without rebooting
- `rpm-ostree install --apply-live <pkg>` — both at once
- `rpm-ostree uninstall <pkg>` — remove a layered package
- `rpm-ostree upgrade` — pull and stage the new base image
- `rpm-ostree rollback` — make the previous deployment the default and boot target
- `rpm-ostree status` — list deployments (● marks the booted one), layered and removed packages
- `rpm-ostree cleanup -p` — drop the pending deployment; `-r` drops rollback deployment

## Filesystem layout gotchas
- `/usr` read-only; writable state lives under `/var` and `/etc`
- home directories are physically at `/var/home` (with `/home` a symlink to it)
- `/opt` and `/usr/local` are symlinks into `/var`
- kernel args: `rpm-ostree kargs --append=... / --delete=...`

## When things break
- bad update → reboot, pick previous deployment in GRUB, then `rpm-ostree rollback`
- pending deployment stuck → `rpm-ostree cleanup -p` and retry
- SELinux denials → `sudo ausearch -m avc -ts recent`
