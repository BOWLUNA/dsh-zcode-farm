#!/usr/bin/env node
/**
 * 跑 test/ 下所有 `*.test.mjs`，输出统一摘要。
 *
 * ⚠️ 输出格式被 `tools/verify-doc-numbers.mjs` 解析（它读 `结果: N 通过, M 失败`），
 * 改这里就等于改那道守卫的输入 —— 除非你同步改守卫，否则别动这行。
 *
 * ⚠️ **reporter 必须钉死成 `tap`**。Node ≥ 24 的默认 reporter 变成了 `spec`
 * （即使 stdout 不是 TTY），摘要行由 `# pass 15` 变成 `ℹ pass 15`，下面的正则全部落空
 * → 每个套件都解析成「0 通过, 0 失败」，于是**测试全挂也打绿勾、exit 0**。
 *
 * 这不是理论风险，本仓库真的踩过：CI 红了 4 次（run 35633112168 / 35633208981 /
 * 35640664304 / 35642900617），而失败的是第 3 步「文档数字」，第 1 步「测试与检查数」
 * 在 Node 24 的腿上一直是**假绿**。守卫的报错还把人往「改文档、把 15 改成 0」上带 ——
 * 照做就等于把这道闸门永久关掉。文档里的 15 本来就是对的，错的是这里。
 *
 *   node test/run.mjs
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const files = readdirSync(HERE).filter((name) => name.endsWith('.test.mjs')).sort()

let totalPass = 0
let totalFail = 0
let unreadable = 0

for (const file of files) {
  // `--test-reporter=tap` 不能省：见文件头。省掉它，Node 24 上这里会静默变成假绿。
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(HERE, file)], { cwd: REPO, encoding: 'utf8' })
  const out = `${run.stdout || ''}${run.stderr || ''}`
  const pass = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? 0)
  const fail = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? 0)
  totalPass += pass
  totalFail += fail
  // 解析不出摘要 = 读不懂输出，而不是「没有测试」。这两件事必须分开：
  // 否则换一个 Node 版本就能让整道闸门失效，而且从输出上看不出来。
  if (/^# (pass|fail) \d+$/m.test(out) === false) {
    unreadable += 1
    console.log(`  ❌ ${file}  (结果无法解析 —— reporter 不是 tap？)`)
    console.log(out.split('\n').slice(0, 20).join('\n'))
    continue
  }
  console.log(`  ${fail === 0 ? '✅' : '❌'} ${file}  (${pass} 通过, ${fail} 失败)`)
  if (fail > 0) {
    console.log(out.split('\n').filter((line) => !line.startsWith('    ')).join('\n'))
  }
}

console.log('')
console.log(`结果: ${totalPass} 通过, ${totalFail} 失败  (${files.length} 套件)`)
if (unreadable > 0) {
  console.error(`\n有 ${String(unreadable)} 个套件的输出无法解析 —— 检查数不可信，按失败处理。`)
  process.exit(1)
}
// 一条检查都没收集到，绝不是「测试全过」。宁可红，也不要一个看起来干净的 0。
if (totalPass + totalFail === 0) {
  console.error('\n0 项检查被收集到 —— 这是解析或收集失败，不是「测试全过」。按失败处理。')
  process.exit(1)
}
process.exit(totalFail === 0 ? 0 : 1)
