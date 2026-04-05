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

## How It Works

```
1. You dedicate a cron (e.g. */5 * * * *) to call guard.evaluate()

2. evaluate() queries the CF GraphQL API for account-level usage
   across all 17 monitored resource types in a single request

3. Each resource is compared against configurable thresholds:

   |-- Normal (< 80%) --|-- Warning (>= 80%) --|-- Tripped (>= 90%) --|
                         |                      |
                         v                      v
                    One-time alert         Guard trips
                    per billing period     isTripped() = true

4. Depending on your tier:

   Passive: Your code checks isTripped() and decides
   Active:  Proxy wrappers automatically block operations
   Nuclear: Custom alert handler triggers account-level action

5. Hysteresis prevents flapping:
   Trip at 90%, recover only when ALL resources drop below 85%
```

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

## Tier 1: Passive Mode

Your code checks `isTripped()` and decides what to do. Maximum control, zero magic.

```ts
import { createUsageGuard, RESOURCES } from "cf-usage-guard";
import type { UsageGuard } from "cf-usage-guard";

let guard: UsageGuard | null = null;

export default {
  async scheduled(event, env, ctx) {
    guard ??= createUsageGuard({
      kv: env.USAGE_GUARD_KV,
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      alerts: [{ type: "discord", url: env.DISCORD_WEBHOOK_URL }],
    });

    // Dedicate one cron to the usage check
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(guard.evaluate());
      return;
    }

    // Skip all crons if anything is tripped
    if (await guard.isTripped()) return;

    // ... your normal cron logic
  },

  async fetch(request, env, ctx) {
    guard ??= createUsageGuard({
      /* ... */
    });

    // Per-resource gating in fetch handlers
    if (await guard.isTripped(RESOURCES.KV_WRITES)) {
      return cachedResponse(); // degrade gracefully
    }

    if (await guard.isTripped(RESOURCES.D1_WRITES)) {
      return new Response("Write operations paused", { status: 503 });
    }

    // normal request handling
  },
};
```

### Per-Resource Gating Patterns

```ts
// Check a specific resource
if (await guard.isTripped(RESOURCES.KV_WRITES)) {
  // Skip KV writes, use in-memory cache
}

// Get all tripped resources at once
const tripped = await guard.trippedResources();
if (tripped.includes(RESOURCES.D1_WRITES)) {
  // Queue writes for later instead of writing to D1
}
if (tripped.includes(RESOURCES.R2_CLASS_A)) {
  // Skip R2 uploads, return 503
}
```

---

## Tier 2: Active Mode (Proxy Wrappers)

Wrap your CF bindings with guard-aware proxies. Operations are automatically blocked when the relevant resource trips. No manual `isTripped()` checks needed.

### `guardEnv` -- Seamless (Recommended)

Auto-detects all CF bindings in your env and wraps them in one call. Your existing code doesn't change at all:

```ts
import { createUsageGuard, guardEnv } from "cf-usage-guard";
import type { UsageGuard } from "cf-usage-guard";

let guard: UsageGuard | null = null;

export default {
  async fetch(request, env, ctx) {
    guard ??= createUsageGuard({
      kv: env.USAGE_GUARD_KV,
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      alerts: [{ type: "discord", url: env.DISCORD_WEBHOOK_URL }],
    });

    // One line: all bindings are now guarded
    // The guard's own KV is auto-excluded by reference -- no config needed
    env = guardEnv(env, guard);

    // Your existing code works unchanged -- calls throw when tripped
    await env.MY_KV.put("key", "value"); // guarded: kv-writes
    await env.MY_DB.prepare("SELECT 1").first(); // guarded: d1-reads
    await env.MY_BUCKET.put("file", data); // guarded: r2-class-a
    await env.MY_QUEUE.send({ task: "go" }); // guarded: queue-operations
    await env.AI.run("@cf/meta/llama-3", {}); // guarded: ai-neurons
    await env.MY_INDEX.query([1, 2, 3], { topK: 5 }); // guarded: vectorize-queries
  },

  async scheduled(event, env, ctx) {
    guard ??= createUsageGuard({
      /* ... */
    });

    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(guard.evaluate());
      return;
    }

    // Guard all cron work too
    env = guardEnv(env, guard);

    // Your cron logic -- automatically protected
    await env.MY_DB.prepare("INSERT INTO ...").run();
  },
};
```

