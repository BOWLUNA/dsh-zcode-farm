# Architecture

**English** | [中文](ARCHITECTURE.zh.md)

> Why this plugin is shaped the way it is. Each decision below was made against a measured
> alternative, not a preference.

## The problem shape

A ComfyUI server executes **one workflow at a time**. Its `/prompt` endpoint validates a graph,
appends it to a queue, and returns a `prompt_id` — the queue is processed sequentially by that
process. Real concurrency therefore comes from running **several instances** and routing each job
to the one that can start soonest.

That is the whole reason this plugin exists: an agent talking to a single endpoint cannot see the
rest of the farm, so it queues behind a busy card while an idle one sits unused.

## Where the state comes from

Two endpoints, both read-only, both already part of ComfyUI's public HTTP API:

| Source | What it yields | Why it is the right source |
| --- | --- | --- |
| `/system_stats` | device name, total VRAM, free VRAM, ComfyUI version | live truth; no bookkeeping to go stale |
| `/queue` | counts of running and pending prompts | the real queue, not a local guess |

**Deliberately not used:** any locally tracked "is this instance busy" flag. A job submitted by
something else — another agent, a notebook, a person at the ComfyUI canvas — is invisible to a local
counter, and a plugin that reports a busy instance as idle is worse than one that reports nothing.

## Selection: two stages, queue-dominant

```
1. filter   unreachable  OR  freeVram < needVramGb  OR  queueDepth > maxQueueDepth   → out
2. rank     score = freeVramGb − queueDepth × queueWeight        (default weight 1000)
```

**Why queue depth dominates.** The question an agent is really asking is "where will this finish
soonest". A card with an empty queue starts now; a card with a deeper queue starts later no matter
how much VRAM it has. The weight makes that explicit: one queued job costs 1000 points, so a small
idle card beats a large busy one. Setting `queueWeight: 0` restores plain "most VRAM wins", which is
the right answer only when every job is equally sized and the queue never matters.

**Why filter first.** Ranking a job onto an instance that cannot hold it produces an out-of-memory
failure at the far end, after the wait. A hard filter fails fast and says why.

## Probe failure is retried, not reported

Measured on the development machine: the same instance once timed out at **>3000 ms** and answered in
**106 ms** on the very next call. A cross-SSH-tunnel hiccup is not a dead instance.

So a single failure is never the verdict: the probe retries (`probeRetries`, default 1) and reports
`attempts` alongside. That distinction is visible to the agent, which can tell "down" from "blinked".

**Also deliberate:** when a filter rejects an instance, its original reason survives. An unreachable
instance filtered by a GPU-name hint still reports "unreachable" — relabelling it "GPU mismatch"
would hide the actual problem behind a plausible-sounding one.

## Zero runtime dependencies

`fetch` and `AbortController` are in Node 20+. Everything else here is arithmetic and string
formatting. That is not minimalism for its own sake:

- an installed plugin runs in the same process as the harness; every dependency is another chance to
  break someone's boot
- the plugin's job is to talk to an HTTP API — the platform already has the client

## Boundaries

| Concern | Whose job |
| --- | --- |
| Workflow library, skill packs, canvas, asset panel | `dsh-comfyui` |
| Which of N endpoints should take this job | **this plugin** |

The two are independent: different row ids (`comfyui` vs `comfyui-farm`), no shared code, and either
can be installed without the other.
