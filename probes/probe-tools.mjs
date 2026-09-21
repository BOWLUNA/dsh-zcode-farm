#!/usr/bin/env node
/**
 * probe-tools.mjs —— 不起 DSH 服务，直接加载插件入口并**真实执行**它注册的工具。
 *
 * 为什么要有这个：`--dump-config` 只证明「行装配上了」，证明不了「工具能跑」。
 * 这里用一个最小 mock ctx 收集 `tools.register` 的定义，然后真的调进去，
 * 让工具去打真实的 ComfyUI 端点。跑法：
 *
 *   node probes/probe-tools.mjs                 # 默认探测 primaryUrl + 两台示例实例
 *   node probes/probe-tools.mjs --only-primary  # 只探测 primaryUrl（8188）
 *
 * 注意：默认**不会**派发任务（只跑 status / pick），避免干扰正在跑的批。
 * 要实测派发请显式加 `--run`，并且它只会打到空闲的那台。
 */
import { apply } from '../index.js';

const argv = process.argv.slice(2);
const onlyPrimary = argv.includes('--only-primary');
const doRun = argv.includes('--run');

const registered = new Map();
const mockCtx = {
  logger: {
    info: (...a) => console.log('[logger.info]', ...a),
    warn: (...a) => console.log('[logger.warn]', ...a),
  },
  tools: {
    register(def) {
      registered.set(def.name, def);
      return () => {};
    },
  },
  effect(fn) {
    fn();
  },
};

const instances = onlyPrimary
  ? []
  : [
      { id: 'gpu-18100', baseUrl: 'http://127.0.0.1:18100', label: '5090 #1' },
      { id: 'gpu-18301', baseUrl: 'http://127.0.0.1:18301', label: '5090 #2' },
      { id: 'gpu-18303', baseUrl: 'http://127.0.0.1:18303', label: 'Blackwell 102G' },
    ];

const config = {
  instances,
  primaryUrl: 'http://127.0.0.1:8188',
  needVramGb: 8,
  maxQueueDepth: 3,
  queueWeight: 1000,
  probeTimeoutMs: 3000,
  requestTimeoutMs: 900_000,
  pollIntervalMs: 1000,
};

console.log('=== 加载插件入口 ===');
apply(mockCtx, config);
console.log('注册的工具：', [...registered.keys()].join(', '));

// 工具定义的形状校验——DSH 对 output 是强校验的，这里先自己把关
let shapeOk = true;
for (const [toolName, def] of registered) {
  const problems = [];
  if (typeof def.description !== 'string' || !def.description) problems.push('缺 description');
  if (!def.parameters || def.parameters.type !== 'object') problems.push('parameters 不是 object 根');
  if (!def.output || !def.output.schema) problems.push('缺 output.schema');
  if (typeof def.output?.render !== 'function') problems.push('缺 output.render');
  if (typeof def.execute !== 'function') problems.push('缺 execute');
  if (problems.length) {
    shapeOk = false;
    console.log(`  ✖ ${toolName}: ${problems.join('; ')}`);
  } else {
    console.log(`  ✅ ${toolName}  参数: ${Object.keys(def.parameters.properties || {}).join(', ') || '(无)'}`);
  }
}
if (!shapeOk) process.exit(1);

// ---- status ----
console.log('\n=== comfyui_farm_status ===');
const status = await registered.get('comfyui_farm_status').execute({});
console.log(status.text);
console.log(`\n[结构化字段] total=${status.total} online=${status.online} best=${status.best?.id ?? 'null'}`);

// ---- pick ----
console.log('\n=== comfyui_farm_pick（需要 8 GB）===');
const pick = await registered.get('comfyui_farm_pick').execute({ needVramGb: 8 });
console.log(pick.text);
console.log(`\n[结构化字段] picked=${pick.picked ?? 'null'}`);

console.log('\n=== comfyui_farm_pick（只认 5090）===');
const pick5090 = await registered.get('comfyui_farm_pick').execute({ gpuHint: '5090', needVramGb: 0 });
console.log(`picked=${pick5090.picked ?? 'null'}`);

// ---- run（默认不跑，避免干扰在跑的批）----
if (doRun) {
  console.log('\n=== comfyui_farm_run（sync, 512x512 SD1.5 最小负载）===');
  const out = await registered.get('comfyui_farm_run').execute({
    prompt: 'a single red apple on a white table, product photo',
    negative: 'blurry, low quality',
    checkpoint: 'v1-5-pruned-emaonly.safetensors',
    width: 512,
    height: 512,
    steps: 12,
    mode: 'sync',
  });
  console.log(out.text);
} else {
  console.log('\n（跳过 comfyui_farm_run —— 加 --run 才会真的派发一次任务）');
}
