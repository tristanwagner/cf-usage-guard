# cf-usage-guard

Automatic usage protection for Cloudflare Workers. Monitors account-level resource consumption via the CF GraphQL API, circuit-breaks individual services before you hit billing overages, and sends alerts via Discord, Slack, or custom webhooks.

> **Disclaimer**: This library is not affiliated with, endorsed by, or maintained by Cloudflare. It queries the public CF GraphQL Analytics API and relies on the accuracy and freshness of that data. CF analytics can lag by several minutes, the guard cannot prevent overages that happen faster than your cron interval + analytics delay. This package can't guarantee you that you won't be charged for overage, and the maintainers can't be held accountable if you do. Use at your own risk, and set conservative thresholds if you are on a tight budget.

## Features

- **Zero runtime dependencies**
- **17 resource types** across 10 CF services
- **Per-resource circuit breaking** -- check individual services, not just global on/off
- **Seamless env wrapping** -- `guardEnv(env, guard)` wraps all bindings in one line
- **Active mode proxy wrappers** -- `guardKV`, `guardD1`, `guardR2`, `guardQueue`, `guardAI`, `guardVectorize`
- **3 trip behaviors** -- `"throw"` (default), `"skip"` (silent no-op), or custom callback
- **Dry-run mode** -- evaluate thresholds without tripping, for testing before going live
- **Every service trips by default** -- opt out with `trip: null`, restore with `DEFAULT_THRESHOLDS`
- **Hysteresis** -- trip at threshold, recover 5% lower to prevent flapping
- **Pluggable alerts** -- Discord, Slack, or custom async handlers
- **Alert deduplication** -- one trip alert globally and one warn alert per resource per billing period (only written on successful delivery)
- **Fail-safe** -- CF API down? maintains last state. KV down? defaults to not-tripped (fail-open)
- **Persistent safety net** -- separate KV key survives state corruption
- **Global budget** -- `budget: { maxUsd: 10 }` caps total overage across all resources; only blocks resources actively generating costs
- **Manual overrides** -- `trip()` and `reset()` for incident management
- **`onEvaluate` hook** -- get full state after every check for dashboards/reporting
- **`DEFAULT_THRESHOLDS` export** -- reference or restore defaults after overriding

---

## Prerequisites

Before installing, you need:

1. **Cloudflare Workers Paid Plan** ($5/mo). The guard monitors billing-period usage, which only applies to paid plans.

2. **A CF API token** with **Account Analytics: Read** permission. Create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).

3. **A KV namespace** for the guard's state storage. Create one via the dashboard or Wrangler:
   ```bash
   wrangler kv namespace create USAGE_GUARD_KV
   ```

4. **A cron trigger** to call `guard.evaluate()` periodically (e.g. every 5 minutes).

5. **Your Cloudflare Account ID** -- visible in the dashboard URL or via `wrangler whoami`.

---

## Install

```bash
npm install cf-usage-guard
# or
pnpm add cf-usage-guard
```

### Wrangler Setup

Add the KV binding and cron trigger to your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "USAGE_GUARD_KV"
id = "your-kv-namespace-id"

[triggers]
crons = ["*/5 * * * *"]
```

Store your secrets:

```bash
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_API_TOKEN
wrangler secret put DISCORD_WEBHOOK_URL  # optional
```

### Alchemy Setup

If you use [Alchemy](https://github.com/alchemy-run/alchemy) for infrastructure-as-code, provision the KV namespace and Worker together:

```ts
import { KVNamespace, Worker } from "alchemy/cloudflare";

const guardKv = await KVNamespace("usage-guard-kv", {
  title: "usage-guard-state",
});

const worker = await Worker("my-worker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    USAGE_GUARD_KV: guardKv,
    CF_ACCOUNT_ID: alchemy.secret(process.env.CF_ACCOUNT_ID),
    CF_API_TOKEN: alchemy.secret(process.env.CF_API_TOKEN),
    DISCORD_WEBHOOK_URL: alchemy.secret(process.env.DISCORD_WEBHOOK_URL),
    // ... your other bindings
  },
  crons: ["*/5 * * * *"],
});
```

---

## AI / LLM Setup

If you use an AI coding assistant (Cursor, Copilot, Windsurf, Cline, Claude Code, etc.), you can ask it to install and configure everything for you. The package ships with an [`llms.txt`](./llms.txt) file that contains structured instructions for agents, including an interview flow, code generation patterns, and threshold configuration.

**Prompt you can copy-paste into your AI assistant:**

> Install and set up https://github.com/tristanwagner/cf-usage-guard in my Cloudflare Worker to protect against billing overages. Read the llms.txt file from the package and follow its setup guide. Ask me the setup questions, then generate the configuration for my project.

---

## Quick Start

The fastest way to get started -- wraps your Worker and auto-skips `scheduled` handlers when tripped:

```ts
import { withUsageGuard } from "cf-usage-guard";

