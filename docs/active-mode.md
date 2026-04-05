# Tier 2: Active Mode (Proxy Wrappers)

Wrap your CF bindings with guard-aware proxies. Operations are automatically blocked when the relevant resource trips. No manual `isTripped()` checks needed.

## `guardEnv` -- Seamless (Recommended)

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

## Per-Binding Wrapping

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

## Operation-to-Resource Mapping

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

## Trip Behaviors

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

## Mixing Passive and Active

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
