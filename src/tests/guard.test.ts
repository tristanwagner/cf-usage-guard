import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageGuard } from "../guard";
import type { GuardState } from "../types";
import { createFailingKV, createMockKV, mockGraphQLResponse, setupFetchMock } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeGuard(overrides?: Record<string, unknown>) {
	const kv = createMockKV();
	const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const guard = createUsageGuard({
		kv,
		accountId: "test-account",
		apiToken: "test-token",
		logger,
		...overrides,
	});
	return { guard, kv, logger };
}

describe("isTripped", () => {
	it("returns false when no state exists", async () => {
		const { guard } = makeGuard();
		expect(await guard.isTripped()).toBe(false);
	});

	it("returns true when state key says tripped", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		expect(await guard.isTripped()).toBe(true);
	});

	it("returns true when tripped safety net key exists", async () => {
		const { guard, kv } = makeGuard();
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		expect(await guard.isTripped()).toBe(true);
	});

	it("returns true when state says not tripped but safety net key exists", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: false,
			trippedAt: null,
			tripReason: null,
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		expect(await guard.isTripped()).toBe(true);
	});

	it("returns false when KV fails (fail-open)", async () => {
		const guard = createUsageGuard({
			kv: createFailingKV(),
			accountId: "test",
			apiToken: "test",
			logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});
		expect(await guard.isTripped()).toBe(false);
	});

	it("uses custom keyPrefix", async () => {
		const kv = createMockKV();
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			keyPrefix: "myapp:",
		});
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("myapp:state:v1", JSON.stringify(state));
		expect(await guard.isTripped()).toBe(true);
	});
});

describe("evaluate", () => {
	it("saves state with resource data after successful check", async () => {
		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 500_000 }] }));
		const { guard, kv } = makeGuard();

		await guard.evaluate();

		const raw = await kv.get("cfug:state:v1");
		expect(raw).not.toBeNull();
		const state = JSON.parse(raw!) as GuardState;
		expect(state.version).toBe(1);
		expect(state.tripped).toBe(false);
		expect(state.resources.length).toBeGreaterThan(0);
	});

	it("trips when trippable resource exceeds trip threshold", async () => {
		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 950_000 }] }));
		const { guard, kv } = makeGuard();

		await guard.evaluate();

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(true);
		expect(state.tripReason).toBe("threshold");

		const trippedKey = await kv.get("cfug:tripped");
		expect(trippedKey).not.toBeNull();
	});

	it("recovers when all trippable resources drop below recover threshold", async () => {
		const { guard, kv } = makeGuard();

		const trippedState: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(trippedState));
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");

		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 100_000 }] }));
		await guard.evaluate();

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(false);
		expect(state.tripReason).toBeNull();

		const trippedKey = await kv.get("cfug:tripped");
		expect(trippedKey).toBeNull();
	});

	it("maintains cached state when CF API fails", async () => {
		const { guard, kv, logger } = makeGuard();

		const existingState: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(existingState));

		setupFetchMock({}, 500);
		await guard.evaluate();

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(true);
		expect(logger.error).toHaveBeenCalledWith(
			"CF API query failed, maintaining cached state",
			expect.any(Object),
		);
	});

	it("sends warn alerts for resources above warn threshold", async () => {
		const fetchSpy = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () =>
				mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 820_000 }] }),
		}));
		vi.stubGlobal("fetch", fetchSpy);

		const { guard } = makeGuard({
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await guard.evaluate();

		const discordCalls = (fetchSpy.mock.calls as unknown[][]).filter(
			(c) => c[0] === "https://discord.example.com/webhook",
		);
		expect(discordCalls.length).toBeGreaterThan(0);
	});

	it("fires onEvaluate hook after every check", async () => {
		setupFetchMock(mockGraphQLResponse());
		const onEvaluate = vi.fn();
		const { guard } = makeGuard({ onEvaluate });

		await guard.evaluate();

		expect(onEvaluate).toHaveBeenCalledTimes(1);
		expect(onEvaluate).toHaveBeenCalledWith(
			expect.objectContaining({
				state: expect.objectContaining({ version: 1 }),
				billingPeriod: expect.objectContaining({ start: expect.any(String) }),
				transitioned: null,
			}),
		);
	});

	it("fires onEvaluate with trip transition", async () => {
		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 950_000 }] }));
		const onEvaluate = vi.fn();
		const { guard } = makeGuard({ onEvaluate });

		await guard.evaluate();

		expect(onEvaluate).toHaveBeenCalledWith(expect.objectContaining({ transitioned: "trip" }));
	});

	it("fires onEvaluate with recover transition", async () => {
		const kv = createMockKV();
		const trippedState: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(trippedState));
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");

		setupFetchMock(mockGraphQLResponse());
		const onEvaluate = vi.fn();
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			onEvaluate,
		});

		await guard.evaluate();

		expect(onEvaluate).toHaveBeenCalledWith(expect.objectContaining({ transitioned: "recover" }));
	});

	it("handles onEvaluate hook failure gracefully", async () => {
		setupFetchMock(mockGraphQLResponse());
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const onEvaluate = vi.fn(async () => {
			throw new Error("hook failed");
		});
		const { guard } = makeGuard({ onEvaluate, logger });

		await guard.evaluate();

		expect(logger.error).toHaveBeenCalledWith(
			"onEvaluate hook failed",
			expect.objectContaining({ error: expect.stringContaining("hook failed") }),
		);
	});

	it("preserves existing tripped state when no transition occurs", async () => {
		const { guard, kv } = makeGuard();
		const existingState: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "manual",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(existingState));

		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 880_000 }] }));
		await guard.evaluate();

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(true);
		expect(state.tripReason).toBe("manual");
		expect(state.trippedAt).toBe("2026-04-10T00:00:00Z");
	});

	it("does not fire onEvaluate when getState returns null after CF API failure", async () => {
		const kv = createFailingKV();
		setupFetchMock(mockGraphQLResponse());
		const onEvaluate = vi.fn();
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", onEvaluate, logger });
		await guard.evaluate();

		expect(onEvaluate).not.toHaveBeenCalled();
	});

	it("handles KV read failure during evaluate gracefully", async () => {
		const kv = createFailingKV();
		setupFetchMock(mockGraphQLResponse());
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", logger });
		await guard.evaluate();

		expect(logger.warn).toHaveBeenCalledWith("KV read failed for state during evaluate");
	});
});

