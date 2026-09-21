# Troubleshooting

**English** | [中文](TROUBLESHOOTING.zh.md)

> Every entry below is a real observation, with the check that tells the cases apart.

## Nothing is ever eligible

`comfyui_farm_status` rejects every instance. Read the verdict column first:

| Verdict shown | What it means | What to change |
| --- | --- | --- |
| `unreachable: timeout` | the endpoint failed to answer, twice | check the tunnel or the URL, not the plugin |
| `free VRAM < need` | the instance cannot hold this job | lower `needVramGb` for this run |
| `queue depth > ceiling` | too many jobs ahead of this one | raise `maxQueueDepth`, or simply wait |

`comfyui_farm_run` refused to start for the same reason is not a bug — it is the filter doing its
job before an out-of-memory failure can happen at the far end.

## It picked a busier instance than I expected

Queue depth dominates the ranking by design: one queued job costs `queueWeight` (1000 by default)
points. An instance with 33 GB free and an empty queue therefore outranks one with 99 GB free and a
single queued job.

If you would rather have the largest VRAM win, set `queueWeight: 0`. Note that this is only the right
answer when jobs are equally sized and the queue never matters.

## Dispatch succeeded but the file is not where I looked

The default text-to-image template writes through ComfyUI's own `SaveImage` node, so the output lands
in **that instance's** output directory — which for a remote instance is on the remote machine.
`comfyui_farm_run` returns the filename and subfolder it was told about; retrieve it over the same
base URL with `/view?filename=…&subfolder=…&type=output`.

## An instance was reported down while it was actually up

Single probe failures are retried once before a verdict is issued, precisely because a cross-tunnel
hiccup is common: the development machine once saw a `>3000 ms` timeout followed by a `106 ms` success
on the same instance.

If you see `unreachable` and the machine is demonstrably alive, check the `attempts` field — a
verdict after two attempts is stronger evidence than after one. Raising `probeTimeoutMs` helps on
slow links.
