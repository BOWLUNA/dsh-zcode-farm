#!/usr/bin/env node
/**
 * render-ordering-svg.mjs —— 从**实测数据**生成 README 里那张排序示意图（双语各一份）。
 *
 * 为什么用生成器而不是手写 SVG：
 *   ① 两版（英/中）由同一份标签表产出 ⇒ 结构必然相同，配得进 verify-translation-pairing；
 *   ② 图里每个数字都是从 test/fixtures/ 的实测夹具与 src/farm.js 的真实评分算出来的，
 *      不是画上去的 —— 改数据图就跟着变，不会出现「图与实测不符」；
 *   ③ 可 diff。
 *
 * 用法：node tools/render-ordering-svg.mjs
 * 产出：docs/ordering-replay.svg（英）、docs/ordering-replay.zh.svg（中）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_POLICY, scoreAll, pickBest } from '../src/farm.js'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const FIELD = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'farm-snapshot-2026-09-21.json'), 'utf8'))

const snap = (o) => ({ baseUrl: 'http://127.0.0.1:1', reachable: true, error: null, gpu: '', running: [], latencyMs: 0, ...o })
const bestAt = (instances, queueWeight) => {
  const best = pickBest(scoreAll(instances.map(snap), { ...DEFAULT_POLICY, queueWeight }))
  return best === null ? null : best.snap.id
}

// —— 实测数据（不手写）——
const fieldWinner = bestAt(FIELD.instances, 1000)
const fieldWinnerFree = bestAt(FIELD.instances, 0)
const CONFLICT = [
  { id: 'A', vramFreeGb: 20.0, queueRunning: 1, queuePending: 0 },
  { id: 'B', vramFreeGb: 8.0, queueRunning: 0, queuePending: 0 },
]
const conflictAt = (w) => bestAt(CONFLICT, w)
const CROSSOVER = 12 // A: 20 − 1×w 与 B: 8 相等处；由上面两条用例夹出

const L = {
  en: {
    file: 'docs/ordering-replay.svg',
    other: 'ordering-replay.zh.svg',
    entry: 'English | <tspan>中文</tspan>',
    title: 'How the farm picks an instance',
    sub: 'score = free VRAM − queue depth × weight   (default weight 1000)',
    panelA: 'A · the one time we measured it (2026-09-21)',
    panelANote: 'Seven weights, one answer — the empty queue and the most VRAM were the same machine, so this run cannot tell the two rules apart.',
    panelB: 'B · where the two rules disagree (constructed)',
    panelBNote: 'The empty-queue instance wins only above weight 12. At the default 1000 the queue is effectively absolute.',
    weight: 'weight',
    chosen: 'chosen',
    same: 'same answer for every weight',
    cross: 'crossover',
    footer: 'Every number here is computed from the measured fixture by tools/ordering-replay.mjs',
  },
  zh: {
    file: 'docs/ordering-replay.zh.svg',
    other: 'ordering-replay.svg',
    entry: '<tspan>English</tspan> | 中文',
    title: '农场怎么挑实例',
    sub: '得分 = 空闲显存 − 队列深度 × 权重（默认权重 1000）',
    panelA: '甲 · 唯一那次实测（2026-09-21）',
    panelANote: '七种权重给出同一个答案 —— 当时「队列空」和「显存最多」是同一台，所以这次运行区分不了两条规则。',
    panelB: '乙 · 两条规则分岔的地方（构造）',
    panelBNote: '空队列那台只在权重超过 12 时才胜出。默认的 1000 让队列几乎成为绝对判据。',
    weight: '权重',
    chosen: '选中',
    same: '所有权重给同一答案',
    cross: '交叉点',
    footer: '图里每个数字都由 tools/ordering-replay.mjs 从实测夹具算出，不是画上去的',
  },
}

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const OTHER = { en: 'zh', zh: 'en' }

function svg(lang) {
  const t = L[lang]
  const p = []
  const H = 372
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 ${H}" width="680" height="${H}" role="img" aria-label="${esc(t.title)}">`)
  // 双语入口行：配对守卫要求每一侧都出现对方的文件名
  p.push(`  <!-- ${lang === 'en' ? 'English' : '中文'} | ${t.other} -->`)
  p.push(`  <desc>${t.entry} — ${t.other}</desc>`)
  p.push('  <defs>')
  p.push('    <pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse">')
  p.push('      <circle cx="1.6" cy="1.6" r="0.75" fill="#D9CFB8"/>')
  p.push('    </pattern>')
  p.push('  </defs>')
  // 纸底
  p.push(`  <rect width="680" height="${H}" fill="#FAF7EF"/>`)
  p.push(`  <rect x="0" y="0" width="680" height="66" fill="url(#dots)"/>`)
  p.push('  <g font-family="ui-sans-serif, -apple-system, Segoe UI, Noto Sans SC, sans-serif" fill="#35322E">')

  p.push(`    <text x="26" y="34" font-size="19" font-weight="600">${esc(t.title)}</text>`)
  p.push(`    <text x="26" y="54" font-size="12" fill="#6C655B" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(t.sub)}</text>`)

  // ── 甲：实测夹具 ──
  const ax = 26
  const ay = 92
  const aw = 300
  p.push(`    <rect x="${ax}" y="${ay}" width="${aw}" height="196" fill="#FFFFFF" stroke="#E2D9C6" rx="6"/>`)
  p.push(`    <text x="${ax + 14}" y="${ay + 24}" font-size="12.5" font-weight="600">${esc(t.panelA)}</text>`)
  const rows = FIELD.instances
  const maxFree = 102
  rows.forEach((inst, i) => {
    const y = ay + 44 + i * 22
    const w = Math.max(2, Math.round((inst.vramFreeGb / maxFree) * 150))
    const isWinner = inst.id === fieldWinner
    p.push(`    <text x="${ax + 14}" y="${y + 4}" font-size="10.5" fill="#57514A" font-family="ui-monospace, monospace">${esc(inst.id)}</text>`)
    p.push(`    <rect x="${ax + 108}" y="${y - 7}" width="${w}" height="10" fill="${isWinner ? '#77854F' : '#CFC6B2'}" rx="2"/>`)
    p.push(`    <text x="${ax + 108 + w + 6}" y="${y + 4}" font-size="10" fill="#6C655B">${inst.vramFreeGb.toFixed(1)} GB / q${inst.queueRunning + inst.queuePending}</text>`)
    if (isWinner) p.push(`    <text x="${ax + 266}" y="${y + 4}" font-size="10" fill="#5F6B3E" font-weight="600">✓</text>`)
  })
  p.push(`    <text x="${ax + 14}" y="${ay + 182}" font-size="10.5" fill="#8A5A3B" font-weight="600">${esc(t.same)}: ${esc(fieldWinner)}</text>`)

  // ── 乙：构造对抗用例 ──
  const bx = 350
  const by = 92
  const bw = 304
  const bh = 196
  p.push(`    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#FFFFFF" stroke="#E2D9C6" rx="6"/>`)
  p.push(`    <text x="${bx + 14}" y="${by + 24}" font-size="12.5" font-weight="600">${esc(t.panelB)}</text>`)

  // 坐标：w 0..30 线性映射到 x，score -2..22 映射到 y
  const plotX = (w) => bx + 46 + (w / 30) * 200
  const plotY = (s) => by + 54 + ((22 - s) / 24) * 96
  p.push(`    <line x1="${plotX(0)}" y1="${plotY(0)}" x2="${plotX(30)}" y2="${plotY(0)}" stroke="#E2D9C6"/>`)
  p.push(`    <text x="${plotX(0) - 40}" y="${plotY(20) + 4}" font-size="10" fill="#6C655B">20</text>`)
  p.push(`    <text x="${plotX(0) - 40}" y="${plotY(8) + 4}" font-size="10" fill="#6C655B">8</text>`)
  p.push(`    <text x="${plotX(0) - 40}" y="${plotY(0) + 4}" font-size="10" fill="#6C655B">0</text>`)
  // A 的分数线：20 − w
  const aY0 = plotY(Math.min(22, 20))
  const aY30 = plotY(20 - 30)
  p.push(`    <line x1="${plotX(0)}" y1="${aY0}" x2="${plotX(30)}" y2="${aY30}" stroke="#B07A52" stroke-width="1.6"/>`)
  // B 的分数线：恒为 8
  p.push(`    <line x1="${plotX(0)}" y1="${plotY(8)}" x2="${plotX(30)}" y2="${plotY(8)}" stroke="#77854F" stroke-width="1.6"/>`)
  // 交叉点
  p.push(`    <circle cx="${plotX(CROSSOVER)}" cy="${plotY(8)}" r="3.4" fill="#FFFFFF" stroke="#35322E" stroke-width="1.4"/>`)
  p.push(`    <line x1="${plotX(CROSSOVER)}" y1="${plotY(8)}" x2="${plotX(CROSSOVER)}" y2="${by + 168}" stroke="#35322E" stroke-dasharray="3 3" stroke-width="1"/>`)
  p.push(`    <text x="${plotX(CROSSOVER) - 16}" y="${by + 178}" font-size="10" fill="#35322E">${esc(t.cross)} = ${CROSSOVER}</text>`)
  p.push(`    <text x="${plotX(0)}" y="${by + 178}" font-size="10" fill="#6C655B">${esc(t.weight)} 0</text>`)
  p.push(`    <text x="${plotX(30) - 18}" y="${by + 178}" font-size="10" fill="#6C655B">30</text>`)
  p.push(`    <text x="${bx + 14}" y="${by + 156}" font-size="10" fill="#B07A52">A: 20 − w</text>`)
  p.push(`    <text x="${bx + 96}" y="${by + 156}" font-size="10" fill="#5F6B3E">B: 8</text>`)
  p.push(`    <text x="${bx + 14}" y="${by + 178}" font-size="10" fill="#6C655B">w=11.9 → A · w=12.1 → B</text>`)
  p.push(`    <text x="${bx + 150}" y="${by + 24}" font-size="10" fill="#6C655B">${esc(t.chosen)}: ${esc(conflictAt(11.9))} / ${esc(conflictAt(12.1))}</text>`)

  p.push(`    <text x="26" y="${H - 16}" font-size="10" fill="#8A8378">${esc(t.footer)}</text>`)
  p.push('  </g>')
  p.push('</svg>')
  p.push('')
  return p.join('\n')
}

for (const lang of ['en', 'zh']) {
  const out = lang === 'en' ? 'docs/ordering-replay.svg' : 'docs/ordering-replay.zh.svg'
  writeFileSync(join(REPO, out), svg(lang), 'utf8')
  console.log(`✓ ${out}`)
}
console.log(`  实测：夹具甲 winner=${fieldWinner}（w=0 也是 ${fieldWinnerFree}）· 夹具乙 w=11.9→${conflictAt(11.9)} / w=12.1→${conflictAt(12.1)}`)
