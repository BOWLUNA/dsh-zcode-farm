#!/usr/bin/env node
/**
 * probe-farm.mjs —— 验证 dsh-zcode-farm 的内核：多实例状态探测 + 负载感知选实例。
 *
 * 不依赖 DSH、不依赖任何 npm 包，直接跑：
 *   node probes/probe-farm.mjs
 *   node probes/probe-farm.mjs --need-vram 60      # 模拟需要 60 GB 显存的任务
 *   node probes/probe-farm.mjs --ports 18100,18301
 *
 * 为什么需要这个探针：`dsh-comfyui`（77★，本机已装）的配置只有单一 `baseUrl`，
 * Agent 只能看见一个端点。本机实测有 5 条隧道同时在线，其中 2 台几乎全空
 * （合计 132 GB 空闲），而 focus-proxy 恰好指向最忙的那台。探针用来证明
 * 「Agent 需要、也能够看见整个农场」。
 */

// ---- 实例清单：默认取自本机 ~/gpusever 的隧道端口分配 ----
const DEFAULT_INSTANCES = [
  { id: 'focus', baseUrl: 'http://127.0.0.1:8188', label: 'focus-proxy 当前指向', kind: 'focus' },
  { id: 'gpu-18100', baseUrl: 'http://127.0.0.1:18100' },
  { id: 'gpu-18300', baseUrl: 'http://127.0.0.1:18300' },
  { id: 'gpu-18301', baseUrl: 'http://127.0.0.1:18301' },
  { id: 'gpu-18302', baseUrl: 'http://127.0.0.1:18302' },
  { id: 'gpu-18303', baseUrl: 'http://127.0.0.1:18303' },
];

// ---- 选实例的策略参数 ----
const POLICY = {
  needVramGb: 8,      // 任务需要的最小空闲显存
  maxQueueDepth: 3,   // 队列深到此值就不考虑
  queueWeight: 1000,  // 评分里每个排队任务的惩罚（让"队列"主导排序）
};

function parseArgs(argv) {
  const out = { needVram: POLICY.needVramGb, ports: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--need-vram') out.needVram = Number(argv[++i]);
    else if (a === '--ports') out.ports = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') out.json = true;
  }
  if (out.ports) {
    out.instances = out.ports.map((p) => ({ id: `port-${p}`, baseUrl: `http://127.0.0.1:${p}` }));
  }
  return out;
}

