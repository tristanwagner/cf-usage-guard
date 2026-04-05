# Alerts

## Discord

```ts
alerts: [{ type: "discord", url: "https://discord.com/api/webhooks/..." }];
```

## Slack

```ts
alerts: [{ type: "slack", url: "https://hooks.slack.com/services/..." }];
```

## Custom

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

## Alert Deduplication

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
