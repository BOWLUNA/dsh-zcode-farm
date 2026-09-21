# Contributing

**English** | [中文](CONTRIBUTING.zh.md)

> This repository does one thing: let an agent see a whole ComfyUI farm instead of a single endpoint.

## Environment

- Node.js >= 20
- No build step — source ships as-is, installing never runs a build

## Run these before every commit

The suite is **1 suite, 15 checks** — all five commands below must be green.

```bash
node test/run.mjs                                    # suite and check counts
node tools/verify-translation-pairing.mjs --write    # re-record pairing hashes after touching either side
node tools/verify-doc-numbers.mjs                    # documented numbers vs reality
bash -n install.sh && bash -n uninstall.sh           # shell syntax
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
```

## Rules

- Change one side of a bilingual pair, change the other side too — then re-record the pairing hash
- Every user-visible failure result carries a `code` plus `params`; the page renders it from its own dictionary
- A conclusion without the command and its raw output is not a conclusion
- One pull request does one thing