The guard's own KV namespace is **auto-excluded by reference**, no need to pass `exclude`. Use `exclude` only if you have additional bindings you want to skip:

```ts
env = guardEnv(env, guard, { exclude: ["ANALYTICS_KV"] });
```

Detection uses duck-typing: `prepare` + `batch` = D1, `getWithMetadata` = KV, `createMultipartUpload` = R2, `send` + `sendBatch` = Queue, `run` = AI, `query` + `insert` + `describe` = Vectorize. Non-binding values (strings, numbers, secrets) pass through untouched.

### Per-Binding Wrapping

For finer control, wrap individual bindings:

```ts
import {
  createUsageGuard,
  guardKV,
  guardD1,
  guardR2,
  guardQueue,
  guardAI,
  guardVectorize,
} from "cf-usage-guard";

const guard = createUsageGuard({
  /* ... */
});

const kv = guardKV(env.MY_KV, guard);
const db = guardD1(env.MY_DB, guard);
const bucket = guardR2(env.MY_BUCKET, guard);
const queue = guardQueue(env.MY_QUEUE, guard);
const ai = guardAI(env.AI, guard);
const index = guardVectorize(env.MY_INDEX, guard);

// Drop-in replacements -- same API as the original bindings
await kv.put("key", "value"); // throws UsageGuardError if kv-writes >= 90%
await db.prepare("INSERT ...").run(); // throws UsageGuardError if d1-writes >= 90%
await bucket.put("file", data); // throws UsageGuardError if r2-class-a >= 90%
await queue.send({ task: "process" }); // throws UsageGuardError if queue-operations >= 90%
await ai.run("@cf/meta/llama-3", {}); // throws UsageGuardError if ai-neurons >= 90%
await index.query([1, 2, 3], { topK: 5 }); // throws UsageGuardError if vectorize-queries >= 90%
```

### Operation-to-Resource Mapping

Each proxy knows which operations map to which billing metric:

| Proxy             | Method                                            | Resource Checked     |
| ----------------- | ------------------------------------------------- | -------------------- |
| `guardKV`         | `get`, `getWithMetadata`                          | `kv-reads`           |
| `guardKV`         | `put`                                             | `kv-writes`          |
| `guardKV`         | `delete`                                          | `kv-deletes`         |
| `guardKV`         | `list`                                            | `kv-lists`           |
| `guardD1`         | `prepare().first()`, `.all()`, `.raw()`, `dump()` | `d1-reads`           |
| `guardD1`         | `prepare().run()`, `batch()`, `exec()`            | `d1-writes`          |
| `guardR2`         | `get`, `head`, `list`                             | `r2-class-b`         |
| `guardR2`         | `put`, `delete`, `createMultipartUpload`          | `r2-class-a`         |
| `guardQueue`      | `send`, `sendBatch`                               | `queue-operations`   |
| `guardAI`         | `run`                                             | `ai-neurons`         |
| `guardVectorize`  | `query`                                           | `vectorize-queries`  |

### Trip Behaviors

By default, proxies throw `UsageGuardError`. You can change this per-binding or globally via `guardEnv`:

```ts
import { UsageGuardError } from "cf-usage-guard";

// --- "throw" (default) ---
// Caller must catch and handle
const kv = guardKV(env.MY_KV, guard, { onTrip: "throw" });

try {
  await kv.put("key", "value");
} catch (err) {
  if (err instanceof UsageGuardError) {
    console.log(err.resource); // "kv-writes"
    console.log(err.method); // "put"
    // fall back to in-memory cache, return 503, etc.
  }
}

// --- "skip" ---
// Silent no-op: operation is dropped, no error thrown
const kv = guardKV(env.MY_KV, guard, { onTrip: "skip" });
await kv.put("key", "value"); // silently does nothing when tripped

// Works with guardEnv too:
env = guardEnv(env, guard, { onTrip: "skip" });

// --- Custom callback ---
// Your logic decides what happens
const kv = guardKV(env.MY_KV, guard, {
  onTrip: (resource, method) => {
    metrics.increment(`guard.blocked.${resource}.${method}`);
    // don't throw = operation is silently skipped
    // throw = caller sees the error
  },
});
```

### Mixing Passive and Active

You can use active proxies for high-cost resources and passive checks for everything else:

