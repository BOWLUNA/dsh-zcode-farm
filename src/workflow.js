/**
 * workflow.js —— 与 ComfyUI 工作流打交道的最小工具集。
 *
 * 刻意保持纯函数、零依赖：这样它可以脱离 DSH 宿主单独测试
 * （`index.js` 会 import schemastery，只有宿主环境能满足）。
 */

/**
 * 最小可用的 SD txt2img 图（API 格式）。
 * 只在调用方「只给了提示词」时使用——这是让 Agent 一句话出图的最短路径，
 * 不追求覆盖全部参数，复杂需求请直接传 `workflow`。
 */
export function buildTxt2Img({
  prompt,
  negative = '',
  checkpoint,
  width = 1024,
  height = 1024,
  steps = 25,
  seed = 0,
  cfg = 7,
}) {
  if (!checkpoint) throw new Error('buildTxt2Img 需要一个 checkpoint 文件名');
  return {
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'farm', images: ['8', 0] } },
  };
}

/**
 * 把 `/history/{promptId}` 的一条记录摊平成产出物列表。
 * ComfyUI 的 outputs 形状是 { nodeId: { images|gifs|audio: [{filename, subfolder, type}] } }，
 * 这里抹掉差异，只留下「有什么文件」。
 */
export function collectOutputs(entry) {
  const out = [];
  const outputs = entry?.outputs || {};
  for (const nodeId of Object.keys(outputs)) {
    for (const [kind, items] of Object.entries(outputs[nodeId] || {})) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item === 'object' && typeof item.filename === 'string') {
          out.push({
            kind,
            nodeId,
            filename: item.filename,
            subfolder: item.subfolder || '',
            type: item.type || 'output',
          });
        }
      }
    }
  }
  return out;
}

/** 拼出可直接访问的预览 URL（ComfyUI 的 /view 路由）。 */
export function outputViewUrl(baseUrl, output) {
  const q = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder || '',
    type: output.type || 'output',
  });
  return `${String(baseUrl).replace(/\/+$/, '')}/view?${q.toString()}`;
}
