# Changelog

## 0.2.0

### Features

- **Global budget cap**: new `budget` config option to set an account-wide dollar threshold (e.g. `{ maxUsd: 10, granularity: "weekly" }`)
  - Trips only resources that are actively contributing to overage (`estimatedOverage > 0`); zero-overage resources stay open
  - Supports `daily`, `weekly`, and `monthly` granularity with correct per-period cost computation
  - Configurable warn threshold (default 80% of `maxUsd`)
  - Works alongside per-resource thresholds -- both can independently trip the guard
  - Budget status (`totalOverageUsd`, `maxUsd`, `percent`) persisted in `GuardState` and available via `getState()`
  - Supported in `withUsageGuard` wrapper via `WrapperConfig.budget`
- **Per-resource granularity**: thresholds now support `granularity: "daily" | "weekly" | "monthly"` to control the evaluation window
  - `ai-neurons` defaults to `"daily"` (matching CF's daily allocation of 10,000 neurons/day)
  - All other resources default to `"monthly"`
  - Alert dedup keys are scoped per granularity period (daily: 48h TTL, weekly: 8d TTL)
- **Corrected default limits** to match current CF pricing:
  - `d1-reads`: 25M -> 25B (25,000,000,000)
  - `ai-neurons`: 10M -> 10K (daily)
  - `vectorize-queries`: 30M -> 50M

### Fixes

- **Generic env typing**: proxy wrappers now use more generic type parameters for broader compatibility

### Breaking Changes

- `GuardState` now includes a `budget` field (`BudgetStatus | null`)
- `ResolvedThreshold` now includes a `granularity` field
- Default limits changed for `d1-reads`, `ai-neurons`, and `vectorize-queries`

## 0.1.0

Initial release.

- 17 resource types across 10 Cloudflare services
- Per-resource circuit breaking with hysteresis
- Passive mode (`isTripped`) and active mode (proxy wrappers)
- `guardEnv` for seamless env wrapping with auto-detection
- `guardKV`, `guardD1`, `guardR2`, `guardQueue`, `guardAI`, `guardVectorize` proxies
- 3 trip behaviors: `"throw"`, `"skip"`, custom callback
- Percentage, absolute (`tripAt`), and dollar budget (`maxOverageUsd`) thresholds
- Discord, Slack, and custom alert channels with deduplication
- `withUsageGuard` wrapper for simple Worker setups
- `onEvaluate` hook for dashboards and custom monitoring
- Manual `trip()` / `reset()` overrides
- Dry-run mode for testing thresholds without affecting your app
- Fail-safe: fail-open on KV failures, cached state on API failures
- Zero runtime dependencies
