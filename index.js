/**
 * dsh-zcode-farm —— 让 DeepSeek Harness 的 Agent 看见整个 ComfyUI 农场，并把活派给最闲的那台。
 *
 * 解决的问题（本机实测的原始证据）：
 *   `dsh-comfyui` 只能连一个端点，而本机同时有 6 条隧道在线。实测那一刻，
 *   5 台 RTX 5090 都在跑视频工作流、显存只剩 0.5–0.9 GB，唯独一台 102 GB 的
 *   Blackwell 完全空闲——但 Agent 对此一无所知，只能撞上最忙的那台。
 *
 * 分工：dsh-comfyui 管「一个端点」的深度体验（工作流库 / 技能包 / 资产面板）；
 *       本插件管「很多端点」的调度（谁在线、谁空闲、这活派给谁）。两者可共存。
 */

import { Config } from './src/config.js';
import {
  DEFAULT_POLICY,
  probeAll,
  scoreAll,
  pickBest,
  renderStatusTable,
} from './src/farm.js';
import { buildTxt2Img, collectOutputs } from './src/workflow.js';

export const name = 'dsh-zcode-farm';
export const inject = ['tools'];
export { Config };

/**
 * 把配置里的 `primaryUrl` 与 `instances` 合成一份去重后的成员表。
 * primaryUrl 排在最前，`id` 固定为 `primary`（本机上它就是 focus-proxy 的转发口）。
 */
export function resolveInstances(config) {
  const list = [];
  const seen = new Set();

  const primary = String(config.primaryUrl || '').trim().replace(/\/+$/, '');
  if (primary) {
    list.push({ id: 'primary', baseUrl: primary, label: '主端点（primaryUrl）', kind: 'primary' });
    seen.add(primary);
  }

  for (const item of config.instances || []) {
    const baseUrl = String(item.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl || seen.has(baseUrl)) continue;
    seen.add(baseUrl);
    list.push({
      id: item.id || baseUrl,
      baseUrl,
      label: item.label || '',
      kind: item.kind || 'tunnel',
    });
  }

  return list;
}

export function apply(ctx, config) {
  const policy = {
    ...DEFAULT_POLICY,
    needVramGb: config.needVramGb,
    maxQueueDepth: config.maxQueueDepth,
    queueWeight: config.queueWeight,
    probeTimeoutMs: config.probeTimeoutMs,
  };
  const runtime = { config, policy, instances: resolveInstances(config) };

  ctx.logger?.info?.(
    `comfyui-farm: ${runtime.instances.length} 个成员待探测` +
    (runtime.instances.length > 1 ? `（${runtime.instances.map((i) => i.id).join(', ')}）` : ''),
  );

  const disposers = [
    ctx.tools.register(statusTool(runtime)),
    ctx.tools.register(pickTool(runtime)),
    ctx.tools.register(runTool(runtime)),
  ];

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose?.();
  }, 'dsh-zcode-farm: tools');
}

// ---------------------------------------------------------------- 工具 1：status

function statusTool(runtime) {
  return {
    name: 'comfyui_farm_status',
    description:
      'Show every ComfyUI instance in the farm with live GPU / free-VRAM / queue state, and which one is the best target right now. ' +
      'Call this before dispatching when you are unsure which instance is free. ' +
      '显示整个 ComfyUI 农场的实时状态：每台的 GPU、空闲显存、队列深度、在跑什么，以及当前最该派给谁。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 30_000,
    async execute() {
      const scored = scoreAll(await probeAll(runtime.instances, runtime.policy), runtime.policy);
      const best = pickBest(scored);
      const online = scored.filter((x) => x.snap.reachable).length;

      const tail = best
        ? `\n\n👉 建议派发到：${best.snap.id}（${best.snap.baseUrl}）\n   理由：${best.reason}`
        : `\n\n❌ 当前没有实例满足派发条件（需要空闲显存 >= ${runtime.policy.needVramGb} GB、队列深 <= ${runtime.policy.maxQueueDepth}）。` +
          `\n   可以调大 needVramGb 之外的办法：等队列变短，或用 comfyui_farm_run 指定 instanceId 强行派发。`;

      return {
        total: scored.length,
        online,
        best: best ? { id: best.snap.id, baseUrl: best.snap.baseUrl, reason: best.reason } : null,
        instances: scored.map((x) => ({
          id: x.snap.id,
          baseUrl: x.snap.baseUrl,
          label: x.snap.label,
          reachable: x.snap.reachable,
          error: x.snap.error,
          gpu: x.snap.gpu,
          vramFreeGb: Number(x.snap.vramFreeGb.toFixed(2)),
          vramTotalGb: Number(x.snap.vramTotalGb.toFixed(2)),
          queueRunning: x.snap.queueRunning,
          queuePending: x.snap.queuePending,
          running: x.snap.running,
          eligible: x.eligible,
          verdict: x.eligible ? 'ok' : x.reason,
        })),
        text: renderStatusTable(scored, runtime.policy) + tail,
      };
    },
  };
}