export default withUsageGuard<Env>(
  {
    kv: (env) => env.USAGE_GUARD_KV,
    accountId: (env) => env.CF_ACCOUNT_ID,
    apiToken: (env) => env.CF_API_TOKEN,
    evaluateCron: "*/5 * * * *",
    alerts: (env) => [{ type: "discord", url: env.DISCORD_WEBHOOK_URL }],
    // budget: { maxUsd: 10, granularity: "weekly" }, // optional global spend cap
    // dryRun: true, // uncomment to test thresholds without tripping
  },
  {
    fetch: app.fetch, // passed through untouched
    scheduled(event, env, ctx) {
      // only called when guard is NOT tripped
    },
    queue: queueHandler, // passed through untouched
  },
);
```

---

## Three Tiers of Protection

```
Tier 1: Passive           Tier 2: Active            Tier 3: Nuclear
(flag + alert)            (proxy wrappers)          (account-level kill)

guard.isTripped()  --->   guardEnv(env, guard)      CF API: disable routes,
guard.trippedResources()  guardKV(env.KV, guard)    remove DNS, kill Worker
                          guardD1(env.DB, guard)
Your code decides         Proxy auto-blocks calls   External system decides
what to do                and throws/skips           (via custom alert handler)
```

Choose the level that fits your risk tolerance. Most apps start with Tier 1 and add Tier 2 for high-cost resources.

- **[Tier 1: Passive Mode](docs/passive-mode.md)** -- check `isTripped()` and decide what to do
- **[Tier 2: Active Mode](docs/active-mode.md)** -- proxy wrappers auto-block operations (`guardEnv`, `guardKV`, etc.)
- **[Tier 3: Nuclear Mode](docs/nuclear-mode.md)** -- account-level actions via custom alert handlers

---

## Supported Services

Every service circuit-breaks by default. All thresholds are overridable. Set `trip: null` to disable circuit breaking for any resource.

| Resource            | CF Service      | Billing Metric         | Monthly Limit | Trip % | Overage $/M |
| ------------------- | --------------- | ---------------------- | ------------- | ------ | ----------- |
| `workers-requests`  | Workers         | Requests               | 10M           | 95     | $0.30       |
| `workers-cpu`       | Workers         | CPU time (us)          | 30B us        | 95     | $0.02       |
| `kv-reads`          | KV              | Read ops               | 10M           | 90     | $0.50       |
| `kv-writes`         | KV              | Write ops              | 1M            | 90     | $5.00       |
| `kv-deletes`        | KV              | Delete ops             | 1M            | 90     | $5.00       |
| `kv-lists`          | KV              | List ops               | 1M            | 90     | $5.00       |
| `d1-reads`          | D1              | Read queries           | 25M           | 90     | $0.001      |
| `d1-writes`         | D1              | Write queries          | 50M           | 90     | $1.00       |
| `r2-class-a`        | R2              | Class A (mutating) ops | 1M            | 90     | $4.50       |
| `r2-class-b`        | R2              | Class B (read) ops     | 10M           | 95     | $0.36       |
| `queue-operations`  | Queues          | Billable ops           | 1M            | 90     | $0.40       |
| `do-requests`       | Durable Objects | Requests               | 1M            | 90     | $0.15       |
| `do-wall-time`      | Durable Objects | Wall time (us)         | 400B us       | 90     | $12.50      |
| `ai-neurons`        | Workers AI      | Neurons                | 10M           | 90     | $0.011      |
| `vectorize-queries` | Vectorize       | Queried dimensions     | 30M           | 90     | $0.01       |
| `pages-requests`    | Pages Functions | Requests               | 10M           | 95     | $0.30       |
| `stream-minutes`    | Stream          | Minutes viewed         | 1K            | 90     | $1,000      |

Resources with trip=95 have a higher threshold because they are harder to reduce from application code (e.g., Workers requests come from external traffic, not your crons).

---

## Configuration

See **[Configuration Guide](docs/configuration.md)** for full details on thresholds, global budget, per-resource granularity, and config validation.

```ts
const guard = createUsageGuard({
  kv: env.USAGE_GUARD_KV,
  accountId: env.CF_ACCOUNT_ID,
  apiToken: env.CF_API_TOKEN,
  billingDay: 1, // day of month billing resets (default: 1)
  budget: { maxUsd: 10, granularity: "weekly" }, // global spend cap
  alerts: [{ type: "discord", url: env.DISCORD_WEBHOOK_URL }],
  dryRun: false, // evaluate without tripping (default: false)
  thresholds: {
    "r2-class-a": { trip: 80, recover: 70 },
    "ai-neurons": { maxOverageUsd: 2 },
    "workers-requests": { trip: null }, // warn only
  },
});
```

## Alerts

See **[Alerts Guide](docs/alerts.md)** for Discord, Slack, custom handlers, deduplication, and logging.

```ts
alerts: [
  { type: "discord", url: "https://discord.com/api/webhooks/..." },
  { type: "slack", url: "https://hooks.slack.com/services/..." },
  { type: "custom", handler: async (event) => { /* ... */ } },
];
```

## Advanced

See **[Advanced Guide](docs/advanced.md)** for dry-run mode, hysteresis, `onEvaluate` hook, manual overrides, and fail-safe behavior.

---

## API Reference

### `createUsageGuard(config): UsageGuard`

Creates a guard instance. Validates config at construction time.

### `UsageGuard`

| Method                                        | Description                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `isTripped(): Promise<boolean>`               | Returns `true` if any resource is over its trip threshold               |
| `isTripped(resource): Promise<boolean>`       | Returns `true` if that specific resource is over threshold              |
| `trippedResources(): Promise<ResourceName[]>` | Returns list of all resources currently over threshold                  |
| `evaluate(): Promise<void>`                   | Full API check: query CF, evaluate thresholds, send alerts, cache state |
| `getState(): Promise<GuardState \| null>`     | Returns current cached state without querying CF                        |
| `trip(reason?): Promise<void>`                | Manually trip the guard. Reason is persisted in state                   |
| `reset(): Promise<void>`                      | Manually reset the guard                                                |

### Proxy Factories

| Function                              | Wraps            | Resources Checked                                  |
| ------------------------------------- | ---------------- | -------------------------------------------------- |
| `guardEnv(env, guard, opts?)`         | All bindings     | Auto-detected per binding                          |
| `guardKV(kv, guard, opts?)`           | `KVNamespace`    | `kv-reads`, `kv-writes`, `kv-deletes`, `kv-lists`  |
| `guardD1(db, guard, opts?)`           | `D1Database`     | `d1-reads`, `d1-writes`                            |
| `guardR2(bucket, guard, opts?)`       | `R2Bucket`       | `r2-class-a`, `r2-class-b`                         |
| `guardQueue(queue, guard, opts?)`     | `Queue`          | `queue-operations`                                 |
| `guardAI(ai, guard, opts?)`          | `Ai`             | `ai-neurons`                                       |
| `guardVectorize(index, guard, opts?)` | `VectorizeIndex` | `vectorize-queries`                                |

Proxy options:

```ts
{
  onTrip?: "throw" | "skip" | (resource: string, method: string) => void;
  exclude?: string[];  // guardEnv only: binding names to skip
}
```

### `UsageGuardError`

Thrown by proxies in `"throw"` mode (the default):

```ts
class UsageGuardError extends Error {
  readonly resource: ResourceName; // e.g. "kv-writes"
  readonly method: string; // e.g. "put"
}
```

### Constants

```ts
import {
  RESOURCES, // Resource name constants (e.g. RESOURCES.KV_WRITES)
  DEFAULT_THRESHOLDS, // Default thresholds per resource (for restore after override)
  ALERT_LEVELS, // "warn" | "trip" | "recover"
  ALERT_CHANNEL_TYPES, // "discord" | "slack" | "custom"
  TRIP_REASONS, // "threshold" | "manual"
  TRANSITIONS, // "trip" | "recover"
} from "cf-usage-guard";
```

---

## Known Limitations

- **Analytics delay**: CF GraphQL data can lag 1-5 minutes behind real usage. The guard cannot prevent overages that happen faster than your cron interval + this delay. Set conservative thresholds (80-85%) if you have bursty workloads.
- **Account-level only**: Usage is per-account, not per-Worker. If you run multiple Workers, the guard monitors total account consumption.
- **No storage monitoring**: The CF Analytics API exposes operation counts but not storage (GB stored in R2, D1, DO). Storage monitoring is on the roadmap.
- **No request-level rate limiting**: The guard doesn't rate-limit individual fetch requests. Use CF WAF rate-limiting rules for that. The guard operates at the billing-period level.

## Roadmap

- [ ] Daily/weekly usage summary report to Discord/Slack
- [ ] Cost estimation and projection ("at this rate, you'll hit the limit on day X")
- [ ] R2 storage monitoring (GB stored, requires separate API call)
- [ ] Durable Objects storage monitoring (GB stored)
- [ ] Hyperdrive connection monitoring
- [ ] Workers Workflows step monitoring
- [ ] Analytics Engine write monitoring
- [ ] Email Routing monitoring
- [ ] `guardDO` proxy (Durable Object namespace wrapping)
- [ ] Dashboard UI component (embeddable usage chart)

## A Note to Cloudflare

This library should not need to exist. Every major cloud provider should offer budget alerts and spend caps. Cloudflare already pauses websites that exceed bandwidth on the Free plan, the infrastructure to pause at a limit clearly exists.

Yet on the Workers Paid Plan ($5/mo), there is no way to set a spending cap, no way to auto-pause at a limit, and no notification when you blow past your included usage. A single retry loop can burn through 1M KV writes ($5) in minutes, and you won't know until the invoice arrives.

The data is already there (the GraphQL Analytics API this library queries). The circuit-breaking logic is trivial. Cloudflare could ship a "pause at X% usage" toggle in the dashboard tomorrow. Until they do, this library fills the gap.

## Prior Art

- [PizzaConsole](https://pizzaconsole.com/blog/posts/programming/cf-overage) -- standalone watchdog Worker (DNS/route kill-switch approach)
- [Yingjie Zhao](https://yingjiezhao.com/en/articles/Usage-Circuit-Breaker-for-Cloudflare-Workers) -- embedded circuit breaker concept (blog post, not published as a package)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commands, and PR guidelines.

## License

MIT
