# Changelog

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
