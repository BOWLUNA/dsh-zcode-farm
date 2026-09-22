# Tests

**English** | [中文](README.zh.md)

> **2 suites**, **23 checks**. Run them all with `node test/run.mjs`.

## What is covered

- `core.test.mjs` — the pure core: instance scoring, picking, the text-to-image graph, output flattening

## Why some expectations look like odd numbers

Several expectations are pinned to one measured moment on the development machine: five RTX 5090s each
with 0.5–0.9 GB free and all running video workflows, sitting next to one completely idle 102 GB Blackwell.
Those cases keep the "pick the idlest instance" kernel from silently regressing.
