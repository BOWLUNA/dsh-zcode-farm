# Publishing

**English** | [中文](PUBLISHING.zh.md)

> Tag-driven. A `v*` tag is the only trigger; nothing publishes from `main`.

## What a tag runs

`.github/workflows/release.yml` runs the same guards as CI, then hands off to
`tools/publish-if-new.mjs`.

That script exists because the interesting failure is not "the publish failed" — it is
"the publish silently did nothing". Three shapes of it:

- re-running a tag after a flaky step would fail with a conflict and look like a broken release
- `publishConfig.tag` is not reliably honoured, so a run can go green while `latest` still points at
  the previous version
- a green job is not evidence the version is live

So the script asks npm whether **this exact version** exists and exits 0 if it does; otherwise it
publishes with an explicit `--tag latest`, then polls npm for up to six minutes to confirm
propagation.

## Authentication

Trusted Publishing (OIDC) — no `NODE_AUTH_TOKEN` is stored in this repository. One-time setup on
npmjs.com: the package's Trusted Publisher must name this repository and this workflow file. Until
that exists the publish step fails at authentication, which is a setup problem, not a code one.

**Do not use a session token.** It goes through staged publishing, whose symptom is "publish
succeeded but `latest` did not move".

## After a release: open the tarball

A green workflow plus a version on the registry only prove *a* package went up. Opening the tarball
proves **this** change went up.

```bash
cd /tmp && rm -rf tgz && mkdir tgz && cd tgz
curl -sL "$(npm view dsh-zcode-farm dist.tarball)" -o p.tgz && tar xzf p.tgz
node -p "require('./package/package.json').version"
grep -rl 'comfyui_farm_status' package/
```

## Version bumps

- the version lives in `package.json`, both READMEs, both SECURITY support tables and both CHANGELOGs
- `engines.dsh` and the `@deepseek-ai/dsh` peer range are **host compatibility declarations** — they
  are not the plugin version and must not be bumped together with it
- after changing any documented number, re-record the pairing hashes and re-run the number guard
