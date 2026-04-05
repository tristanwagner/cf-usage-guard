import { vi } from "vitest";

export function createMockKV(): KVNamespace {
	const store = new Map<string, { value: string; expiration?: number }>();

	return {
		get: vi.fn(async (key: string) => {
			const entry = store.get(key);
			if (!entry) return null;
			if (entry.expiration && Date.now() / 1000 > entry.expiration) {
				store.delete(key);
				return null;
			}
			return entry.value;
		}),
		put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
			const expiration = opts?.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : undefined;
			store.set(key, { value, expiration });
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	} as unknown as KVNamespace;
}

export function createFailingKV(): KVNamespace {
	return {
		get: vi.fn(async () => {
			throw new Error("KV read failure");
		}),
		put: vi.fn(async () => {
			throw new Error("KV write failure");
		}),
		delete: vi.fn(async () => {
			throw new Error("KV delete failure");
		}),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	} as unknown as KVNamespace;
}

export function mockGraphQLResponse(
	overrides: {
		requests?: number;
		cpuTimeUs?: number;
		kvGroups?: Array<{ actionType: string; requests: number }>;
		d1Reads?: number;
		d1Writes?: number;
		r2Groups?: Array<{ actionType: string; requests: number }>;
		queueOps?: number;
		doRequests?: number;
		doWallTime?: number;
		aiNeurons?: number;
		vectorizeQueries?: number;
		pagesRequests?: number;
		streamMinutes?: number;
	} = {},
) {
	return {
		data: {
			viewer: {
				accounts: [
					{
						workersInvocationsAdaptive: [
							{
								sum: {
									requests: overrides.requests ?? 0,
									cpuTimeUs: overrides.cpuTimeUs ?? 0,
								},
							},
						],
						kvOperationsAdaptiveGroups: (overrides.kvGroups ?? []).map((g) => ({
							dimensions: { actionType: g.actionType },
							sum: { requests: g.requests },
						})),
						d1AnalyticsAdaptiveGroups: [
							{
								sum: {
									readQueries: overrides.d1Reads ?? 0,
									writeQueries: overrides.d1Writes ?? 0,
								},
							},
						],
						r2OperationsAdaptiveGroups: (overrides.r2Groups ?? []).map((g) => ({
							dimensions: { actionType: g.actionType },
							sum: { requests: g.requests },
						})),
						queueMessageOperationsAdaptiveGroups: [
							{ sum: { billableOperations: overrides.queueOps ?? 0 } },
						],
						durableObjectsInvocationsAdaptiveGroups: [
							{
								sum: {
									requests: overrides.doRequests ?? 0,
									wallTime: overrides.doWallTime ?? 0,
								},
							},
						],
						aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: overrides.aiNeurons ?? 0 } }],
						vectorizeV2QueriesAdaptiveGroups: [
							{
								sum: {
									queriedVectorDimensions: overrides.vectorizeQueries ?? 0,
								},
							},
						],
						pagesFunctionsInvocationsAdaptiveGroups: [
							{ sum: { requests: overrides.pagesRequests ?? 0 } },
						],
						streamMinutesViewedAdaptiveGroups: [
							{ sum: { minutesViewed: overrides.streamMinutes ?? 0 } },
						],
					},
				],
			},
		},
	};
}

export function setupFetchMock(responseBody: unknown, status = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? "OK" : "Error",
			json: async () => responseBody,
		})),
	);
}