```ts
// Active: automatically block expensive KV and D1 writes
const kv = guardKV(env.MY_KV, guard);
const db = guardD1(env.MY_DB, guard);

// Passive: manually check cheaper resources
if (await guard.isTripped(RESOURCES.WORKERS_REQUESTS)) {
  // shed load at the fetch handler level
}
```

---

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

---

## Tier 3: Nuclear Mode (Account-Level Actions)

For teams that want to go beyond application-level protection and take account-wide action when usage spikes. This is **not built into the library** because:

1. It runs inside the Worker it would be killing
2. It requires elevated API permissions (not just Analytics:Read)
3. Wrong call = outage or data loss

Instead, the guard sends the **signal** via alerts. Your external system takes action.

### Example: Disable Worker Routes

```ts
alerts: [
  {
    type: "custom",
    handler: async (event) => {
      // Call an external ops API that has CF Admin permissions
      await fetch("https://ops.example.com/circuit-break", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPS_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "disable-routes",
          resources: event.resources.map((r) => r.name),
          account: event.accountId,
        }),
      });
    },
  },
];

// ops.example.com implementation:
// Uses CF API with Zone:Edit permission
// DELETE https://api.cloudflare.com/client/v4/zones/{zone_id}/workers/routes/{route_id}
```

### Example: DNS Failover to Static Page

```ts
alerts: [
  {
    type: "custom",
    handler: async (event) => {
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${CF_ADMIN_TOKEN}` },
          body: JSON.stringify({
            content: MAINTENANCE_PAGE_IP,
            ttl: 60,
          }),
        },
      );
    },
  },
];
```

### Example: PagerDuty Escalation

```ts
alerts: [
  {
    type: "custom",
    handler: async (event) => {
      const overBudget = event.resources
        .filter((r) => r.percent >= 90)
        .map((r) => `${r.name}: ${r.percent.toFixed(1)}%`)
        .join(", ");

      await fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        body: JSON.stringify({
          routing_key: PAGERDUTY_KEY,
          event_action: "trigger",
          payload: {
            summary: `CF usage guard tripped: ${overBudget}`,
            severity: "critical",
            source: "cf-usage-guard",
          },
        }),
      });
    },
  },
];
```

### Example: Wrangler Rollback via GitHub Actions

```ts
// 1. Guard trips -> webhook to GitHub
// 2. GitHub Action runs: wrangler deployments rollback
// 3. Worker rolls back to a safe version

alerts: [
  {
    type: "custom",
    handler: async (event) => {
      await fetch("https://api.github.com/repos/you/your-worker/dispatches", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({
          event_type: "usage-guard-trip",
          client_payload: {
            resources: event.resources.map((r) => r.name),
          },
        }),
      });
    },
  },
];
```

### Strategy Comparison

| Strategy              | Permissions Needed | Reversible?        | Downtime              | Best For                     |
| --------------------- | ------------------ | ------------------ | --------------------- | ---------------------------- |
| Disable Worker routes | Zone:Edit          | Yes (re-add route) | Full                  | Cost protection at all costs |
| DNS failover          | DNS:Edit           | Yes (flip back)    | Partial (static page) | Public-facing sites          |
| Wrangler rollback     | CI/CD access       | Yes (redeploy)     | Brief                 | Automated recovery           |
| Scale down crons      | None (app-level)   | Yes                | None                  | Background job control       |
| PagerDuty/Opsgenie    | None               | N/A                | None                  | Human-in-the-loop            |
| Queue drain + pause   | Queue:Edit         | Yes                | Partial               | Queue-heavy workloads        |

---

## Configuration

```ts
interface UsageGuardConfig {
  // Required
  kv: KVNamespace; // KV namespace for state + alert dedup
  accountId: string; // Cloudflare account ID
  apiToken: string; // CF API token (Account Analytics: Read)

  // Thresholds
  billingDay?: number; // Day of month billing resets (default: 1)
  thresholds?: Partial<Record<ResourceName, Partial<ResourceThreshold>>>;

  // Alerts
  alerts?: AlertChannel[]; // Discord, Slack, or custom handlers
  alertTimeout?: number; // Custom handler timeout in ms (default: 10000)

  // Hooks
  onEvaluate?: (event: EvaluateEvent) => void | Promise<void>;

