# Tier 1: Passive Mode

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

## Per-Resource Gating Patterns

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
