# Measurements

**English** | [中文](MEASUREMENTS.zh.md)

> Every number here was taken on this repository's development machine, and each comes with the command
> that produced it. A number in a README is a claim; this file is the receipt.

## M1. The farm, as the plugin sees it

Five SSH tunnels plus one switchable forwarder, all online at the same moment.

| Instance | GPU | Free / total VRAM | Queue (run / wait) | What was running |
| --- | --- | --- | --- | --- |
| `primary` (forwarder → 18100) | RTX 5090 | 0.8 / 33.7 GB | 1 / 0 | video/audio (16 nodes) |
| `gpu-18300` | RTX 5090 | 0.8 / 33.7 GB | 1 / 0 | video/audio (16 nodes) |
| `gpu-18301` | RTX 5090 | 0.9 / 33.7 GB | 1 / 0 | video/audio (17 nodes) |
| `gpu-18302` | RTX 5090 | 0.5 / 33.7 GB | 1 / 0 | video/audio (15 nodes) |
| `gpu-18303` | RTX PRO 6000 Blackwell | 99.4 / 102.0 GB | 0 / 0 | — |

Command: `node probes/probe-farm.mjs`

Two findings worth keeping:

- `primary` and `gpu-18100` reported identical values field for field, which independently confirms the forwarder was pointing at 18100.
- Only one instance out of six was usable at that moment. A single-endpoint plugin would have queued behind a full card while 102 GB sat idle.

## M2. End-to-end generation

Dispatched with `mode: "sync"` and the smallest sensible payload (512×512, 12 steps, SD 1.5).

```
已派发到 gpu-18303（http://127.0.0.1:18303）
prompt_id: a2717628-7a14-47f8-836f-9737687ba296
完成：✅ 成功，产出 1 个文件
  - output/farm_00001_.png
real  1m57s
```

Retrieval check:

```bash
curl -s -o /tmp/out.png -w "http=%{http_code} bytes=%{size_download} type=%{content_type}\n" \
  "http://127.0.0.1:18303/view?filename=farm_00001_.png&subfolder=&type=output"
http=200 bytes=424466 type=image/png
```

## M3. `/prompt`'s `number` is not a queue position

The dispatch output once showed a "queue position" of 22 while the same instance reported an empty
queue. It is a cumulative server counter, and the label was corrected after measuring this.

```bash
curl -s http://127.0.0.1:18303/queue
{"queue_running": [], "queue_pending": []}
```

## M4. A failed probe is not proof of absence

One instance timed out at more than 3000 ms and answered in 106 ms on the very next call: the tunnel
hiccuped. Retrying once is now the default, and it took the online count from 3 back to 4.

## M5. Runtime registration, verified inside a live instance

A `--patch` probe ran inside a real instance and asked the host directly:

```
★ 运行时注册表：共 3 个工具；本插件 3/3 -> comfyui_farm_status, comfyui_farm_pick, comfyui_farm_run
★ comfyui_farm_status.execute() 完成，耗时 192ms（真实 HTTP 走到了 ComfyUI）
```

That is a stronger claim than `--dump-config`, which only composes configuration and never applies
the plugin.

## M6. What the ranking rule actually decides

`score = free VRAM − queue depth × weight`, default weight 1000. Replayed by
`tools/ordering-replay.mjs` over the fixture in `test/fixtures/`:

| Fixture | weight 0 | weight 11.9 | weight 12.1 | weight 1000 |
| --- | --- | --- | --- | --- |
| A · measured 2026-09-21 | `gpu-18303` | `gpu-18303` | `gpu-18303` | `gpu-18303` |
| B · constructed conflict | A | A | B | B |

The measured fixture gives the same answer at every weight, because the empty queue and the most
free VRAM happened to be the same machine that day. **That run cannot distinguish the two rules**,
so it is not evidence for "the queue dominates the ranking" — which is what it looked like.
The constructed fixture is where the two separate: the crossover sits at weight 12 (`20 − w`
meets `8`), so the default of 1000 makes the queue effectively absolute rather than weighted.

Guarded by `test/ordering.test.mjs`, 8 checks.
