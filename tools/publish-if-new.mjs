#!/usr/bin/env node
/**
 * Publish the current version unless npm already has it.
 *
 * The release workflow calls this instead of `npm publish` directly, because the
 * interesting failure is not "the publish failed" — it is "the publish silently
 * did nothing". Two shapes of that:
 *
 * - Re-running a tag (a retry after a flaky step) would fail on `EPUBLISHCONFLICT`
 *   and look like a broken release.
 * - `publishConfig.tag` in `package.json` is not reliably honoured, so a release
 *   can succeed while `latest` keeps pointing at the previous version — the
 *   symptom is "the release is green and nobody can install it".
 *
 * So this script asks npm whether the exact version exists, and publishes with an
 * explicit `--tag latest` when it does not. It never publishes over an existing
 * version: a version on npm is immutable, and quietly trying is how a broken
 * build gets mistaken for a successful release.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** npm is a Windows .cmd shim, so the shell has to resolve it. */
const run = (args, options = {}) =>
  spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...options })

if (!/^\d+\.\d+\.\d+$/u.test(pkg.version)) {
  process.stderr.write(
    `refusing to publish: version ${JSON.stringify(pkg.version)} is not a bare x.y.z.\n` +
      'Markets and pnpm auto-install only that shape.\n',
  )
  process.exit(1)
}

const probe = run(['view', `${pkg.name}@${pkg.version}`, 'version'])
if (probe.status === 0 && probe.stdout.trim() !== '') {
  process.stdout.write(`${pkg.name}@${pkg.version} is already published — nothing to do\n`)
  process.exit(0)
}

process.stdout.write(`publishing ${pkg.name}@${pkg.version}\n`)
const publish = run(['publish', '--access', 'public', '--tag', 'latest'], { stdio: 'inherit' })
if (publish.status !== 0) {
  process.stderr.write('npm publish failed — see the output above\n')
  process.exit(publish.status ?? 1)
}

// A green publish job is not evidence the version is live. npm's propagation
// took about 2.5 minutes when this was measured, so the check is a bounded poll
// rather than a single read.
const deadline = Date.now() + 6 * 60 * 1000
while (Date.now() < deadline) {
  const check = run(['view', `${pkg.name}@${pkg.version}`, 'version'])
  if (check.status === 0 && check.stdout.trim() === pkg.version) {
    process.stdout.write(`propagated: ${pkg.name}@${pkg.version} is live on npm\n`)
    process.exit(0)
  }
  await new Promise((resume) => setTimeout(resume, 15_000))
}

process.stderr.write(
  `${pkg.name}@${pkg.version} published but did not appear on npm within 6 minutes.\n` +
    'That is not necessarily a failure — check `npm view ' +
    pkg.name +
    ' version` before re-running.\n',
)
process.exit(1)
