# NixOS operations

Declarative distro: the whole system is built from Nix expressions; changes go through config + rebuild, never by mutating files in /usr or /etc by hand. Host facts: [nixos-box](nixos-box.md).

## Core workflow
- system config lives in `/etc/nixos/configuration.nix` (unless the box uses a flake — check for `/etc/nixos/flake.nix`)
- `nixos-rebuild switch` — build the new system and activate it now (also becomes boot default)
- `nixos-rebuild test` — build and activate now, but do NOT make it the boot default (reverts on reboot)
- `nixos-rebuild boot` — build and make it the boot default without activating now
- `nixos-rebuild switch --rollback` — activate the previous generation
- flake systems: `nixos-rebuild switch --flake /etc/nixos#<hostname>`

## Generations and cleanup
- `nixos-rebuild list-generations` — list system generations (or: `nix-env --list-generations --profile /nix/var/nix/profiles/system`)
- every generation is a GRUB boot entry — any breakage is fixable by booting an older generation
- `nix-collect-garbage -d` — delete old generations and collect garbage (frees /nix/store; run as root for system generations)
- `nix-store --optimise` — deduplicate the store

## Gotchas vs normal Linux
- no `/usr/bin` beyond env; binaries live in `/nix/store/...` and are wired up via profiles — hardcoded shebangs like `#!/usr/bin/python3` fail (use `#!/usr/bin/env python3`)
- installing ad-hoc: `nix-shell -p <pkg>` (temporary) or `nix profile install nixpkgs#<pkg>` (per-user); prefer declaring in configuration.nix
- systemd units are generated from config; edit `systemd.services.<name>` options in configuration.nix, not files in /etc/systemd
- config search: https://search.nixos.org for options and packages
