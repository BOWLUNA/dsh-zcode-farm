/**
 * farm.js —— 农场内核：探测多个 ComfyUI 实例、按负载评分、选出该派发给谁。
 *
 * 设计立场（与 dsh-comfyui 的分工）：
 *   dsh-comfyui  管「一个」端点的深度体验——工作流库、技能包、画布、资产面板。
 *   本插件       管「很多个」端点的调度——谁在线、谁空闲、这活该派给谁。
 * 两者可共存，也可各自独立使用。
 *
 * 零运行时依赖：只用 Node 内置的 fetch / AbortController（Node >= 22）。
 */

/** 默认策略。可由插件 Config 覆盖。 */
export const DEFAULT_POLICY = {
  needVramGb: 8, // 派发所需的最小空闲显存
  maxQueueDepth: 3, // 队列深到此值即不考虑
  queueWeight: 1000, // 评分中每个排队任务的惩罚（让队列主导排序，显存作平局决胜）
  probeTimeoutMs: 3000, // 单个实例的探测超时
};

/**
 * 探测单个实例。
 * `system_stats` 是硬条件（失败即视为不可达）；`queue` 拿不到不致命，降级为 0。
 */
export async function probeInstance(inst, policy = DEFAULT_POLICY) {
  const t0 = Date.now();
  const maxAttempts = (policy.probeRetries ?? 1) + 1;
  const snap = {
    id: inst.id,
    baseUrl: inst.baseUrl,
    label: inst.label ?? null,
    kind: inst.kind ?? 'tunnel',
    reachable: false,
    error: null,
    attempts: 0,
    gpu: null,
    vramTotalGb: 0,
    vramFreeGb: 0,
    queueRunning: 0,
    queuePending: 0,
    running: [],
    comfyuiVersion: null,
    latencyMs: 0,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    snap.attempts = attempt;
    try {
      const stats = await fetchJson(`${inst.baseUrl}/system_stats`, policy.probeTimeoutMs);
      // queue 拿不到不致命：可达性与显存已经建立，队列降级为 0
      const queue = await fetchJson(`${inst.baseUrl}/queue`, policy.probeTimeoutMs).catch(() => null);

      snap.reachable = true;
      snap.error = null;
      const dev = (stats.devices || [])[0] || {};
      snap.gpu = dev.name || 'unknown';
      snap.vramTotalGb = (dev.vram_total || 0) / 1e9;
      snap.vramFreeGb = (dev.vram_free || 0) / 1e9;
      snap.comfyuiVersion = stats.system?.comfyui_version ?? null;

      if (queue) {
        const running = queue.queue_running || [];
        snap.queueRunning = running.length;
        snap.queuePending = (queue.queue_pending || []).length;
        snap.running = running.map(describeRunningJob);
      }
      break;
    } catch (err) {
      // 跨 SSH 隧道的偶发抖动很常见：本机实测同一台机器上一次探测 >3s 超时、
      // 紧接着一次 106ms 就回来。所以单次失败不当结论——重试后再判定，
      // 并把 attempts 一并报出去，让 Agent 能区分「真宕机」和「抖了一下」。
      snap.error = err?.name === 'AbortError'
        ? `超时（>${policy.probeTimeoutMs}ms）`
        : err?.message || String(err);
      if (attempt < maxAttempts) await sleep(policy.probeRetryDelayMs ?? 400);
    }
  }

  snap.latencyMs = Date.now() - t0;
  return snap;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 并发探测全部实例。失败不抛错，降级为一条 unreachable 快照。 */
export async function probeAll(instances, policy = DEFAULT_POLICY) {
  return Promise.all(instances.map((i) => probeInstance(i, policy)));
}

/**
 * 从队列条目里推断「在跑什么」——给 Agent 一条可读线索，而不是一串数字。
 * 粗判依据：出现视频/音频系节点就标出来（本机在跑的就是 MiniMax-H3 那一类）。
 */
export function describeRunningJob(entry) {
  const prompt = Array.isArray(entry) ? entry[2] : null;
  if (!prompt || typeof prompt !== 'object') return 'unknown';
  const classTypes = Object.values(prompt)
    .map((node) => (node && typeof node === 'object' ? node.class_type : null))
    .filter(Boolean);

  if (classTypes.some((t) => /WanVideo|MiniMax|H3|SaveAnimated|VHS_|VideoCombine/i.test(t))) {
    return `video/audio (${classTypes.length} 节点)`;
  }
  const loader = classTypes.find((t) => /CheckpointLoader|UNETLoader/i.test(t));
  return loader ? `image (${loader})` : `graph (${classTypes[0] || 'unknown'})`;
}

/**
 * 给一个实例打分。
 * 返回 { eligible, score, reason }；score 越大越该被选中。
 */
export function scoreInstance(snap, policy = DEFAULT_POLICY) {
  if (!snap.reachable) {
    return { eligible: false, score: -Infinity, reason: `不可达：${snap.error || 'unknown'}` };
  }
  if (snap.vramFreeGb < policy.needVramGb) {
    return {
      eligible: false,
      score: -Infinity,
      reason: `空闲显存 ${snap.vramFreeGb.toFixed(1)} GB < 需要 ${policy.needVramGb} GB`,
    };
  }
  const depth = snap.queueRunning + snap.queuePending;
  if (depth > policy.maxQueueDepth) {
    return { eligible: false, score: -Infinity, reason: `队列深 ${depth} > 上限 ${policy.maxQueueDepth}` };
  }
  const score = snap.vramFreeGb - depth * policy.queueWeight;
  const why = depth === 0 ? '队列空' : `队列深 ${depth}`;
  return { eligible: true, score, reason: `${why}、空闲 ${snap.vramFreeGb.toFixed(1)} GB` };
}

/** 对全部快照评分。 */
export function scoreAll(snaps, policy = DEFAULT_POLICY) {
  return snaps.map((snap) => ({ snap, ...scoreInstance(snap, policy) }));
}

/** 从已评分的列表里挑最优；没有可用实例则返回 null。 */
export function pickBest(scored) {
  const eligible = scored.filter((x) => x.eligible);
  if (!eligible.length) return null;
  return eligible.reduce((a, b) => (b.score > a.score ? b : a));
}

/** 人类可读的状态表（给工具输出用）。 */
export function renderStatusTable(scored, policy = DEFAULT_POLICY) {
  const best = pickBest(scored);
  const lines = [];
  lines.push(`策略：需要空闲显存 >= ${policy.needVramGb} GB，队列深 <= ${policy.maxQueueDepth}`);
  lines.push('');
  lines.push('  实例             GPU                       空闲/总显存      队列(跑/等)  在跑什么                 判定');
  lines.push('  ──────────────── ───────────────────────── ──────────────── ──────────── ──────────────────────── ────────────────');

  for (const item of scored) {
    const { snap: s } = item;
    if (!s.reachable) {
      lines.push(`  ${s.id.padEnd(16)} ${'(不可达)'.padEnd(25)} ${'—'.padEnd(16)} ${'—'.padEnd(12)} ${'—'.padEnd(24)} ✖ ${s.error}`);
      continue;
    }
    const gpu = (s.gpu || 'unknown').slice(0, 24);
    const vram = `${s.vramFreeGb.toFixed(1)} / ${s.vramTotalGb.toFixed(1)}`;
    const q = `${s.queueRunning} / ${s.queuePending}`;
    const running = (s.running.join(', ') || '—').slice(0, 24);
    let verdict;
    if (!item.eligible) verdict = `✖ ${item.reason}`;
    else if (best && best.snap.id === s.id) verdict = '✅ 最优';
    else verdict = '○ 可用';
    lines.push(`  ${s.id.padEnd(16)} ${gpu.padEnd(25)} ${vram.padEnd(16)} ${q.padEnd(12)} ${running.padEnd(24)} ${verdict}`);
  }
  return lines.join('\n');
}

/** 给 system prompt 注入的紧凑单行快照——让模型从第一条消息就知道农场的存在。 */
export function renderStatusInline(scored) {
  const usable = scored.filter((x) => x.snap.reachable);
  if (!usable.length) return 'ComfyUI 农场：当前没有任何实例可达。';
  const best = pickBest(scored);
  const parts = usable.map((x) => {
    const s = x.snap;
    const flag = x.eligible ? '' : '(忙)';
    return `${s.id}=${s.vramFreeGb.toFixed(0)}GB空闲/队列${s.queueRunning + s.queuePending}${flag}`;
  });
  const head = `ComfyUI 农场（${usable.length}/${scored.length} 在线）：${parts.join('、')}。`;
  const tail = best ? ` 当前最空闲：${best.snap.id}。` : ' 当前无实例满足派发条件。';
  return head + tail;
}

async function fetchJson(url, timeoutMs) {
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
