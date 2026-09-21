# 实测数据

[English](MEASUREMENTS.md) | **中文**

> 这里的每个数字都取自本仓库的开发机，并且都附了产生它的命令。
> README 里的数字是主张；这份文件是收据。

## M1. 插件眼里的农场

5 条 SSH 隧道 + 1 个可切换转发口，同一时刻全部在线。

| 实例 | GPU | 空闲 / 总显存 | 队列（跑 / 等） | 在跑什么 |
| --- | --- | --- | --- | --- |
| `primary`（转发口 → 18100） | RTX 5090 | 0.8 / 33.7 GB | 1 / 0 | video/audio（16 节点） |
| `gpu-18300` | RTX 5090 | 0.8 / 33.7 GB | 1 / 0 | video/audio（16 节点） |
| `gpu-18301` | RTX 5090 | 0.9 / 33.7 GB | 1 / 0 | video/audio（17 节点） |
| `gpu-18302` | RTX 5090 | 0.5 / 33.7 GB | 1 / 0 | video/audio（15 节点） |
| `gpu-18303` | RTX PRO 6000 Blackwell | 99.4 / 102.0 GB | 0 / 0 | — |

命令：`node probes/probe-farm.mjs`

两个值得留下的发现：

- `primary` 与 `gpu-18100` 的读数逐字段完全相同，这**独立印证**了转发口当时指向 18100。
- 那一刻 6 台里只有 1 台可用。单端点插件会让 Agent 在一张满卡的队列后面等着，而旁边 102 GB 一直空转。

## M2. 端到端出图

用 `mode: "sync"`、最小可用负载（512×512、12 步、SD 1.5）派发。

```
已派发到 gpu-18303（http://127.0.0.1:18303）
prompt_id: a2717628-7a14-47f8-836f-9737687ba296
完成：✅ 成功，产出 1 个文件
  - output/farm_00001_.png
real  1m57s
```

取回核对：

```bash
curl -s -o /tmp/out.png -w "http=%{http_code} bytes=%{size_download} type=%{content_type}\n" \
  "http://127.0.0.1:18303/view?filename=farm_00001_.png&subfolder=&type=output"
http=200 bytes=424466 type=image/png
```

## M3. `/prompt` 的 `number` 不是队列位置

派发输出里曾显示「队列位次 22」，而同一实例报告的是空队列。
它是服务端的累计计数器；标签是在实测之后改掉的。

```bash
curl -s http://127.0.0.1:18303/queue
{"queue_running": [], "queue_pending": []}
```

## M4. 探测失败不等于不存在

有一台实例超时超过 3000 毫秒，而下一次调用只用 106 毫秒就返回了：隧道抖了一下。
现在默认重试一次，它把在线数从 3 拉回了 4。

## M5. 在真实实例内部核对运行时注册

一个 `--patch` 探针跑在真实实例里，直接问了宿主：

```
★ 运行时注册表：共 3 个工具；本插件 3/3 -> comfyui_farm_status, comfyui_farm_pick, comfyui_farm_run
★ comfyui_farm_status.execute() 完成，耗时 192ms（真实 HTTP 走到了 ComfyUI）
```

这比 `--dump-config` 是更强的主张 —— 后者只合成配置，从不 apply 插件。
