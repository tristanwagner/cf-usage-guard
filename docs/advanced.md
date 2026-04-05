# Advanced

## Dry-Run Mode

Start with `dryRun: true` to evaluate thresholds and fire `onEvaluate` without actually tripping, writing state, or sending alerts. Useful for validating your configuration before going live:

```ts
const guard = createUsageGuard({
  // ...
  dryRun: true,
  onEvaluate: async (event) => {
    console.log("Would have transitioned:", event.transitioned);
    for (const r of event.state.resources) {
      if (r.percent > 80) console.log(`${r.name}: ${r.percent.toFixed(1)}%`);
    }
  },
});
```

When `dryRun` is enabled:
- `isTripped()` always returns `false`
- `evaluate()` still queries the CF API and runs threshold logic
- `onEvaluate` fires with the correct `transitioned` value ("trip", "recover", or null)
- No state is written to KV, no alerts are sent

Remove `dryRun: true` once you are satisfied with your thresholds.

## Hysteresis

The gap between trip (default 90%) and recover (default 85%) prevents oscillation:

```
Without hysteresis:     With hysteresis:
-> 90% trip             -> 90% trip
<- 89% recover          <- 89% still tripped
-> 90% trip             <- 87% still tripped
<- 89% recover          <- 84% recover
(flapping!)             (stable)
```

Recovery requires ALL trippable resources to drop below their recover threshold. This prevents the guard from flapping on/off when usage hovers near the trip point.

## onEvaluate Hook

Get full state after every `evaluate()` call -- useful for dashboards, logging, or custom monitoring:

```ts
createUsageGuard({
  // ...
  onEvaluate: async (event) => {
    // event.state: GuardState (all resource data)
    // event.billingPeriod: { start: Date, end: Date }
    // event.transitioned: "trip" | "recover" | null

    // Log to your analytics
    for (const r of event.state.resources) {
      await analytics.gauge(`cf.usage.${r.name}`, r.percent);
    }

    // Custom escalation logic
    if (event.transitioned === "trip") {
      await pagerduty.trigger("CF usage guard tripped");
    }
  },
});
```

## Manual Overrides

For incident management or deploy freezes:

```ts
// Trip manually (e.g., during a deploy freeze)
await guard.trip("deploy freeze until 2pm");

// Check reason
const state = await guard.getState();
console.log(state?.manualTripReason); // "deploy freeze until 2pm"

// Manual trips do NOT auto-recover -- you must explicitly reset
await guard.reset();
```

## Fail-Safe Behavior

The guard is designed to never make things worse:

| Failure                               | Behavior                   | Rationale                                         |
| ------------------------------------- | -------------------------- | ------------------------------------------------- |
| CF API down, not tripped              | Stays "not tripped"        | Don't block your app because monitoring failed    |
| CF API down, tripped                  | Stays "tripped"            | Don't unmask a real usage spike                   |
| KV read fails                         | Returns "not tripped"      | Fail-open: don't block your app                   |
| KV write fails                        | Logs warning, continues    | State re-evaluated on next check                  |
| State key missing, tripped key exists | Reconciles as "tripped"    | Safety net preserves trip across state corruption |
| Alert channel fails                   | Retries next evaluate()    | Dedup only written on successful delivery         |
| Custom handler throws                 | Caught and logged          | Other channels still fire                         |
| Custom handler hangs                  | Killed after timeout (10s) | Won't block evaluate()                            |
