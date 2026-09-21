# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-09-21

### Fixed

- **The test gate was silently switched off on Node 24.** `test/run.mjs` read the suite totals by matching `# pass N` in the runner's output. Node 24 changed the default test reporter to `spec` even when stdout is not a TTY, so that line became `ℹ pass N`, the regular expression matched nothing, and every suite parsed as "0 passed, 0 failed". The damage was not a red build: on Node 24 the runner printed a green tick and exited 0 **while assertions were failing**, because it never counted a single failure. The `test` workflow did go red on that leg — but at a later step, the documentation-numbers guard, which reads the same totals and reported five documents as wrong. The error message then pointed at the documentation, and following its advice would have written "0 checks" into five files and disabled the gate for good.

  The runner now pins `--test-reporter=tap`, and treats unreadable output as a failure in its own right: a suite whose summary cannot be parsed counts as failed, and collecting zero checks overall is an error rather than a pass.

  Symptom and cause were far apart here, so the fix is verified in both directions. With a deliberately failing assertion injected, the runner goes red on Node 20, 22 and 24; with that assertion removed it goes green again. Pinning the reporter was also tested by reverting it — the runner then reports that the result could not be parsed and exits 1, instead of quietly passing.

### Notes

- The shipped code is unchanged. `test/` is not listed in `files`, so the fix itself adds nothing to the tarball; the only things that differ from `1.0.0` are the version field and the documentation. Verified with `npm pack --dry-run`: 36 files, no `test/` entry.
- The release workflow now creates the GitHub Release. Its `permissions` block said `contents: read` and no step created one, so tagging this release produced a tag while the repository's Releases panel stayed on `v1.0.0` — the code was updated and the front page looked untouched. It is now `contents: write`, with a step that takes the release body from this file's entry for the tag.

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