// ---------------------------------------------------------------- 工具 2：pick

function pickTool(runtime) {
  return {
    name: 'comfyui_farm_pick',
    description:
      'Choose the best ComfyUI instance for a job, with the reason why, without running anything. ' +
      'Supports a VRAM requirement, a queue-depth ceiling, a GPU-name substring, and an exclude list. ' +
      '只做选择、不执行：按显存需求 / 队列上限 / GPU 型号关键字 / 排除名单，挑出最合适的实例并给出理由。',
    parameters: {
      type: 'object',
      properties: {
        needVramGb: { type: 'number', description: '本次任务需要的最小空闲显存（GB）' },
        maxQueueDepth: { type: 'number', description: '可接受的队列深度上限' },
        gpuHint: { type: 'string', description: 'GPU 名称关键字（不区分大小写），如 "5090"、"PRO 6000"' },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: '要排除的实例 id 列表（例如已经在跑批的那几台）',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 30_000,
    async execute(args) {
      const policy = {
        ...runtime.policy,
        needVramGb: typeof args.needVramGb === 'number' ? args.needVramGb : runtime.policy.needVramGb,
        maxQueueDepth: typeof args.maxQueueDepth === 'number' ? args.maxQueueDepth : runtime.policy.maxQueueDepth,
      };
      const exclude = new Set((args.exclude || []).map((s) => String(s)));
      const hint = typeof args.gpuHint === 'string' ? args.gpuHint.trim().toLowerCase() : '';

      let scored = scoreAll(await probeAll(runtime.instances, policy), policy);
      if (exclude.size) scored = scored.filter((x) => !exclude.has(x.snap.id));
      if (hint) {
        // 只对「本来就合格」的实例做型号筛选。不可达 / 显存不足的必须保留原原因，
        // 否则错误信息会被改写成「GPU 不匹配」，把真正的问题（比如隧道断了）藏起来。
        scored = scored.map((x) =>
          x.eligible && !(x.snap.gpu || '').toLowerCase().includes(hint)
            ? { ...x, eligible: false, reason: `GPU 不匹配 "${args.gpuHint}"（实际 ${x.snap.gpu}）` }
            : x,
        );
      }

      const best = pickBest(scored);
      const text = best
        ? `选中：${best.snap.id}（${best.snap.baseUrl}）\n` +
          `理由：${best.reason}\n` +
          `GPU：${best.snap.gpu}｜空闲 ${best.snap.vramFreeGb.toFixed(1)} / ${best.snap.vramTotalGb.toFixed(1)} GB｜队列 ${best.snap.queueRunning} 跑 / ${best.snap.queuePending} 等\n\n` +
          `其余候选：\n` +
          scored
            .filter((x) => x.snap.id !== best.snap.id)
            .map((x) => `  - ${x.snap.id}：${x.eligible ? x.reason : '✖ ' + x.reason}`)
            .join('\n')
        : `没有实例满足条件。逐条原因：\n` +
          scored.map((x) => `  - ${x.snap.id}：${x.reason}`).join('\n');

      return {
        picked: best ? best.snap.id : null,
        baseUrl: best ? best.snap.baseUrl : null,
        reason: best ? best.reason : null,
        candidates: scored.map((x) => ({ id: x.snap.id, eligible: x.eligible, reason: x.reason })),
        text,
      };
    },
  };
}

// ---------------------------------------------------------------- 工具 3：run

function runTool(runtime) {
  return {
    name: 'comfyui_farm_run',
    description:
      'Dispatch a generation job to the idlest ComfyUI instance in the farm. ' +
      'Give either a raw API-format `workflow`, or a quick text-to-image request (`prompt` + `checkpoint`). ' +
      'Omit `instanceId` to let the farm pick; pass it to force a specific instance. ' +
      '把生成任务派给农场里最空闲的实例。可以给完整的 API 格式工作流，也可以只给提示词+模型走内置文生图模板。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '正向提示词（未提供 workflow 时使用内置 txt2img 模板）' },
        negative: { type: 'string', description: '负向提示词' },
        checkpoint: { type: 'string', description: 'checkpoint 文件名，如 "sd3.5_large.safetensors"' },
        workflow: { type: 'object', description: 'API 格式工作流 JSON；提供后忽略 prompt/checkpoint/尺寸参数' },
        instanceId: { type: 'string', description: '指定实例 id；不填则自动选最空闲的一台' },
        needVramGb: { type: 'number', description: '覆盖本次的显存门槛（GB）' },
        width: { type: 'number', description: '宽度（内置模板用）' },
        height: { type: 'number', description: '高度（内置模板用）' },
        steps: { type: 'number', description: '采样步数（内置模板用）' },
        seed: { type: 'number', description: '随机种子，0 表示随机' },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'sync=等到出图再返回（默认）；async=只提交并返回 promptId，适合长任务',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: runtime.config.requestTimeoutMs + 60_000,
    async execute(args, exec) {
      const needsVram = typeof args.needVramGb === 'number'
        ? { ...runtime.policy, needVramGb: args.needVramGb }
        : runtime.policy;

      // 1) 选定目标
      let target;
      if (args.instanceId) {
        target = runtime.instances.find((i) => i.id === args.instanceId);
        if (!target) {
          throw new Error(
            `未知的实例 id "${args.instanceId}"。可用：${runtime.instances.map((i) => i.id).join(', ')}`,
          );
        }
      } else {
        const scored = scoreAll(await probeAll(runtime.instances, needsVram), needsVram);
        const best = pickBest(scored);
        if (!best) {
          const why = scored.map((x) => `  - ${x.snap.id}：${x.reason}`).join('\n');
          throw new Error(
            `没有实例能承接这个任务（需要空闲显存 >= ${needsVram.needVramGb} GB、队列深 <= ${needsVram.maxQueueDepth}）：\n${why}\n` +
            `可改用 instanceId 指定某台强行派发，或等待队列变短。`,
          );
        }
        target = best.snap;
      }

      // 2) 构造工作流
      const workflow = args.workflow
        ? args.workflow
        : buildTxt2Img({
            prompt: args.prompt || '',
            negative: args.negative || '',
            checkpoint: args.checkpoint || 'v1-5-pruned-emaonly.safetensors',
            width: args.width ?? 1024,
            height: args.height ?? 1024,
            steps: args.steps ?? 25,
            seed: args.seed ?? 0,
          });

      if (!args.workflow && !args.prompt) {
        throw new Error('需要提供 workflow，或者提供 prompt（走内置文生图模板）。');
      }

      // 3) 提交
      const clientId = `dsh-farm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queued = await postJson(`${target.baseUrl}/prompt`, { prompt: workflow, client_id: clientId }, 30_000, exec?.signal);
      const promptId = queued?.prompt_id;
      if (!promptId) throw new Error(`提交失败：${target.id} 未返回 prompt_id（${JSON.stringify(queued).slice(0, 200)}）`);

      const header =
        `已派发到 ${target.id}（${target.baseUrl}）\n` +
        `prompt_id: ${promptId}\n` +
        // 注意：/prompt 返回的 number 是服务端「累计接单序号」，**不是队列位置**。
        // 实测钉过：实例队列为空（0 running / 0 pending）时它照样返回 22。
        // 真实队列深度请看 comfyui_farm_status 的 queueRunning / queuePending。
        `服务端任务号: ${queued.number ?? '?'}（累计计数，非队列位置）｜节点数: ${Object.keys(workflow).length}`;

      if (args.mode === 'async') {
        return {
          instanceId: target.id,
          promptId,
          mode: 'async',
          outputs: [],
          text: header + '\n\n（异步模式：任务已入队，未等待结果。可用 ComfyUI 面板或 /history 查看。）',
        };
      }

      // 4) 同步等待
      const deadline = Date.now() + runtime.config.requestTimeoutMs;
      while (Date.now() < deadline) {
        if (exec?.signal?.aborted) throw new Error('已被取消。');
        await sleep(runtime.config.pollIntervalMs);
        const hist = await getJson(`${target.baseUrl}/history/${promptId}`, 15_000, exec?.signal).catch(() => null);
        const entry = hist?.[promptId];
        if (!entry) continue;
        // 有 outputs 或已标记完成才算结束
        const outputs = collectOutputs(entry);
        const completed = entry.status?.completed === true || outputs.length > 0;
        if (!completed) continue;

        const ok = entry.status?.status_str !== 'error';
        const list = outputs.map((o) => `  - ${o.type}/${o.subfolder ? o.subfolder + '/' : ''}${o.filename}`).join('\n');
        return {
          instanceId: target.id,
          promptId,
          mode: 'sync',
          status: ok ? 'success' : 'error',
          outputs,
          text:
            header +
            `\n完成：${ok ? '✅ 成功' : '❌ 出错'}，产出 ${outputs.length} 个文件\n` +
            (list || '  （无产出）'),
        };
      }

      throw new Error(
        `等待 ${runtime.config.requestTimeoutMs} ms 仍未完成（实例 ${target.id}，prompt_id ${promptId}）。` +
        `长任务建议改用 mode: "async"。`,
      );
    },
  };
}

// ---------------------------------------------------------------- 小工具

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body, timeoutMs, signal) {
  return withTimeout(async (ac) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }, timeoutMs);
}

async function getJson(url, timeoutMs, signal) {
  return withTimeout(async (ac) => {
    const res = await fetch(url, { signal: signal ?? ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, timeoutMs);
}

async function withTimeout(fn, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac);
  } finally {
    clearTimeout(timer);
  }
}
