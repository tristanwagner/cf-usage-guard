import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, getBillingPeriod, getBillingPeriodEnd } from "../query";
import { validateAndResolve } from "../validation";
import { createMockKV, mockGraphQLResponse, setupFetchMock } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getBillingPeriod", () => {
	it("returns current month when today >= billingDay", () => {
		const now = new Date("2026-04-15T00:00:00Z");
		const period = getBillingPeriod(1, now);
		expect(period.start).toBe("2026-04-01");
		expect(period.end).toBe("2026-04-15");
	});

	it("returns previous month when today < billingDay", () => {
		const now = new Date("2026-04-05T00:00:00Z");
		const period = getBillingPeriod(15, now);
		expect(period.start).toBe("2026-03-15");
		expect(period.end).toBe("2026-04-05");
	});

	it("clamps billingDay to last day of month (Feb)", () => {
		const now = new Date("2026-02-15T00:00:00Z");
		const period = getBillingPeriod(31, now);
		expect(period.start).toBe("2026-01-31");
		expect(period.end).toBe("2026-02-15");
	});

	it("clamps billingDay in Feb when today >= clamped day", () => {
		const now = new Date("2026-02-28T00:00:00Z");
		const period = getBillingPeriod(31, now);
		expect(period.start).toBe("2026-02-28");
		expect(period.end).toBe("2026-02-28");
	});

	it("handles leap year Feb 29", () => {
		const now = new Date("2028-02-29T00:00:00Z");
		const period = getBillingPeriod(31, now);
		expect(period.start).toBe("2028-02-29");
		expect(period.end).toBe("2028-02-29");
	});

	it("handles January with billingDay from previous year", () => {
		const now = new Date("2026-01-05T00:00:00Z");
		const period = getBillingPeriod(15, now);
		expect(period.start).toBe("2025-12-15");
		expect(period.end).toBe("2026-01-05");
	});

	it("handles billingDay = 1 on the 1st", () => {
		const now = new Date("2026-04-01T00:00:00Z");
		const period = getBillingPeriod(1, now);
		expect(period.start).toBe("2026-04-01");
		expect(period.end).toBe("2026-04-01");
	});
});

describe("getBillingPeriodEnd", () => {
	it("returns next month when today >= billingDay", () => {
		const now = new Date("2026-04-15T00:00:00Z");
		const end = getBillingPeriodEnd(1, now);
		expect(end.toISOString().split("T")[0]).toBe("2026-05-01");
	});

	it("returns current month when today < billingDay", () => {
		const now = new Date("2026-04-05T00:00:00Z");
		const end = getBillingPeriodEnd(15, now);
		expect(end.toISOString().split("T")[0]).toBe("2026-04-15");
	});

	it("clamps to last day of next month", () => {
		const now = new Date("2026-01-31T00:00:00Z");
		const end = getBillingPeriodEnd(31, now);
		expect(end.toISOString().split("T")[0]).toBe("2026-02-28");
	});

	it("handles December rollover to January", () => {
		const now = new Date("2026-12-15T00:00:00Z");
		const end = getBillingPeriodEnd(1, now);
		expect(end.toISOString().split("T")[0]).toBe("2027-01-01");
	});
});