  // Advanced
  dryRun?: boolean; // Evaluate without tripping (default: false)
  logger?: Logger; // Optional { warn, error, debug } logger
  keyPrefix?: string; // KV key prefix (default: "cfug:")
}
```

### Threshold Configuration

Each resource has seven tunable values. A resource trips when **any** condition is met:

```ts
interface ResourceThreshold {
  limit: number; // Monthly included amount (auto-set from CF plan defaults)
  warn: number; // Percentage to trigger warning alert (default: 80)
  trip: number | null; // Percentage to trip circuit breaker (default: 90, null = disabled)
  recover: number; // Percentage to auto-recover (default: trip - 5)
  overageCost: number; // Cost per million over limit (for alert messages + budget calc)
  tripAt: number | null; // Absolute unit count to trip at (default: null)
  maxOverageUsd: number | null; // Dollar budget -- trip when overage cost exceeds this (default: null)
}
```

Trip conditions (any one triggers):

- **Percentage**: `current / limit >= trip%`
- **Absolute**: `current >= tripAt` (raw units -- requests, queries, neurons, etc.)
- **Budget**: `overageCost * max(0, current - limit) / 1M >= maxOverageUsd`

Example overrides:

```ts
const guard = createUsageGuard({
  // ...
  thresholds: {
    // More aggressive: trip earlier on expensive resources
    "r2-class-a": { trip: 80, recover: 70 },

    // Less aggressive: warn-only for resources you can't control
    "workers-requests": { trip: null },

    // Combine percentage + unit cap + dollar budget on a single resource
    "kv-writes": { trip: 85, recover: 80, tripAt: 900_000, maxOverageUsd: 5 },

    // Dollar budget on AI: allow up to $2 in neuron overages
    "ai-neurons": { maxOverageUsd: 2 },

    // Trip at 90% OR $10 overage, whichever comes first
    "d1-writes": { trip: 90, maxOverageUsd: 10 },

    // Absolute + dollar: trip at 2M ops OR $3 overage
    "queue-operations": { tripAt: 2_000_000, maxOverageUsd: 3 },

    // Custom limits: if your plan differs from defaults
    "d1-reads": { limit: 50_000_000 },
  },
});
```

### Config Validation

`createUsageGuard()` validates at construction time and throws on:

- Empty `accountId` or `apiToken`
- `recover >= trip` (guard can never recover)
- `warn >= trip` (warn fires after trip -- useless)
- Negative or >100 percentages
- `billingDay` outside 1-31
- `keyPrefix` not ending with `:`
- `tripAt <= 0` or `maxOverageUsd <= 0`

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

## Alerts

### Discord

```ts
alerts: [{ type: "discord", url: "https://discord.com/api/webhooks/..." }];
```

### Slack

```ts
alerts: [{ type: "slack", url: "https://hooks.slack.com/services/..." }];
```

### Custom

```ts
alerts: [
  {
    type: "custom",
    handler: async (event) => {
      // event.level: "warn" | "trip" | "recover"
      // event.resources: ResourceStatus[]
      // event.accountId: string (masked)
      await myAlertService.send(event);
    },
  },
];
```

Custom handlers are wrapped in a timeout (default 10s, configurable via `alertTimeout`). Dedup markers are only written when at least one channel delivers successfully -- if all channels fail, the alert retries on the next `evaluate()`.

### Alert Deduplication

Alerts fire once per resource per billing period per level. If KV writes hits 80% (warn), you get one warning. If it then hits 90% (trip), you get one trip alert. It won't repeat until the next billing period resets.

## Logging

The guard defaults to a silent noop logger. It logs internally on KV failures, API errors, state reconciliation, and manual trip/reset -- but you won't see any of it unless you pass a `logger`. In production, you should always wire one up so you can debug issues:

```ts
const guard = createUsageGuard({
  // ...
  logger: {
    warn: (msg, meta) => console.warn(`[cf-usage-guard] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[cf-usage-guard] ${msg}`, meta ?? ""),
    debug: (msg, meta) => console.log(`[cf-usage-guard] ${msg}`, meta ?? ""),
  },
});
```

Or plug in your existing structured logger (pino, winston, etc.) -- the interface is just `{ warn, error, debug }` with an optional metadata object.

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
| `guardAI(ai, guard, opts?)`           | `Ai`             | `ai-neurons`                                       |
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
