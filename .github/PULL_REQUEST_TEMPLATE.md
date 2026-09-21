## What this changes

<!-- One paragraph. If it changes one of the documented design choices, say which and why. -->

## Checklist

- [ ] `node test/run.mjs` is green
- [ ] `node tools/verify-translation-pairing.mjs` is green (`--write` if either language changed)
- [ ] `node tools/verify-doc-numbers.mjs` is green
- [ ] `node tools/verify-version-consistency.mjs --dsh <version>` is green
- [ ] `bash -n install.sh && bash -n uninstall.sh` is clean
- [ ] `bash tools/boot-check.sh` is green (it installs the checkout and really boots it — the only guard that catches "installs but will not boot")
- [ ] Every new safety rule has a test that fails when the rule is removed
- [ ] No credentials, tokens, or private hostnames are included
- [ ] If a documented number changed, both language sides were updated and re-recorded

## How it was verified

<!-- Commands and their raw output. "Should work" is not a verification. -->
