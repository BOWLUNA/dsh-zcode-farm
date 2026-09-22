#!/usr/bin/env node
/**
 * The documented numbers must match reality.
 *
 * **Why**: an external review found three drifts in one pass — `test/README.md` still advertised "8 suites",
 * `README.md` "12 suites, 588 checks", `CONTRIBUTING.md` "588 checks across twelve suites" — none of which the
 * test suite could see, because documentation is not executed. A number in a README is a claim like any other,
 * and this repository's rule is that claims are checked rather than remembered.
 *
 * What it does:
 *   1. runs `node test/run.mjs` and reads the real totals (checks + suites);
 *   2. extracts every count claim from the English documentation and compares it;
 *   3. asserts the declared dsh range appears in the package README and the repository README, and that the
 *      SECURITY support table's first row names the current package version.
 *
 * Run: node tools/verify-doc-numbers.mjs   (CI runs it after the suite)
 * Exit: 0 when every claim matches, 1 with the exact file:line and both values otherwise.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []

/** Run the suite and return the real totals. */
function measure() {
  // stderr 单独吞掉：套件里有一些故意失败的演示（比如 session-trace 的 --expect 反例），它们不是这里的问题。
  //
  // ⚠️ 必须自己接住非 0 退出：`execFileSync` 遇到非 0 会**直接抛栈**，
  //    于是「套件输出无法解析（reporter 变了）」这种场景会以一段
  //    `Error: Command failed: … node test/run.mjs` 收场 —— 抓是抓到了，
  //    但看不出是哪道闸门、为什么。同一族的问题在本仓库已经付过一次学费
  //    （见 test/run.mjs 文件头：Node 24 换 reporter 让整道闸门假绿）。
  let output
  let suiteExit = 0
  try {
    output = execFileSync(process.execPath, [join(REPO, 'test', 'run.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    output = String(err.stdout ?? '')
    suiteExit = typeof err.status === 'number' ? err.status : -1
    if (output === '') {
      problems.push(`test/run.mjs 以 exit ${String(suiteExit)} 退出且没有任何 stdout —— 无法测量真实检查数。`)
      return { checks: NaN, suiteRuns: NaN, suiteFiles: NaN, skipped: false }
    }
  }
  // Node < 22.15 没有 zstd，session-trace 套件会跳过一部分检查 —— 于是同一份代码在不同运行时上检查数不同。
  // 文档写的是**完整运行时**的数字（那才是开发者会看到的），所以这里只在"跳过"时放宽下界并说明原因。
  const skipped = output.includes('zstd 部分已跳过')
  let checks = 0
  const suites = []
  for (const line of output.split('\n')) {
    const match = /^结果: (\d+) 通过, (\d+) 失败/.exec(line)
    if (match !== null) {
      checks += Number(match[1]) + Number(match[2])
      suites.push(match[0])
    }
  }
  if (suiteExit !== 0) {
    problems.push(
      `test/run.mjs 以 exit ${String(suiteExit)} 退出 —— 摘要不可信，因此下面的数字比对一律不成立。\n`
        + '    最可能的原因：某个套件的输出无法解析（`--test-reporter=tap` 被去掉了？Node 换默认 reporter 了？）。',
    )
  }
  const files = readdirSync(join(REPO, 'test')).filter((name) => name.endsWith('.test.mjs'))
  return { checks, suiteRuns: suites.length, suiteFiles: files.length, skipped }
}

/**
 * Count claims in a file.
 *
 * @param {string} rel - repository-relative path.
 * @param {RegExp} pattern - must capture the number in group 1.
 * @param {string} what - label used in the failure message.
 * @param {number} expected - the real value.
 * @param {boolean} [asUpperBound] - when the current runtime skipped checks, the documented figure (from a full
 *   runtime) may exceed the measured one; require `documented >= measured` and a bounded gap instead of equality.
 */
function checkCount(rel, pattern, what, expected, asUpperBound = false) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  text.split('\n').forEach((line, index) => {
    const match = pattern.exec(line)
    if (match === null) return
    const documented = Number(match[1])
    const ok = asUpperBound ? documented >= expected && documented - expected <= 60 : documented === expected
    if (ok === false) {
      const expectation = asUpperBound ? `应 ≥ ${String(expected)}（本运行跳过了 zstd 相关检查）` : String(expected)
      problems.push(`${rel}:${String(index + 1)} 说 ${what} 是 ${match[1]}，${asUpperBound ? '' : '实际是 '}${expectation}\n    ${line.trim()}`)
    }
  })
}

const real = measure()
if (real.skipped === true) console.log(`注意：本运行缺少 zstd（Node ${process.version}），检查数比文档值少一部分；下界放宽并说明原因。`)
if (real.suiteFiles !== real.suiteRuns) {
  problems.push(`test/ 下有 ${String(real.suiteFiles)} 个套件文件，但 run.mjs 只跑了 ${String(real.suiteRuns)} 个 —— 某个套件没被登记`)
}
console.log(`实际：${String(real.suiteRuns)} 个套件，${String(real.checks)} 项检查`)

// 1) 套件数与检查数
for (const rel of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'test/README.md']) {
  checkCount(rel, /(\d+) suites?\b/, '套件数（suites）', real.suiteRuns)
  checkCount(rel, /(\d+) checks?\b/, '检查数（checks）', real.checks, real.skipped === true)
}
checkCount('README.zh.md', /(\d+) 个套件/, '套件数', real.suiteRuns)
checkCount('README.zh.md', /(\d+) 项检查/, '检查数', real.checks, real.skipped === true)

// 2) 声明的 dsh 范围必须出现在包 README 与仓库 README 里
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const range = manifest.engines.dsh
for (const rel of ['README.md']) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  if (text.includes(range) === false) problems.push(`${rel} 里没有出现声明的 dsh 范围 ${range}`)
}

// 2.5) README 的安装示例钉的版本必须就是当前版本（审阅抓到它停在 @1.7.0 而包已是 1.9.x）
for (const rel of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  const pinned = [...text.matchAll(/dsh-zcode-farm@(\d+\.\d+\.\d+)/g)].map((match) => match[1])
  for (const version of new Set(pinned)) {
    if (version !== manifest.version) {
      problems.push(`${rel} 的安装示例钉的是 @${version}，而包版本是 ${manifest.version}`)
    }
  }
}

// 3) SECURITY 的支持表第一行必须写当前版本
const security = readFileSync(join(REPO, 'SECURITY.md'), 'utf8')
const firstRow = security.split('\n').find((line) => line.startsWith('| `') && line.includes('Supported'))
if (firstRow === undefined) {
  problems.push('SECURITY.md 的支持表里找不到第一行')
} else if (firstRow.includes(`\`${manifest.version}\``) === false) {
  problems.push(`SECURITY.md 支持表的第一行不是当前版本 ${manifest.version}\n    ${firstRow.trim()}`)
}

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`✗ ${problem}`)
  console.error('')
  console.error(`文档数字与实际不一致：${String(problems.length)} 处。改文档，不要改检查（检查读的是真实运行结果）。`)
  process.exit(1)
}
console.log(`✓ 文档里的数字与实际一致（${String(real.suiteRuns)} 套件 / ${String(real.checks)} 项 / dsh ${range} / 版本 ${manifest.version}）`)