describe("fetchUsage", () => {
	function resolvedConfig() {
		return validateAndResolve({
			kv: createMockKV(),
			accountId: "test-account",
			apiToken: "test-token",
		});
	}

	it("parses workers requests and CPU", async () => {
		setupFetchMock(mockGraphQLResponse({ requests: 5_000_000, cpuTimeUs: 15_000_000_000 }));

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		const workers = result.resources.find((r) => r.name === "workers-requests");
		const cpu = result.resources.find((r) => r.name === "workers-cpu");

		expect(workers?.current).toBe(5_000_000);
		expect(workers?.percent).toBe(50);
		expect(cpu?.current).toBe(15_000_000_000);
		expect(cpu?.percent).toBe(50);
	});

	it("parses KV operations by action type", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				kvGroups: [
					{ actionType: "read", requests: 8_000_000 },
					{ actionType: "write", requests: 500_000 },
					{ actionType: "delete", requests: 100_000 },
					{ actionType: "list", requests: 50_000 },
				],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "kv-reads")?.current).toBe(8_000_000);
		expect(result.resources.find((r) => r.name === "kv-writes")?.current).toBe(500_000);
		expect(result.resources.find((r) => r.name === "kv-deletes")?.current).toBe(100_000);
		expect(result.resources.find((r) => r.name === "kv-lists")?.current).toBe(50_000);
	});

	it("parses D1 reads and writes", async () => {
		setupFetchMock(mockGraphQLResponse({ d1Reads: 12_000_000, d1Writes: 25_000_000 }));

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "d1-reads")?.current).toBe(12_000_000);
		expect(result.resources.find((r) => r.name === "d1-writes")?.current).toBe(25_000_000);
	});

	it("classifies R2 operations into class A and B", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				r2Groups: [
					{ actionType: "PutObject", requests: 300_000 },
					{ actionType: "GetObject", requests: 5_000_000 },
					{ actionType: "HeadObject", requests: 1_000_000 },
					{ actionType: "DeleteObject", requests: 50_000 },
					{ actionType: "ListObjects", requests: 200_000 },
				],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-a")?.current).toBe(350_000);
		expect(result.resources.find((r) => r.name === "r2-class-b")?.current).toBe(6_200_000);
	});

	it("classifies unknown R2 action types as class A", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				r2Groups: [{ actionType: "UnknownAction", requests: 100_000 }],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-a")?.current).toBe(100_000);
	});

	it("parses queue operations", async () => {
		setupFetchMock(mockGraphQLResponse({ queueOps: 750_000 }));

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "queue-operations")?.current).toBe(750_000);
	});

	it("calculates percent and estimated overage", async () => {
		setupFetchMock(
			mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 1_200_000 }] }),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		const kvWrites = result.resources.find((r) => r.name === "kv-writes");
		expect(kvWrites?.percent).toBe(120);
		expect(kvWrites?.estimatedOverage).toBe(1);
	});

	it("throws on non-200 response", async () => {
		setupFetchMock({}, 500);

		await expect(fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"))).rejects.toThrow(
			"CF GraphQL API returned 500",
		);
	});

	it("throws on GraphQL errors", async () => {
		setupFetchMock({ errors: [{ message: "Auth failed" }] });

		await expect(fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"))).rejects.toThrow(
			"CF GraphQL errors: Auth failed",
		);
	});

	it("throws when no account data returned", async () => {
		setupFetchMock({ data: { viewer: { accounts: [] } } });

		await expect(fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"))).rejects.toThrow(
			"No account data",
		);
	});

	it("handles missing/null fields gracefully (defaults to 0)", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [],
							queueMessageOperationsAdaptiveGroups: [{ sum: {} }],
						},
					],
				},
			},
		});

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		for (const r of result.resources) {
			expect(r.current).toBe(0);
			expect(r.percent).toBe(0);
		}
	});

	it("handles completely missing adaptive groups", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [{}],
				},
			},
		});

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		for (const r of result.resources) {
			expect(r.current).toBe(0);
		}
	});

	it("handles KV list operations", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				kvGroups: [{ actionType: "list", requests: 50_000 }],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "kv-lists")?.current).toBe(50_000);
	});

	it("handles KV group with unrecognized actionType (ignored)", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				kvGroups: [{ actionType: "unknown_op", requests: 999 }],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "kv-reads")?.current).toBe(0);
		expect(result.resources.find((r) => r.name === "kv-writes")?.current).toBe(0);
	});

	it("handles R2 group with null dimensions", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [{ dimensions: null, sum: { requests: 100 } }],
							queueMessageOperationsAdaptiveGroups: [{ sum: {} }],
						},
					],
				},
			},
		});

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-a")?.current).toBe(100);
	});

	it("handles R2 ListBuckets as class B", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				r2Groups: [
					{ actionType: "ListBuckets", requests: 200 },
					{ actionType: "ListMultipartUploads", requests: 300 },
					{ actionType: "ListParts", requests: 400 },
				],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-b")?.current).toBe(900);
	});

	it("handles R2 mutating operations as class A", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				r2Groups: [
					{ actionType: "CopyObject", requests: 100 },
					{ actionType: "CreateMultipartUpload", requests: 200 },
					{ actionType: "CompleteMultipartUpload", requests: 50 },
					{ actionType: "UploadPart", requests: 300 },
					{ actionType: "DeleteObjects", requests: 150 },
				],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-a")?.current).toBe(800);
	});

	it("handles null queue billableOperations", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [],
							queueMessageOperationsAdaptiveGroups: [{ sum: { billableOperations: null } }],
						},
					],
				},
			},
		});

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "queue-operations")?.current).toBe(0);
	});

	it("handles KV group with null actionType", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [
								{ dimensions: { actionType: null }, sum: { requests: 100 } },
							],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [],
							queueMessageOperationsAdaptiveGroups: [{ sum: {} }],
						},
					],
				},
			},
		});

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "kv-reads")?.current).toBe(0);
	});

	it("handles KV group with missing sum.requests", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [{ dimensions: { actionType: "read" }, sum: {} }],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [],
							queueMessageOperationsAdaptiveGroups: [{ sum: {} }],
						},
					],
				},
			},
		});
		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "kv-reads")?.current).toBe(0);
	});

	it("handles R2 group with missing sum.requests", async () => {
		setupFetchMock({
			data: {
				viewer: {
					accounts: [
						{
							workersInvocationsAdaptive: [{ sum: {} }],
							kvOperationsAdaptiveGroups: [],
							d1AnalyticsAdaptiveGroups: [{ sum: {} }],
							r2OperationsAdaptiveGroups: [{ dimensions: { actionType: "GetObject" }, sum: {} }],
							queueMessageOperationsAdaptiveGroups: [{ sum: {} }],
						},
					],
				},
			},
		});
		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-b")?.current).toBe(0);
	});

	it("includes fetchedAt timestamp", async () => {
		setupFetchMock(mockGraphQLResponse());
		const now = new Date("2026-04-15T12:30:00Z");
		const result = await fetchUsage(resolvedConfig(), now);
		expect(result.fetchedAt).toBe("2026-04-15T12:30:00.000Z");
	});

	it("handles R2 group with missing actionType (defaults to class A)", async () => {
		setupFetchMock(
			mockGraphQLResponse({
				r2Groups: [{ actionType: "", requests: 50_000 }],
			}),
		);

		const result = await fetchUsage(resolvedConfig(), new Date("2026-04-15T00:00:00Z"));
		expect(result.resources.find((r) => r.name === "r2-class-a")?.current).toBe(50_000);
	});
});