async function fetchJson(url, timeoutMs = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 从 ComfyUI 的 queue 条目里尽量推断"在跑什么"——给 Agent 看的可读线索。 */
function describeRunningJob(entry) {
  const prompt = Array.isArray(entry) ? entry[2] : null;
  if (!prompt || typeof prompt !== 'object') return 'unknown';
  const classTypes = Object.values(prompt)
    .map((node) => (node && typeof node === 'object' ? node.class_type : null))
    .filter(Boolean);
  const joined = classTypes.join(' ');
  // 粗判：出现视频/音频系节点就标出来（本机在跑的 MiniMax-H3 就是这一类）
  if (/WanVideo|MiniMax|H3|SaveAnimated|VHS_|VideoCombine|SamplerCustomAdvanced.*video/i.test(joined)) {
    return `video/audio (${classTypes.length} nodes)`;
  }
  const cp = classTypes.find((t) => /CheckpointLoader|UNETLoader/i.test(t));
  return cp ? `image (${cp})` : `graph (${classTypes[0] || 'unknown'})`;
}

async function probeInstance(inst, timeoutMs) {
  const t0 = Date.now();
  const snap = {
    id: inst.id,
    baseUrl: inst.baseUrl,
    label: inst.label || null,
    kind: inst.kind || 'tunnel',
    reachable: false,
    error: null,
    gpu: null,
    vramTotalGb: 0,
    vramFreeGb: 0,
    queueRunning: 0,
    queuePending: 0,
    running: [],
    comfyuiVersion: null,
    latencyMs: 0,
  };
  try {
    // stats 是硬条件（拿不到就算不可达）；queue 拿不到不致命，降级为 0
    const stats = await fetchJson(`${inst.baseUrl}/system_stats`, timeoutMs);
    const queue = await fetchJson(`${inst.baseUrl}/queue`, timeoutMs).catch(() => null);

    snap.reachable = true;
    const dev = (stats.devices || [])[0] || {};
    snap.gpu = dev.name || 'unknown';
    snap.vramTotalGb = (dev.vram_total || 0) / 1e9;
    snap.vramFreeGb = (dev.vram_free || 0) / 1e9;
    snap.comfyuiVersion = stats.system?.comfyui_version || null;
    if (queue) {
      const running = queue.queue_running || [];
      snap.queueRunning = running.length;
      snap.queuePending = (queue.queue_pending || []).length;
      snap.running = running.map(describeRunningJob);
    }
  } catch (err) {
    snap.error = err?.name === 'AbortError' ? `timeout >${timeoutMs}ms` : err?.message || String(err);
  }
  snap.latencyMs = Date.now() - t0;
  return snap;
}

/**
 * 给一个实例打分。返回 { eligible, score, reason }。
 * 评分 = 空闲显存 - 队列惩罚：队列深度主导（每个排队任务扣 1000），显存作平局决胜。
 */
function scoreInstance(snap, policy) {
  if (!snap.reachable) return { eligible: false, score: -Infinity, reason: `不可达：${snap.error || 'unknown'}` };
  if (snap.vramFreeGb < policy.needVramGb) {
    return { eligible: false, score: -Infinity, reason: `空闲显存 ${snap.vramFreeGb.toFixed(1)} GB < 需要 ${policy.needVramGb} GB` };
  }
  const depth = snap.queueRunning + snap.queuePending;
  if (depth > policy.maxQueueDepth) {
    return { eligible: false, score: -Infinity, reason: `队列深 ${depth} > 上限 ${policy.maxQueueDepth}` };
  }
  const score = snap.vramFreeGb - depth * policy.queueWeight;
  const why = depth === 0 ? '队列空' : `队列深 ${depth}`;
  return { eligible: true, score, reason: `${why}、空闲 ${snap.vramFreeGb.toFixed(1)} GB` };
}

function fmtGb(n) {
  return n.toFixed(1).padStart(5);
}

async function main() {
  const args = parseArgs(process.argv);
  const instances = args.instances || DEFAULT_INSTANCES;
  const policy = { ...POLICY, needVramGb: args.needVram };

  const snaps = await Promise.all(instances.map((i) => probeInstance(i, 3000)));
  const scored = snaps.map((s) => ({ snap: s, ...scoreInstance(s, policy) }));

  if (args.json) {
    console.log(JSON.stringify({ policy, instances: scored }, null, 2));
    return;
  }

  console.log('');
  console.log('=== dsh-zcode-farm · 农场状态 ===');
  console.log(`策略：需要空闲显存 >= ${policy.needVramGb} GB，队列深 <= ${policy.maxQueueDepth}`);
  console.log('');
  console.log('  实例            GPU                        空闲/总显存      队列(跑/等)  在跑什么              判定');
  console.log('  ─────────────── ────────────────────────── ─────────────── ──────────── ───────────────────── ──────────────');
  for (const { snap: s } of scored) {
    if (!s.reachable) {
      console.log(`  ${s.id.padEnd(15)} ${'(不可达)'.padEnd(26)} ${'-'.padEnd(15)} ${'-'.padEnd(12)} ${'-'.padEnd(21)} ❌ ${s.error}`);
      continue;
    }
    const gpu = (s.gpu || 'unknown').slice(0, 26);
    const vram = `${fmtGb(s.vramFreeGb)} / ${fmtGb(s.vramTotalGb)}`;
    const q = `${s.queueRunning} / ${s.queuePending}`;
    const running = (s.running.join(', ') || '—').slice(0, 21);
    const v = scored.find((x) => x.snap === s);
    const verdict = v.eligible ? (v.snap.id === pickBest(scored)?.snap.id ? '✅ 最优' : '○ 可用') : '✖ ' + v.reason.slice(0, 24);
    console.log(`  ${s.id.padEnd(15)} ${gpu.padEnd(26)} ${vram.padEnd(15)} ${q.padEnd(12)} ${running.padEnd(21)} ${verdict}`);
  }

  const best = pickBest(scored);
  console.log('');
  if (best) {
    console.log(`👉 建议派发到：${best.snap.id}  (${best.snap.baseUrl})`);
    console.log(`   理由：${best.reason}；评分 ${best.score.toFixed(1)}`);
    if (best.snap.kind === 'focus') {
      console.log('   注意：这是 focus-proxy 的转发口，实际落到哪台取决于 ~/gpusever/tmp/focus.target。');
    }
  } else {
    console.log('❌ 没有任何实例满足约束——需要等队列变短，或放宽 needVram / maxQueueDepth。');
    const focus = scored.find((x) => x.snap.kind === 'focus');
    if (focus && focus.snap.reachable) {
      console.log(`   当前 focus-proxy 指向的实例只有 ${focus.snap.vramFreeGb.toFixed(1)} GB 空闲，` +
        `而它正是 dsh-comfyui 会用的那一个。这就是本插件存在的理由。`);
    }
  }
  console.log('');
}

function pickBest(scored) {
  const eligible = scored.filter((x) => x.eligible);
  if (!eligible.length) return null;
  return eligible.reduce((a, b) => (b.score > a.score ? b : a));
}

main().catch((err) => {
  console.error('探针失败：', err);
  process.exit(1);
});
