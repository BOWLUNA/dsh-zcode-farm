import z from '@deepseek-ai/schemastery';

/** 一个农场成员。`kind` 只用于展示，不参与逻辑。 */
export const InstanceSchema = z.object({
  /** 短标识，工具输出里用它指代这台机器，如 `gpu-18303`。 */
  id: z.string(),
  /** ComfyUI 的 base URL，如 `http://127.0.0.1:18303`，不要带尾斜杠。 */
  baseUrl: z.string(),
  /** 可读备注，如「Blackwell 102G」「跑批专用」。 */
  label: z.string().default(''),
  /** 自由分类：`tunnel`（SSH 隧道）/ `lan` / `primary`。纯展示用。 */
  kind: z.string().default('tunnel'),
});

export const Config = z.object({
  /**
   * 农场成员列表。留空则退化成单实例模式（只探测 `primaryUrl`）。
   *
   * 本机示例（对应 ~/gpusever 的隧道端口分配）：
   *   instances:
   *     - { id: gpu-18301, baseUrl: 'http://127.0.0.1:18301', label: '5090 分片1' }
   *     - { id: gpu-18303, baseUrl: 'http://127.0.0.1:18303', label: 'Blackwell 102G' }
   */
  instances: z.array(InstanceSchema).default([]),

  /**
   * 主端点，总是纳入探测（即使不在 `instances` 里）。
   * 若你用了可切换的转发口（如 focus-proxy 把 127.0.0.1:8188 指向「当前聚焦实例」），
   * 填这里即可——但请注意它**只反映转发目标那一台**，其余成员必须显式列进 `instances`。
   */
  primaryUrl: z.string().default('http://127.0.0.1:8188'),

  // ---- 派发策略 ----
  /** 派发所需的最小空闲显存（GB）。低于此值视为「装不下」。 */
  needVramGb: z.number().min(0).max(1024).default(8),
  /** 队列深到此值即不派发（running + pending）。 */
  maxQueueDepth: z.number().min(0).max(1000).default(3),
  /** 评分中每个排队任务的惩罚。默认 1000，让「队列」主导排序、显存作平局决胜。 */
  queueWeight: z.number().min(0).default(1000),

  // ---- 超时 ----
  /**
   * 单实例状态探测超时（毫秒）。
   * 默认 5s 是有依据的：跨 SSH 隧道时偶发抖动会把 3s 打穿——本机实测同一台机器
   * 一次探测 >3s 超时、紧接着一次 106ms 就返回；稳态耗时约 100ms。
   */
  probeTimeoutMs: z.number().min(200).max(60_000).default(5_000),
  /** 探测失败后的重试次数。跨隧道场景默认重试 1 次，避免把抖动误判成宕机。 */
  probeRetries: z.number().min(0).max(5).default(1),
  /** 重试前的等待（毫秒）。 */
  probeRetryDelayMs: z.number().min(0).max(10_000).default(400),
  /** 同步等待一次生成完成的总超时。 */
  requestTimeoutMs: z.number().min(5_000).max(3_600_000).default(900_000),
  /** 同步模式下轮询 /history 的间隔。 */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000),
});
