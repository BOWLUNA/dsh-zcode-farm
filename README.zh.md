# dsh-zcode-farm

[English](README.md) | **中文**

> 让 DeepSeek Harness 的 Agent 看见**整个** ComfyUI 农场，并把每个任务派给最空闲的那一台。

零运行时依赖 · 适配 Node ≥ 22 · MIT

---

## 为什么需要它

ComfyUI 官方文档写得很清楚：**一个 ComfyUI 进程一次只跑一个工作流**，真正的并发只能靠
「每张卡一个进程，再把任务路由到最空闲的实例」。生态里也已经有 `comfyui-orchestrator`
这类 Node.js 池化库。

但把它们接到 AI Agent 上时，有一个缺口一直没人填：**Agent 看不见农场。**

实测（2026-09-21 某一刻的真实读数，来自本插件自己的探针）：

| 实例 | GPU | 空闲显存 | 队列 | 判定 |
| --- | --- | --- | --- | --- |
| `18100` ← `dsh-comfyui` 唯一能看见的那台 | RTX 5090 | 0.8 / 33.7 GB | 1 跑 / 0 等 | 装不下 |
| `18300` | RTX 5090 | 0.8 / 33.7 GB | 1 跑 / 0 等 | 装不下 |
| `18301` | RTX 5090 | 0.9 / 33.7 GB | 1 跑 / 0 等 | 装不下 |
| `18302` | RTX 5090 | 0.5 / 33.7 GB | 1 跑 / 0 等 | 装不下 |
| **`18303`** | **RTX PRO 6000 Blackwell** | **99.4 / 102.0 GB** | **0 / 0** | **✅ 全空** |

`dsh-comfyui`（77★，市场里做这件事最成熟的插件）只能连**一个**端点，
于是 Agent 的每次出图请求都会撞上最忙的那台——而 102 GB 的算力从头到尾闲置。

**本插件补的就是这一层：先让 Agent 看见，再让它派发。**

---

## 它做什么

三个工具：

| 工具 | 作用 |
| --- | --- |
| `comfyui_farm_status` | 农场全景：每台的 GPU、空闲显存、队列深度、在跑什么，以及**当前该派给谁** |
| `comfyui_farm_pick` | 只选择、不执行：按显存门槛 / 队列上限 / GPU 型号关键字 / 排除名单挑一台，并给出**理由** |
| `comfyui_farm_run` | 负载感知派发：自动选实例（或指定某台），支持原始 API 工作流，也支持「提示词 + 模型」一键文生图 |

---

## 安装

```bash
dsh plugin --profile web add dsh-zcode-farm
```

装完重启应用，Agent 立刻获得上述三个工具。

---

## 配置

```yaml
- id: comfyui-farm
  config:
    # 主端点，总是纳入探测（不在 instances 里也会被探测）
    primaryUrl: 'http://127.0.0.1:8188'
    # 农场成员。留空则退化为单实例模式。
    instances:
      - { id: gpu-18301, baseUrl: 'http://127.0.0.1:18301', label: '5090 分片' }
      - { id: gpu-18303, baseUrl: 'http://127.0.0.1:18303', label: 'Blackwell 102G' }
    # 派发策略
    needVramGb: 8          # 低于此空闲显存视为「装不下」
    maxQueueDepth: 3       # 队列深到此值就不再派发
    queueWeight: 1000      # 排序惩罚，见下
    # 探测
    probeTimeoutMs: 5000
    probeRetries: 1
```

### 选实例的规则（两段式）

1. **过滤**——不可达 / 空闲显存 `< needVramGb` / 队列深 `> maxQueueDepth` 的，一律出局。
2. **排序**——`score = 空闲显存(GB) − 队列深 × queueWeight`

默认 `queueWeight = 1000` 是刻意的：让**队列**主导排序，显存只在队列相同时做平局决胜。
直觉上是对的——**一台空着的小卡，比一台正排队的大卡更快出结果**。

> 只想用「显存最多者优先」？把 `queueWeight` 设成 `0` 即可。

---

## 与 `dsh-comfyui` 的关系：互补，可共存

| | `dsh-comfyui` | `dsh-zcode-farm` |
| --- | --- | --- |
| 管的范围 | **一个**端点 | **一整个**农场 |
| 强项 | 工作流库、技能包、画布、资产面板 | 状态感知、选实例、派发 |
| 装配行 id | `comfyui` | `comfyui-farm` |

两行 id 不同，**可以同时装配**：用 `dsh-comfyui` 管深度体验，用本插件决定"这活派给谁"。
也可以只用其中一个。本插件不依赖 `dsh-comfyui`，反之亦然。

---

## 设计取舍

- **零运行时依赖。** 只用 Node 内置的 `fetch` / `AbortController`。
- **不做工作流编辑。** 那是 `dsh-comfyui` 的地盘；这里只回答"派给谁"。
- **不假设本地。** 所有成员都是 URL——SSH 隧道、局域网、远端机器一视同仁。
  本机的 5 条隧道就是 `ssh -L` 转发出来的。
- **探测失败会重试。** 跨隧道抖动很常见：实测同一台机器一次探测 `>3s` 超时、
  紧接着 `106ms` 就返回。单次失败不当结论，重试后再判，并把 `attempts` 报出去，
  让 Agent 能区分「真宕机」和「抖了一下」。
- **失败原因不被覆盖。** 例如按 GPU 型号筛选时，不可达的实例会保留"不可达"这个原因，
  不会被改写成"型号不匹配"而把真正的问题藏起来。

---

## 开发

```bash
npm test                              # 单元测试（纯函数，不碰网络）
node probes/probe-farm.mjs            # 独立探针：只看农场状态
node probes/probe-tools.mjs           # 加载插件入口并真实执行工具（只读）
node probes/probe-tools.mjs --run     # 真的派发一次任务（默认最小负载：512² / 12 步）
```

开发期需要把宿主提供的 peer 依赖（`@deepseek-ai/schemastery` 及其依赖）放到本地
`node_modules/`，否则入口无法加载。装配到真实 profile 时不需要——宿主会提供。

---

## 已知限制

- `comfyui_farm_run` 的内置模板只覆盖**最简文生图**（KSampler + CheckpointLoaderSimple +
  EmptyLatentImage + 两个 CLIPTextEncode + VAEDecode + SaveImage）。复杂需求请直接传 `workflow`。
- **不检测"两个 URL 指向同一台机器"**。如果你同时配了一个可切换的转发口（如把
  `127.0.0.1:8188` 指向"当前聚焦实例"）和它的真实目标，你会看到两行读数完全相同的成员。
  这是如实反映，不是 bug——探测本身无法区分。
- `/prompt` 返回的 `number` 是服务端**累计接单序号**，**不是队列位置**
  （实测：队列为空时它照样返回 22）。真实队列深度以 `comfyui_farm_status` 的输出为准。

---

## License

MIT

---

## 状态

- **1 个套件**、**15 项检查** —— 跑 `node test/run.mjs`
- 声明兼容范围：`>=0.1.5-rc.2 <0.2.0-0`（见 `engines.dsh` 与 peer 范围）
- 钉住版本可绕过 pnpm 的发布冷却期：`dsh plugin --profile web add dsh-zcode-farm@1.0.0`
- 已在 5 个 SSH 隧道实例 + 1 个可切换转发口上验证
