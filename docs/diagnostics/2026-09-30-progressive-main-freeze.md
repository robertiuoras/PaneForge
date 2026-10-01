# Progressive main-thread freeze, 30 September 2026

## What the incident proves

The installed 0.8.232 process (20879) was force-quit at 21:20:17 Brisbane time,
then restarted as process 70914. macOS recorded repeated slow HID responses before
the quit. Recorded durations progressed from 20.96 seconds at 21:15:31 to 41.71
seconds at 21:16:11 and 87.81 seconds at 21:17:12. The last sampled input event
started 170.1 seconds before sampling. Its heaviest main-thread stack contained
JavaScript called by a libuv timer in 225/226 samples, including synchronous file
open/read calls; sampled main-thread CPU was 1.859/2.26 seconds.

This establishes main-thread timer starvation. Unsymbolicated JavaScript frames do
not identify the exact recurring task. Main-process memory fluctuated (323–542MB
in the relevant reports), so the aggregate app memory observation does not prove
a monotonically growing main-process leak. The existing watchdog requires a long
absence of heartbeats, which does not cover all progressive input starvation.

The preserved local evidence is `/tmp/pf-forcequit-20260930-evidence.json`, its spin
and CPU extracts, and `/tmp/pf-freeze-20260930-evidence/`. No raw conversation text
is included in this report.

## Measured defect and repair

`transcriptFor` can ask `codexSaidByPane` repeatedly when an inferred Codex
conversation has a submitted prompt not yet present in its native rollout. The
old implementation synchronously read, split, and parsed the entire rollout on
every unsuccessful query. The one-second idle sweep can request this identity
several times. Larger conversations make the same negative query more expensive.
Explicitly resumed conversations have their existing identity fast return.

Keep the current normalized query and complete-row offset for each file, capped
at 64 files. Repeated misses only read appended bytes. A changed query, file
replacement, truncation, or same-size rewrite invalidates the scan. Retain the
last incomplete row so split UTF-8 input can be retried, and preserve final valid
JSON without a newline. Parse only candidate user-message records; Unicode-escaped
JSON values still receive the parsed predicate. No agent output or accumulated
message index is retained. Existing unique ownership checks remain in charge.

A new query still has one cold scan of its candidate history. The change removes
repeated full scans, rather than promising a constant-time first query. This is a
measured contributor matching the OS signature, not proof that it was the sole
cause of the original incident.

## Future evidence

Reuse the two-second main watchdog heartbeat and its existing CPU, RSS, heap,
timer-delay and renderer-answer-age measurements. Write metadata-only trends
every 30 seconds to `userData/main-performance.log`, retaining interval peaks and
named synchronous task totals/maxima. Measure `idle-sweep`, `codex-proof`,
`done-close`, `exited-close`, and `lane-maintenance`. Tasks taking at least 250ms
also produce an immediate record, globally limited to one per 30 seconds.

Writes use the existing serialized asynchronous log writer. Rotation retains the
current file and `.1`, each approximately 256KiB plus one bounded record. There
are no prompts, terminal output, conversation paths or user text in these logs.
Sampling continues when the test copy disables the watchdog child. A force quit
may lose a pending asynchronous line; a completely stuck callback cannot report
its duration until it returns, and unnamed or asynchronous work remains outside
the named-task coverage.

## Verification

The portable regression grows a native rollout from 8MB to 28MB while repeatedly
querying a missing receipt. It checks that each appended byte is read once,
stable ownership remains intact, and a delayed split UTF-8 user record settles
the query. Controlled 280ms task injection reads back the real persisted task,
duration, vitals and version. It checks 30-second write throttling, real rotation,
and absence of prompt/path text. Existing native transcript, prompt submission,
main watchdog, and asynchronous log-write suites cover the related behavior.

PC typecheck and candidate build passed in rbuild job
`602ef8b4-7d7b-49c1-93c7-e589cba31946`. Its affected main watchdog, performance,
native transcript, prompt submission and log-write checks passed. Nineteen fetched
PC artifact hashes matched the saved manifest before the Mac runtime copy used
them. The initial full run passed 288/290 suites; the two failures were fixtures
needing the new Electron version method and permitted instrumentation import.
Both were corrected; all 11 related checks passed in job
`437bc425-d020-43b3-9cb9-03c7522e2e71`. Expanded invalidation and log tests passed in
jobs `286fb360-b5a1-4010-a5a1-ae4439311f74` and
`3810d158-b68e-42a6-a194-845daf9e3e28`. No app build ran on the Mac.

The measured before/after workload used four real native rollout copies totaling
37,980,706 bytes, then appended 256KiB of assistant output per file on each of 60
one-second ticks. Each tick asked four missing-proof questions per file: 960 calls
and 62,942,880 appended bytes per phase. The old implementation is reproduced with
the same parsed ownership predicate; the repaired function is PC-compiled source.

| Measurement | Previous scan | Incremental scan |
| --- | ---: | ---: |
| Elapsed time for 60 ticks | 73.130s | 60.056s |
| CPU time | 69.047s | 0.347s |
| CPU as percent of one core | 94.42% | 0.58% |
| Total callback duration | 69.348s | 0.315s |
| Longest callback | 1,587ms | 143ms (first cold scan) |
| Longest warm callback | 1,587ms | 5.32ms |
| Sampled RSS peak | 423.7MB | 263.6MB |
| Sampled heap peak | 283.0MB | 93.7MB |

The repaired scan read exactly 100,923,586 bytes: original plus appended bytes
once. Memory figures belong to this controlled, sequential benchmark, including
GC/order effects; they do not establish a repaired whole-app memory leak. Saved
metrics: `/tmp/pf-freeze-benchmark-20260930.json`.

A separate minimized, non-headless copy (process 78200, profile
`freeze-repair-20260930`, CDP 9481) ran four owned shell panes producing about 6MB
of terminal output over 150 seconds. Six saved trend checks covered 166.6 seconds.
Renderer IPC replies took 1.19–3.50ms; main RSS was 172–200MB and heap 30–37MB.
After the startup interval's 74ms peak, interval peaks of heartbeat lateness stayed
at or below 6ms. The largest measured idle sweep was 20ms. The copy stayed
nonvisible throughout; only its four test panes were closed, then the copy exited
and its owned desktop guard was released. Receipt:
`/tmp/pf-freeze-runtime-receipt-20260930.json`. This shell-output check exercises
app responsiveness and actual log persistence; the growing-rollout benchmark
separately exercises the repaired identity path.

Logging adds two monotonic clock reads and one fixed-size counter update per named
call, reusing the existing two-second heartbeat rather than adding another timer.
Periodic records are small JSON rows, capped to five task names, with at most one
trend row and one slow-task row per 30 seconds. The test reports measured per-call
instrumentation overhead of 0.129 microseconds per call on the PC (200,000 calls,
empty callback, baseline loop subtracted). A successful short copy run does not establish
permanent resolution of a several-hour installed-app incident. The next incident
can be attributed using named task maxima and durable CPU/memory/delay trends.
