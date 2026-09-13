# Codex usage evidence (read-only extract, 2026-09-13)

Weekly window (`window_minutes: 10080`, plan `pro`, resets 2026-09-19T08:26Z). First reading of each hour, picked from the continuous stream of rollout `rate_limits` blocks (one per server reply):

```
2026-09-10T04:45:23.143Z 1.0% weekly
2026-09-10T05:00:47.255Z 1.0% weekly
2026-09-12T14:44:01.618Z 0.0% weekly
2026-09-13T01:09:18.160Z 0.0% weekly
2026-09-13T02:00:03.329Z 3.0% weekly
2026-09-13T03:00:01.079Z 11.0% weekly
2026-09-13T04:00:01.532Z 20.0% weekly
2026-09-13T05:00:00.300Z 32.0% weekly
2026-09-13T06:00:06.474Z 35.0% weekly
2026-09-13T07:02:25.885Z 36.0% weekly
2026-09-13T08:00:00.828Z 38.0% weekly
```

Checked for a scheduled hourly Codex job: zero rollouts start at HH:00 on 10-13 Sep, and `launchctl list` names no codex/dispatch job on this Mac. The hourly cadence above is an artefact of the hour-bucket dedupe, not a scheduler.

Secondary (5-hour) window: null in every 2026-09 pro-plan reading; the only non-null `secondary` rows (20 of 37,716) are also 10080-minute windows from an older plan shape.
