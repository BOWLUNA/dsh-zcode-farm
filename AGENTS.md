# AGENTS.md — rules for coding agents in this repository

> Scope: **this repository**. Workspace-level conventions live in the plugin workspace's own `AGENTS.md`.
> The short version: a claim without a command and its raw output is not a claim.

## Do not break these

- **Do not edit `tools/verify-*.mjs` to make a check pass.** They read real runtime results; when they fail,
  fix the document or the code. (Adapting their hard-coded paths to this repository was a one-off.)
- **Do not change one side of a bilingual pair alone.** Edit both, then re-record:
  `node tools/verify-translation-pairing.mjs --write`.
- **Do not rename the loader row in `cordis.patch.yml` without renaming the package.** The row's
  `name` is resolved as a package name at boot. If the two drift apart the plugin **installs fine
  and then refuses to boot** with `ERR_MODULE_NOT_FOUND` — while `--dump-config` still exits 0
  with no stderr, because it composes the tree without applying it. `tools/boot-check.mjs`
  (assertion B) is the guard for this, and it is the only one of the six that can see it.
- **Do not remove `output.render` from a tool definition.** DSH validates the tool contract at registration;
  a missing `render` is a hard failure, not a degraded feature.
- **Do not commit credentials.** Reference key names only, never values.

## Layout

- `index.js` — plugin entry: `name` / `inject` / `Config` / `apply`, plus the three tool definitions
- `src/farm.js` — probe, score and pick (pure; no DSH imports, so it unit-tests standalone)
- `src/workflow.js` — the minimal text-to-image graph and output flattening
- `probes/` — runnable diagnostics that need neither DSH nor the host
- `tools/boot-check.mjs` — installs this checkout into a throwaway `DSH_HOME` and really boots it
  (four assertions A/B/C/D; the port answering is the decisive one)

## Before you commit

```bash
node test/run.mjs                                  # 1 suite, 15 checks
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
node tools/boot-check.mjs --port 31841             # 真装一次、真启动一次
```

## Facts that are easy to get wrong

- `/prompt` returns `number` as a **cumulative server counter**, not a queue position — measured, it returns 22 while the queue is empty.
- A failed probe is retried **once on purpose**: the same instance once timed out at `>3s` and answered in `106ms` on the very next call.
- Two entries can point at the same backend (a switchable forwarder plus its real target). The plugin reports them separately and does **not** try to deduplicate — probing cannot tell them apart.
- **The harness needs node >= 22.19.0, but `package.json` says `engines.node: ">=20"`.** Measured
  2026-09-21: on node 20, `npm install --no-save @deepseek-ai/dsh@0.1.6-alpha.2` reports
  "added **10** packages" and leaves no `node_modules/.bin/dsh`; on node 24 the same command reports
  488–520 packages. The harness's dependency tree contains packages requiring `>=22.19.0`
  (`undici`, `@deepseek-ai/libreoffice-kit`, `@earendil-works/pi-ai`). Re-measured with npm 10 on
  node 24 (490 packages) to rule the npm version out — it is node 20. The declared range is therefore
  optimistic; `engines.node` and the CI matrix should be aligned in a release that bumps the version.
  The boot check is gated to `node != 20` for this reason.
- **`dsh plugin` needs `pnpm` on PATH.** Without it the plugin manager refuses with
  "pnpm not found on PATH — install pnpm to manage profile plugins". Local machines have it; CI must
  install it explicitly.
