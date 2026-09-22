/**
 * ordering.test.mjs —— 「派发排序」的可重放对照。纯函数，不碰网络。
 *
 * 这里回答的是本插件最核心的一条主张：**「空闲显存 − 队列深度 × 权重」这个排序是有意义的**。
 * 在它之前，这条主张只有一次现场观测，而那一次「队列空」与「显存最多」恰好是同一台 ——
 * 也就是说那次观测**没有区分两种策略**。见 tools/ordering-replay.mjs 的表。
 *
 * 本套件把两件事钉住：
 *   甲 · 真实夹具下，换权重不改变答案（如实记录「那次观测无区分度」）
 *   乙 · 显存与队列对立时，交叉点可解析地算出来（12），并在两侧各验一次
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_POLICY, scoreAll, pickBest } from '../src/farm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELD = JSON.parse(readFileSync(join(HERE, 'fixtures', 'farm-snapshot-2026-09-21.json'), 'utf8'));

const snap = (over) => ({
  baseUrl: 'http://127.0.0.1:1',
  reachable: true,
  error: null,
  gpu: 'RTX 5090',
  vramTotalGb: 33.7,
  running: [],
  latencyMs: 0,
  ...over,
});

const replay = (instances, queueWeight) => {
  const policy = { ...DEFAULT_POLICY, queueWeight };
  const best = pickBest(scoreAll(instances.map(snap), policy));
  return best === null ? null : best.snap.id;
};

/** 构造对抗夹具：显存与队列对立。交叉点解析可算 —— A: 20 − 1×w，B: 8。 */
const CONFLICT = [
  { id: 'A-显存多但排队', vramFreeGb: 20.0, queueRunning: 1, queuePending: 0 },
  { id: 'B-显存少但队列空', vramFreeGb: 8.0, queueRunning: 0, queuePending: 0 },
];

test('甲 · 真实现场夹具：七种权重给出同一个答案（说明那次观测无区分度）', () => {
  const winners = [0, 1, 11.9, 12, 12.1, 100, 1000].map((w) => replay(FIELD.instances, w));
  assert.deepEqual([...new Set(winners)], ['gpu-18303']);
  // 那一刻「队列空」与「显存最多」是同一台 —— 所以这次观测证明不了「队列主导排序」。
  // 这条断言的价值就在于把这个事实钉住，免得日后有人拿它当证据。
  const only = FIELD.instances.find((i) => i.id === 'gpu-18303');
  assert.equal(only.queueRunning + only.queuePending, 0, '现场夹具里 gpu-18303 必须是队列空的');
  assert.ok(
    FIELD.instances.every((i) => i.id === 'gpu-18303' || i.vramFreeGb < only.vramFreeGb),
    '现场夹具里 gpu-18303 必须同时是显存最多的 —— 否则这条断言的前提就不成立，需换夹具重写',
  );
});

test('乙 · 构造对抗夹具：权重 < 12 时显存说话', () => {
  assert.equal(replay(CONFLICT, 0), 'A-显存多但排队');
  assert.equal(replay(CONFLICT, 11.9), 'A-显存多但排队');
});

test('乙 · 构造对抗夹具：权重 > 12 时队列说话', () => {
  assert.equal(replay(CONFLICT, 12.1), 'B-显存少但队列空');
  assert.equal(replay(CONFLICT, 1000), 'B-显存少但队列空');
});

test('乙 · 交叉点就是算出来的 12，不是拍出来的', () => {
  // A: 20 − 1×w；B: 8。相等处 w = 12。两侧各验一次即可夹住它。
  const a = (w) => 20 - 1 * w;
  assert.ok(a(11.9) > 8, `11.9 时应 A 领先，实际 ${a(11.9)} vs 8`);
  assert.ok(a(12.1) < 8, `12.1 时应 B 领先，实际 ${a(12.1)} vs 8`);
  assert.equal(a(12), 8, 'w=12 时两者相等 —— 平局由 pickBest 的「先到者胜」决定');
});

test('默认权重 1000 把队列变成压倒性判据（显存差异几乎被抹掉）', () => {
  // 显存差 12 GB，但一次排队 = 1000 GB 的惩罚 ⇒ 只要队列不同，显存怎么比都不重要。
  assert.ok(DEFAULT_POLICY.queueWeight > 100, `默认权重 ${DEFAULT_POLICY.queueWeight} 本应远大于任何显存差`);
  assert.equal(replay(CONFLICT, DEFAULT_POLICY.queueWeight), 'B-显存少但队列空');
});

test('相同输入重放两次结果一致（可重放，不是随机或依赖时序）', () => {
  assert.equal(replay(FIELD.instances, 1000), replay(FIELD.instances, 1000));
  assert.equal(replay(CONFLICT, 1000), replay(CONFLICT, 1000));
  assert.equal(replay(CONFLICT, 11.9), replay(CONFLICT, 11.9));
});

test('不适格的两条闸门：显存不够 / 队列过深，都不进候选', () => {
  // 显存不够 —— 即使队列是空的也不该被选中
  assert.equal(
    replay([
      { id: '空队列但显存不够', vramFreeGb: 7.9, queueRunning: 0, queuePending: 0 },
      { id: '显存够', vramFreeGb: 8.1, queueRunning: 0, queuePending: 0 },
    ], 1000),
    '显存够',
  );
  // 队列过深 —— 即使显存很多也不该被选中
  assert.equal(
    replay([
      { id: '显存多但队列深', vramFreeGb: 90, queueRunning: 2, queuePending: 2 },
      { id: '显存刚好够', vramFreeGb: 8.1, queueRunning: 0, queuePending: 0 },
    ], 1000),
    '显存刚好够',
  );
});

test('没有任何实例适格时返回 null，而不是硬选一个', () => {
  assert.equal(
    replay([
      { id: '不可达', reachable: false, error: 'timeout', vramFreeGb: 90 },
      { id: '显存不够', vramFreeGb: 1 },
    ], 1000),
    null,
  );
});
