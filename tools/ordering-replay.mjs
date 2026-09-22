#!/usr/bin/env node
/**
 * ordering-replay.mjs —— 把「派发排序」做成**可重放**的对照，而不是一次现场观测。
 *
 * 为什么需要它：`src/farm.js` 的评分是
 *
 *     score = vramFreeGb − queueDepth × queueWeight        （默认 queueWeight = 1000）
 *
 * 而这条策略至今只有**一次**现场观测（2026-09-21，见 test/fixtures/）。更要命的是：
 * **那一次里，「队列最空」和「显存最多」恰好是同一台**（gpu-18303，队列 0、空闲 99.4 GB）。
 * 也就是说 —— 那次观测**没有区分两种策略**，把它当成「队列主导排序」的证据是不成立的。
 *
 * 本工具用同一组数据在**多个权重**下重放，回答两件事：
 *   1. 真实夹具下，策略换与不换，答案是否一样？（不一样才叫有证据）
 *   2. 显存与队列**冲突**时，权重在哪里翻转结论？（给出交叉点，可解析计算）
 *
 * 用法：
 *   node tools/ordering-replay.mjs            # 打印对照表（可粘进 docs/MEASUREMENTS.md）
 *   node tools/ordering-replay.mjs --json     # 机器可读
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_POLICY, scoreAll, pickBest } from '../src/farm.js'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const AS_JSON = process.argv.includes('--json')

/** 现场夹具：真实读数。 */
const FIELD = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'farm-snapshot-2026-09-21.json'), 'utf8'))

/**
 * 对抗夹具：**构造的**（不为冒充真实数据，只为把策略逼到分岔处）。
 * 真实夹具里「空队列」与「大显存」是同一台，构造一组让它们对立的才有区分度。
 */
const CONFLICT = {
  note: '构造用例（非实测）：显存与队列互相对立，用来找策略的交叉点。',
  instances: [
    { id: 'A-显存多但排队', vramTotalGb: 33.7, vramFreeGb: 20.0, queueRunning: 1, queuePending: 0, running: [] },
    { id: 'B-显存少但队列空', vramTotalGb: 33.7, vramFreeGb: 8.0, queueRunning: 0, queuePending: 0, running: [] },
  ],
}

const WEIGHTS = [0, 1, 11.9, 12, 12.1, 100, 1000]

function toSnap(i) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    reachable: true,
    error: null,
    gpu: 'RTX 5090',
    latencyMs: 0,
    ...i,
  }
}

function replay(instances, queueWeight) {
  const policy = { ...DEFAULT_POLICY, queueWeight }
  const scored = scoreAll(instances.map(toSnap), policy)
  const best = pickBest(scored)
  return {
    queueWeight,
    winner: best === null ? null : best.snap.id,
    score: best === null ? null : Number(best.score.toFixed(2)),
    rows: scored.map((x) => ({
      id: x.snap.id,
      eligible: x.eligible,
      score: x.eligible ? Number(x.score.toFixed(2)) : null,
      reason: x.reason,
    })),
  }
}

const fieldRuns = WEIGHTS.map((w) => replay(FIELD.instances, w))
const conflictRuns = WEIGHTS.map((w) => replay(CONFLICT.instances, w))

if (AS_JSON) {
  console.log(JSON.stringify({ field: fieldRuns, conflict: conflictRuns }, null, 2))
  process.exit(0)
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('夹具甲 · 2026-09-21 真实现场（6 台，来自本插件自己的探针）')
console.log('  权重   含义                        选中        分数')
for (const r of fieldRuns) {
  const label = r.queueWeight === 1000 ? '默认：队列主导' : r.queueWeight === 0 ? '纯显存（无队列惩罚）' : ''
  console.log(`  ${padL(r.queueWeight, 5)}  ${pad(label, 26)}  ${pad(r.winner, 12)}${padL(r.score ?? '—', 8)}`)
}
const fieldWinners = new Set(fieldRuns.map((r) => r.winner))
console.log('')
console.log(
  fieldWinners.size === 1
    ? `  ⇒ 七种权重给出**同一个**答案（${[...fieldWinners][0]}）。这次现场观测**没有**区分两种策略：`
      + '\n    那一刻「队列空」和「显存最多」是同一台，所以它证明不了「队列主导排序」。'
    : `  ⇒ 不同权重给出不同答案：${[...fieldWinners].join(' / ')}`,
)

console.log('')
console.log('夹具乙 · 构造对抗用例（显存与队列对立，非实测）')
for (const row of conflictRuns[0].rows) {
  console.log(`  ${pad(row.id, 20)} 空闲 ${padL(row.score ?? '—', 6)} ↑该值随权重变，见下表`)
}
console.log('')
console.log('  权重   A-显存多但排队   B-显存少但队列空   选中')
for (const r of conflictRuns) {
  const a = r.rows.find((x) => x.id.startsWith('A'))
  const b = r.rows.find((x) => x.id.startsWith('B'))
  console.log(`  ${padL(r.queueWeight, 5)}  ${padL(a.score ?? '—', 15)}   ${padL(b.score ?? '—', 17)}   ${r.winner}`)
}
console.log('')
console.log('  ⇒ 交叉点在权重 12：A 的分数 20 − 1×w 与 B 的 8 相等处。')
console.log('    权重 < 12 时显存说话（A 胜），权重 > 12 时队列说话（B 胜），默认的 1000 把队列变成压倒性判据。')
console.log('')
console.log(`  可解析地验算：20 − 1×11.9 = ${(20 - 11.9).toFixed(2)} > 8 ⇒ A；20 − 1×12.1 = ${(20 - 12.1).toFixed(2)} < 8 ⇒ B。`)