describe("getState", () => {
	it("returns null when no state exists", async () => {
		const { guard } = makeGuard();
		expect(await guard.getState()).toBeNull();
	});

	it("returns parsed state", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: false,
			trippedAt: null,
			tripReason: null,
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		const result = await guard.getState();
		expect(result).toEqual(state);
	});

	it("returns null on KV failure", async () => {
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const guard = createUsageGuard({
			kv: createFailingKV(),
			accountId: "test",
			apiToken: "test",
			logger,
		});
		expect(await guard.getState()).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("trip", () => {
	it("manually trips the guard", async () => {
		const { guard, kv, logger } = makeGuard();

		await guard.trip("incident");

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(true);
		expect(state.tripReason).toBe("manual");
		expect(await kv.get("cfug:tripped")).not.toBeNull();
		expect(logger.debug).toHaveBeenCalledWith("Guard manually tripped", { reason: "incident" });
	});

	it("preserves existing resources when tripping manually", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: false,
			trippedAt: null,
			tripReason: null,
			manualTripReason: null,
			resources: [
				{
					name: "kv-writes",
					current: 500_000,
					limit: 1_000_000,
					percent: 50,
					overageCost: 5,
					estimatedOverage: 0,
				},
			],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));

		await guard.trip();

		const newState = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(newState.tripped).toBe(true);
		expect(newState.resources).toHaveLength(1);
	});

	it("handles KV write failure for tripped key gracefully", async () => {
		const kv = createMockKV();
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		let callCount = 0;
		const origPut = vi.mocked(kv.put).getMockImplementation()!;
		vi.mocked(kv.put).mockImplementation(async (key, value, opts?) => {
			callCount++;
			if (callCount === 2) throw new Error("KV write failure");
			return origPut(key, value as string, opts as KVNamespacePutOptions | undefined);
		});

		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", logger });
		await guard.trip();

		expect(logger.warn).toHaveBeenCalledWith("KV write failed for tripped safety net key");
	});
});

describe("reset", () => {
	it("manually resets the guard", async () => {
		const { guard, kv, logger } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "manual",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");

		await guard.reset();

		const newState = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(newState.tripped).toBe(false);
		expect(newState.tripReason).toBeNull();
		expect(await kv.get("cfug:tripped")).toBeNull();
		expect(logger.debug).toHaveBeenCalledWith("Guard manually reset");
	});

	it("handles KV delete failure for tripped key gracefully", async () => {
		const kv = createMockKV();
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		vi.mocked(kv.delete).mockRejectedValueOnce(new Error("KV delete failure"));

		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", logger });
		await guard.reset();

		expect(logger.warn).toHaveBeenCalledWith("KV delete failed for tripped key during recovery");
	});
});

