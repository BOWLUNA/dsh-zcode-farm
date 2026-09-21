#!/usr/bin/env node
/**
 * Assert that the claim "this package supports dsh X" is true.
 *
 * The versioning policy changed on 2026-09-18: the package version is now its **own** line
 * (`1.0.0`, then `1.0.1`, …), not a mirror of the DSH release. Two things follow, and this script
 * checks both:
 *
 *  1. **The version must be a bare `x.y.z`.** Several directories and markets refuse to auto-install
 *     a version with a prerelease tag (one desktop market resolves npm `latest` and requires
 *     `prerelease(value) === null`), so "which DSH does this support" moved out of the version
 *     string and into `engines.dsh` / the peer range.
 *  2. **The DSH version CI actually installs and tests must satisfy those declarations.** That is
 *     the real invariant: a range that does not cover the tested runtime is a false claim, and
 *     nothing else links the two. Bumping the CI pin without widening the range, or lowering the
 *     range, fails here instead of shipping a package that claims support it never had.
 *
 * Two modes:
 *
 *   node tools/verify-version-consistency.mjs              # CI: the pinned DSH version must satisfy the ranges
 *   node tools/verify-version-consistency.mjs --dsh <ver>  # is THIS installed dsh inside the declared ranges?
 *
 * The second mode exists for `install.sh`: it used to compare the DSH version with the package version
 * (which were the same thing under the old policy) and now asks the same question the only way it can
 * still be answered — against the declared range, with one implementation of the range logic.
 *
 * Exit: 0 when consistent, 1 when not.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PEER = '@deepseek-ai/dsh'

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const workflow = readFileSync(join(REPO, '.github', 'workflows', 'test.yml'), 'utf8')

const fail = (lines) => {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** `1.2.3-rc.4` → `{ tuple: [1,2,3], prerelease: ['rc','4'] }`; null when it is not a version. */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return { tuple: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** Semver precedence (spec §11): tuple, then "a prerelease is lower than its release". */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] < b.tuple[i] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * A range, as a conjunction of comparators separated by spaces: `>=0.1.6-alpha.1`,
 * `>=0.1.0 <0.2.0`, `1.2.3`. Anything else (`^`, `~`, `||`) is refused **loudly** rather than
 * silently answered wrong — extend this function if the declared range ever needs it.
 */
function satisfies(version, range) {
  const parts = String(range).trim().split(/\s+/).filter((p) => p !== '')
  if (parts.length === 0) throw new Error('范围是空的')
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    if (bound === null) throw new Error(`不支持的比较符或版本：${part}`)
    const order = compare(version, bound)
    const ok = operator === '>=' ? order >= 0
      : operator === '<=' ? order <= 0
        : operator === '>' ? order > 0
          : operator === '<' ? order < 0
            : order === 0
    if (!ok) return false
  }
  return true
}

const declared = []
if (typeof pkg.engines?.dsh === 'string') declared.push({ where: 'engines.dsh', range: pkg.engines.dsh })
if (typeof pkg.peerDependencies?.[PEER] === 'string') declared.push({ where: `peerDependencies["${PEER}"]`, range: pkg.peerDependencies[PEER] })

if (declared.length === 0) {
  fail([
    '版本一致性: editor/package.json 里没有声明 dsh 兼容范围。',
    '至少要有 engines.dsh（目录与市场用它显示宿主兼容性）。',
  ])
}

// 1. The published version must be a bare x.y.z — see the file header.
const own = parseVersion(pkg.version)
if (own === null) {
  fail([
    `版本一致性: editor/package.json 的 version 不是合法语义化版本：${JSON.stringify(pkg.version)}`,
    '（四段号如 0.1.6.2 不是合法 semver，npm 会直接拒绝发布。）',
  ])
}
if (own.prerelease.length > 0) {
  fail([
    `版本一致性: 包版本 ${pkg.version} 带预发布标签（-${own.prerelease.join('.')}）。`,
    '有目录与市场以此判定"不自动安装"（例如要求 npm latest 满足 prerelease(value) === null）。',
    '本项目的约定是：版本号走自己的稳定线（1.0.0、1.0.1 …），',
    '"适配哪个 dsh" 由 engines.dsh 与 peer 范围声明，并由本脚本校验它覆盖 CI 实测的版本。',
  ])
}

// Mode `--dsh <version>`: answer the question for an arbitrary installed version. Used by
// `install.sh`, which must not carry a second copy of the range logic.
const dshFlag = process.argv.indexOf('--dsh')
if (dshFlag !== -1) {
  const given = process.argv[dshFlag + 1]
  const parsed = parseVersion(given)
  if (parsed === null) {
    console.error(`版本兼容性: 装了 dsh ${JSON.stringify(given)}，这不是一个能解析的版本号。`)
    process.exit(1)
  }
  const outside = []
  for (const { where, range } of declared) {
    let ok
    try {
      ok = satisfies(parsed, range)
    } catch (error) {
      console.error(`版本兼容性: 无法解析 ${where} 的范围 ${JSON.stringify(range)} —— ${error.message}`)
      process.exit(1)
    }
    if (!ok) outside.push({ where, range })
  }
  if (outside.length > 0) {
    console.error(`版本兼容性: 装了 dsh ${given}，但声明的兼容范围不覆盖它：`)
    for (const m of outside) console.error(`  ${m.where.padEnd(26)} ${m.range}`)
    console.error('  本项目深度依赖 DSH 内部 API：版本不在范围内时，请先核对 README 的「耦合点清单」。')
    process.exit(1)
  }
  console.log(`版本兼容性: dsh ${given} 在声明的兼容范围内（${declared.map((d) => d.range).join(' / ')}）。`)
  process.exit(0)
}

// 2. The DSH version CI installs must be inside every declared range.
const pinned = /@deepseek-ai\/dsh@([0-9A-Za-z.\-+]+)/.exec(workflow)
if (pinned === null) {
  fail([
    '版本一致性: 无法在 CI workflow 里找到 @deepseek-ai/dsh@<version> 的钉定。',
    '若 CI 改成从别处取版本，请同步更新本脚本。',
  ])
}
const tested = pinned[1]
const testedVersion = parseVersion(tested)
if (testedVersion === null) {
  fail([`版本一致性: CI 钉的 dsh 版本不是合法语义化版本：${JSON.stringify(tested)}`])
}

const misses = []
for (const { where, range } of declared) {
  let ok
  try {
    ok = satisfies(testedVersion, range)
  } catch (error) {
    fail([
      `版本一致性: 无法解析 ${where} 的范围 ${JSON.stringify(range)} —— ${error.message}`,
      '本脚本只支持用空格连接的 >= > <= < = 比较符；扩了写法就要同步扩本脚本。',
    ])
  }
  if (!ok) misses.push({ where, range })
}

if (misses.length > 0) {
  fail([
    '版本一致性: CI 实测的 dsh 版本不在声明的兼容范围内。',
    `  CI 安装并测试的 dsh         ${tested}`,
    ...misses.map((m) => `  ${m.where.padEnd(26)} ${m.range}   ← 不覆盖 ${tested}`),
    '',
    '升 dsh 时把范围放宽到覆盖新版本，或在真的不再支持旧版本时改写下界；',
    '否则发布的包会声称支持一个从未跑过测试的运行时。',
  ])
}

console.log(`版本一致性: OK —— 包版本 ${pkg.version}（稳定线）；`)
for (const { where, range } of declared) console.log(`  ${where} = ${range}`)
console.log(`  覆盖 CI 实测的 dsh ${tested} ✔`)
