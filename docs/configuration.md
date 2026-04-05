# Configuration

```ts
interface UsageGuardConfig {
  // Required
  kv: KVNamespace; // KV namespace for state + alert dedup
  accountId: string; // Cloudflare account ID
  apiToken: string; // CF API token (Account Analytics: Read)

  // Thresholds
  billingDay?: number; // Day of month billing resets (default: 1)
  thresholds?: Partial<Record<ResourceName, Partial<ResourceThreshold>>>;
  budget?: BudgetConfig; // Global spend cap across all resources

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

## Threshold Configuration

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
- **Per-resource budget**: `overageCost * max(0, current - limit) / 1M >= maxOverageUsd`

### Example Overrides

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

## Global Budget

The `budget` option sets an account-wide spending cap across all resources. Unlike per-resource `maxOverageUsd` (which trips a single resource), the global budget sums estimated overage costs from every resource and trips when the total exceeds your cap.

```ts
const guard = createUsageGuard({
  // ...required config...
  budget: {
    maxUsd: 10, // trip when total overage cost exceeds $10
    granularity: "weekly", // evaluation window: "daily" | "weekly" | "monthly" (default: "monthly")
    warn: 80, // warning alert at 80% of maxUsd (default: 80)
  },
});
```

```ts
interface BudgetConfig {
  maxUsd: number; // Trip when total overage exceeds this amount
  warn?: number; // Warning at % of maxUsd (default: 80)
  granularity?: Granularity; // "daily" | "weekly" | "monthly" (default: "monthly")
}
```

When the global budget trips:

- Only resources with overage > $0 get blocked -- zero-overage resources stay open.
- The budget status (`totalOverageUsd`, `maxUsd`, `percent`) is persisted in guard state and available via `getState()`.
- Works alongside per-resource thresholds -- both can independently trip the guard.

## Per-Resource Granularity

Each threshold can use a different evaluation window:

```ts
thresholds: {
  // Evaluate AI neurons on a daily basis instead of monthly
  "ai-neurons": { granularity: "daily" },

  // Weekly window for KV writes
  "kv-writes": { granularity: "weekly" },
}
```

When non-monthly granularities are configured, additional CF API queries are issued for the relevant time windows.

## Config Validation

`createUsageGuard()` validates at construction time and throws on:

- Empty `accountId` or `apiToken`
- `recover >= trip` (guard can never recover)
- `warn >= trip` (warn fires after trip -- useless)
- Negative or >100 percentages
- `billingDay` outside 1-31
- `keyPrefix` not ending with `:`
- `tripAt <= 0` or `maxOverageUsd <= 0`