describe("isTripped (per-resource)", () => {
	it("returns true when specific resource is over trip threshold", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [
				{
					name: "kv-writes",
					current: 950_000,
					limit: 1_000_000,
					percent: 95,
					overageCost: 5,
					estimatedOverage: 0,
				},
				{
					name: "d1-reads",
					current: 5_000_000,
					limit: 25_000_000,
					percent: 20,
					overageCost: 0.001,
					estimatedOverage: 0,
				},
			],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));

		expect(await guard.isTripped("kv-writes")).toBe(true);
		expect(await guard.isTripped("d1-reads")).toBe(false);
	});

	it("returns false for resource with trip: null", async () => {
		const kv = createMockKV();
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			thresholds: { "kv-writes": { trip: null } },
		});
		const state: GuardState = {
			version: 1,
			tripped: false,
			trippedAt: null,
			tripReason: null,
			manualTripReason: null,
			resources: [
				{
					name: "kv-writes",
					current: 1_000_000,
					limit: 1_000_000,
					percent: 100,
					overageCost: 5,
					estimatedOverage: 0,
				},
			],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		expect(await guard.isTripped("kv-writes")).toBe(false);
	});

	it("returns false when no state exists for specific resource", async () => {
		const { guard } = makeGuard();
		expect(await guard.isTripped("kv-writes")).toBe(false);
	});

	it("returns false when resource not found in state", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: false,
			trippedAt: null,
			tripReason: null,
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		expect(await guard.isTripped("kv-writes")).toBe(false);
	});
});

describe("trippedResources", () => {
	it("returns list of resources over their trip threshold", async () => {
		const { guard, kv } = makeGuard();
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [
				{
					name: "kv-writes",
					current: 950_000,
					limit: 1_000_000,
					percent: 95,
					overageCost: 5,
					estimatedOverage: 0,
				},
				{
					name: "d1-reads",
					current: 5_000_000,
					limit: 25_000_000,
					percent: 20,
					overageCost: 0.001,
					estimatedOverage: 0,
				},
				{
					name: "d1-writes",
					current: 48_000_000,
					limit: 50_000_000,
					percent: 96,
					overageCost: 1,
					estimatedOverage: 0,
				},
			],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));

		const tripped = await guard.trippedResources();
		expect(tripped).toContain("kv-writes");
		expect(tripped).toContain("d1-writes");
		expect(tripped).not.toContain("d1-reads");
	});

	it("returns empty array when no state", async () => {
		const { guard } = makeGuard();
		expect(await guard.trippedResources()).toEqual([]);
	});

	it("returns empty array on KV failure", async () => {
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const guard = createUsageGuard({
			kv: createFailingKV(),
			accountId: "test",
			apiToken: "test",
			logger,
		});
		expect(await guard.trippedResources()).toEqual([]);
	});
});

describe("safety net reconciliation", () => {
	it("reconciles state from tripped key when state key is missing", async () => {
		const kv = createMockKV();
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		setupFetchMock(mockGraphQLResponse());
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", logger });
		await guard.evaluate();

		expect(logger.debug).toHaveBeenCalledWith("Reconciled state from tripped safety net key");
		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.tripped).toBe(false);
	});

	it("stores manualTripReason when manually tripped", async () => {
		const { guard, kv } = makeGuard();
		await guard.trip("deploy freeze");

		const state = JSON.parse((await kv.get("cfug:state:v1"))!) as GuardState;
		expect(state.manualTripReason).toBe("deploy freeze");
	});
});

describe("new services", () => {
	it("parses Durable Objects requests and wall time", async () => {
		setupFetchMock(mockGraphQLResponse({ doRequests: 500_000, doWallTime: 200_000_000_000 }));
		const { guard } = makeGuard();
		await guard.evaluate();
		const state = await guard.getState();
		expect(state?.resources.find((r) => r.name === "do-requests")?.current).toBe(500_000);
		expect(state?.resources.find((r) => r.name === "do-wall-time")?.current).toBe(200_000_000_000);
	});

	it("parses Workers AI neurons", async () => {
		setupFetchMock(mockGraphQLResponse({ aiNeurons: 5_000_000 }));
		const { guard } = makeGuard();
		await guard.evaluate();
		const state = await guard.getState();
		expect(state?.resources.find((r) => r.name === "ai-neurons")?.current).toBe(5_000_000);
	});

	it("parses Vectorize queried dimensions", async () => {
		setupFetchMock(mockGraphQLResponse({ vectorizeQueries: 15_000_000 }));
		const { guard } = makeGuard();
		await guard.evaluate();
		const state = await guard.getState();
		expect(state?.resources.find((r) => r.name === "vectorize-queries")?.current).toBe(15_000_000);
	});

	it("parses Pages Functions requests", async () => {
		setupFetchMock(mockGraphQLResponse({ pagesRequests: 3_000_000 }));
		const { guard } = makeGuard();
		await guard.evaluate();
		const state = await guard.getState();
		expect(state?.resources.find((r) => r.name === "pages-requests")?.current).toBe(3_000_000);
	});

	it("parses Stream minutes viewed", async () => {
		setupFetchMock(mockGraphQLResponse({ streamMinutes: 800 }));
		const { guard } = makeGuard();
		await guard.evaluate();
		const state = await guard.getState();
		expect(state?.resources.find((r) => r.name === "stream-minutes")?.current).toBe(800);
	});
});

