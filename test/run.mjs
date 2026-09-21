#!/usr/bin/env node
/**
 * 跑 test/ 下所有 `*.test.mjs`，输出统一摘要。
 *
 * ⚠️ 输出格式被 `tools/verify-doc-numbers.mjs` 解析（它读 `结果: N 通过, M 失败`），
 * 改这里就等于改那道守卫的输入 —— 除非你同步改守卫，否则别动这行。
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

for (const file of files) {
  const run = spawnSync(process.execPath, ['--test', join(HERE, file)], { cwd: REPO, encoding: 'utf8' })
  const out = `${run.stdout || ''}${run.stderr || ''}`
  const pass = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? 0)
  const fail = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? 0)
  totalPass += pass
  totalFail += fail
  console.log(`  ${fail === 0 ? '✅' : '❌'} ${file}  (${pass} 通过, ${fail} 失败)`)
  if (fail > 0) {
    console.log(out.split('\n').filter((line) => !line.startsWith('    ')).join('\n'))
  }
}

console.log('')
console.log(`结果: ${totalPass} 通过, ${totalFail} 失败  (${files.length} 套件)`)
process.exit(totalFail === 0 ? 0 : 1)
