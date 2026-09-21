# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-09-21

First public release. Everything before it (0.1.x) was an unpublished development snapshot.

### Included

- Multi-instance ComfyUI orchestration: read every endpoint's GPU, free VRAM and queue depth, then dispatch each generation job to the idlest eligible instance
- Three tools: `comfyui_farm_status`, `comfyui_farm_pick` and `comfyui_farm_run`
- Two-stage selection: filter on reachability, a VRAM floor and a queue ceiling, then rank by free VRAM minus queue depth times a weight
- Automatic retry on probe failure, because a single timeout across an SSH tunnel is not proof that an instance is down
- Zero runtime dependencies — Node's built-in `fetch` and `AbortController` only

### Compatibility

- Developed and verified against dsh `0.1.5-rc.2` and `0.1.6-alpha.2`
- Host APIs used: `ctx.tools.register`, `ctx.get`, `ctx.effect`, `ctx.logger`

## [0.1.0] — 2026-09-21

First release.

### Added

- `comfyui_farm_status` — full farm view: per-instance GPU, free VRAM, queue depth, what is running, and the recommended dispatch target
- `comfyui_farm_pick` — choose without executing: filter by VRAM floor / queue ceiling / GPU-name hint / exclude list, and get the reason
- `comfyui_farm_run` — load-aware dispatch: auto-pick or force an instance; accepts a raw API workflow or a one-shot "prompt + checkpoint" text-to-image
- Two-stage instance selection: filter by hard constraints first, then rank by `free VRAM − queue depth × queueWeight`
- Automatic retry on probe failure (protection against cross-SSH-tunnel flakiness), reporting `attempts` alongside
- Three probes: `probe-farm.mjs` (standalone status probe) and `probe-tools.mjs` (load the entry and really execute the tools)

### Verified on real hardware (5 SSH tunnels + 1 switchable forwarder)

- At one moment five RTX 5090s were all running video workflows (0.5–0.9 GB free) while a single RTX PRO 6000 Blackwell sat completely idle (99.4 GB); the plugin **correctly identified and selected the latter**
- End-to-end generation succeeded: auto-dispatch → `prompt_id` returned → `status: success / completed: true` → produced `farm_00001_.png`, retrievable via `/view` (HTTP 200 / 424,466 bytes / image/png)
- All 15 unit checks pass (`node --test`)

### Fixed (during development)

- **Missing retry**: a single failed probe used to be read as "unreachable". Measured on the same machine: one probe timed out at `>3s` and the very next returned in `106ms`, proving tunnel flakiness was being misjudged. Now retries once by default.
- **Reason overwritten**: when filtering by GPU hint, an unreachable instance's reason was rewritten to "GPU mismatch", hiding the actual problem. Now only instances that were already eligible get filtered by hint.
- **Misleading label**: the output once labelled `/prompt`'s `number` as "queue position"; measured, it still returns 22 when the queue is empty — that is a server-side cumulative counter. The label is now "server task number (cumulative, not a queue position)".