describe("dry-run mode", () => {
	it("isTripped returns false even when state says tripped", async () => {
		const kv = createMockKV();
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			dryRun: true,
		});
		const state: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(state));
		expect(await guard.isTripped()).toBe(false);
	});

	it("isTripped(resource) returns false in dry-run", async () => {
		const kv = createMockKV();
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			dryRun: true,
		});
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		expect(await guard.isTripped("kv-writes")).toBe(false);
	});

	it("evaluate does not save state or send alerts", async () => {
		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 950_000 }] }));
		const kv = createMockKV();
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			dryRun: true,
			logger,
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await guard.evaluate();

		const stateRaw = await kv.get("cfug:state:v1");
		expect(stateRaw).toBeNull();

		const trippedKey = await kv.get("cfug:tripped");
		expect(trippedKey).toBeNull();
	});

	it("evaluate still fires onEvaluate with correct transition", async () => {
		setupFetchMock(mockGraphQLResponse({ kvGroups: [{ actionType: "write", requests: 950_000 }] }));
		const onEvaluate = vi.fn();

		const guard = createUsageGuard({
			kv: createMockKV(),
			accountId: "test",
			apiToken: "test",
			dryRun: true,
			onEvaluate,
		});

		await guard.evaluate();

		expect(onEvaluate).toHaveBeenCalledWith(expect.objectContaining({ transitioned: "trip" }));
	});

	it("evaluate fires onEvaluate with recover transition in dry-run", async () => {
		const kv = createMockKV();
		const trippedState: GuardState = {
			version: 1,
			tripped: true,
			trippedAt: "2026-04-10T00:00:00Z",
			tripReason: "threshold",
			manualTripReason: null,
			resources: [],
			lastCheckAt: "2026-04-10T00:00:00Z",
		};
		await kv.put("cfug:state:v1", JSON.stringify(trippedState));
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");

		setupFetchMock(mockGraphQLResponse());
		const onEvaluate = vi.fn();

		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			dryRun: true,
			onEvaluate,
		});

		await guard.evaluate();

		expect(onEvaluate).toHaveBeenCalledWith(expect.objectContaining({ transitioned: "recover" }));
	});
});

describe("safety net protects per-resource checks", () => {
	it("isTripped(resource) returns true when only tripped key exists", async () => {
		const kv = createMockKV();
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test" });

		expect(await guard.isTripped("kv-writes")).toBe(true);
		expect(await guard.isTripped("d1-reads")).toBe(true);
	});

	it("isTripped(resource) falls back to safety net and logs on KV failure", async () => {
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const kv = createFailingKV();
		const guard = createUsageGuard({ kv, accountId: "test", apiToken: "test", logger });

		expect(await guard.isTripped("kv-writes")).toBe(false);
		expect(logger.warn).toHaveBeenCalledWith("KV read failed for state key");
		expect(logger.warn).toHaveBeenCalledWith("KV read failed for tripped key");
	});

	it("isTripped(resource) returns false for warn-only resource when tripped key exists", async () => {
		const kv = createMockKV();
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			thresholds: { "kv-writes": { trip: null } },
		});

		expect(await guard.isTripped("kv-writes")).toBe(false);
		expect(await guard.isTripped("d1-reads")).toBe(true);
	});

	it("trippedResources returns all trippable when only tripped key exists", async () => {
		const kv = createMockKV();
		await kv.put("cfug:tripped", "2026-04-10T00:00:00Z");
		const guard = createUsageGuard({
			kv,
			accountId: "test",
			apiToken: "test",
			thresholds: { "kv-writes": { trip: null } },
		});

		const tripped = await guard.trippedResources();
		expect(tripped).not.toContain("kv-writes");
		expect(tripped).toContain("d1-reads");
		expect(tripped.length).toBeGreaterThan(10);
	});
});
