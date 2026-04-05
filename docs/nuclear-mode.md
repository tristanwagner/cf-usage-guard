# Tier 3: Nuclear Mode (Account-Level Actions)

For teams that want to go beyond application-level protection and take account-wide action when usage spikes. This is **not built into the library** because:

1. It runs inside the Worker it would be killing
2. It requires elevated API permissions (not just Analytics:Read)
3. Wrong call = outage or data loss

Instead, the guard sends the **signal** via alerts. Your external system takes action.

## Example: Disable Worker Routes

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

## Example: DNS Failover to Static Page

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

## Example: PagerDuty Escalation

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

## Example: Wrangler Rollback via GitHub Actions

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

## Strategy Comparison

| Strategy              | Permissions Needed | Reversible?        | Downtime              | Best For                     |
| --------------------- | ------------------ | ------------------ | --------------------- | ---------------------------- |
| Disable Worker routes | Zone:Edit          | Yes (re-add route) | Full                  | Cost protection at all costs |
| DNS failover          | DNS:Edit           | Yes (flip back)    | Partial (static page) | Public-facing sites          |
| Wrangler rollback     | CI/CD access       | Yes (redeploy)     | Brief                 | Automated recovery           |
| Scale down crons      | None (app-level)   | Yes                | None                  | Background job control       |
| PagerDuty/Opsgenie    | None               | N/A                | None                  | Human-in-the-loop            |
| Queue drain + pause   | Queue:Edit         | Yes                | Partial               | Queue-heavy workloads        |
