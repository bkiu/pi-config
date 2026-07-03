# leftoverburrito (this machine)

Desktop, hostname `LeftoverBurrito`, Tailscale name `leftoverburrito` (100.94.105.87).
Fedora Kinoite 43 (rpm-ostree, see [fedora-atomic](fedora-atomic.md)), KDE Plasma 6.5 on Wayland (see [kde](kde.md)).

## Hardware
- ASUS PRIME Z270-A, i5-7600K (4c/4t), 32 GB RAM, zram swap 8 GB
- GPUs: RTX 3090 (main, 24 GB) + RTX 5060 Ti (16 GB); iGPU HD 630 drives nothing
- `nvidia-3090-powerlimit.service` (system unit) caps the 3090 at 300 W for thermals
- Single NVMe 477 GB, btrfs on nvme0n1p3 mounted at /var/home and /sysroot (65% used)
- Network: wifi `wlp4s0` 192.168.88.103; ethernet port is down; Tailscale up

## LLM stack
- `llama-server`: podman container `ghcr.io/ggml-org/llama.cpp:server-cuda`, port 8080
  - model Qwen3.6-27B UD-Q5_K_XL (unsloth GGUF) + MTP speculative decode, ctx 262144, KV q8_0
  - `--parallel 1`: NEVER send concurrent requests (pi, benchmarks, curl) — they queue
  - split across both GPUs: `--tensor-split 20,10 --main-gpu 0`
  - health: `curl localhost:8080/health`; busy check: `curl localhost:8080/slots` (`is_processing`)
- `ollama serve` also runs (system service, default port 11434) — separate from llama-server
- pi agent config lives in `~/.pi` (git repo); benchmark harness in `~/pi-bench`

## Monitoring stack (podman, user containers)
- prometheus :9090, grafana :3000, nvidia-gpu-exporter :9836 (container port 9835)
- all containers `restart=always`; user `podman-restart.service` is enabled so they come back after reboot
- no quadlets — containers were created with `podman run`; config changes mean recreate the container

## Conventions
- layered packages are intentional (nvidia akmods, tailscale, fish, waydroid, snapd, …) — see `rpm-ostree status`
- fish is the interactive shell; scripts should still be bash
