import { afterEach, describe, expect, it, vi } from "vitest";
import { withUsageGuard } from "../wrapper";
import { createMockKV, mockGraphQLResponse, setupFetchMock } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

interface TestEnv {
	USAGE_GUARD_KV: KVNamespace;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
}

function makeEnv(): TestEnv {
	return {
		USAGE_GUARD_KV: createMockKV(),
		CF_ACCOUNT_ID: "test-account",
		CF_API_TOKEN: "test-token",
	};
}

function makeWrapperConfig() {
	return {
		kv: (env: TestEnv) => env.USAGE_GUARD_KV,
		accountId: (env: TestEnv) => env.CF_ACCOUNT_ID,
		apiToken: (env: TestEnv) => env.CF_API_TOKEN,
		evaluateCron: "*/5 * * * *",
	};
}

function makeController(cron: string): ScheduledController {
	return {
		cron,
		scheduledTime: Date.now(),
		noRetry: () => {},
	};
}

function makeCtx(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

describe("withUsageGuard", () => {
	it("passes fetch handler through untouched", async () => {
		const originalFetch = vi.fn(async () => new Response("ok"));
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), { fetch: originalFetch });

		const env = makeEnv();
		const ctx = makeCtx();
		const request = new Request("https://example.com") as unknown as Request<
			unknown,
			IncomingRequestCfProperties
		>;

		const response = await handler.fetch!(request, env, ctx);
		expect(originalFetch).toHaveBeenCalledWith(request, env, ctx);
		expect(await response.text()).toBe("ok");
	});

	it("calls evaluate() on evaluateCron match", async () => {
		setupFetchMock(mockGraphQLResponse());

		const scheduled = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), { scheduled });

		const env = makeEnv();
		const ctx = makeCtx();

		await handler.scheduled!(makeController("*/5 * * * *"), env, ctx);

		expect(ctx.waitUntil).toHaveBeenCalled();
		expect(scheduled).not.toHaveBeenCalled();
	});

	it("calls consumer scheduled handler when not tripped", async () => {
		setupFetchMock(mockGraphQLResponse());

		const scheduled = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), { scheduled });

		const env = makeEnv();
		const ctx = makeCtx();

		await handler.scheduled!(makeController("0 6 * * *"), env, ctx);
		expect(scheduled).toHaveBeenCalledWith(
			expect.objectContaining({ cron: "0 6 * * *" }),
			env,
			ctx,
		);
	});

	it("skips consumer scheduled handler when tripped", async () => {
		const env = makeEnv();
		await env.USAGE_GUARD_KV.put("cfug:tripped", "2026-04-10T00:00:00Z");

		const scheduled = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), { scheduled });

		await handler.scheduled!(makeController("0 6 * * *"), env, makeCtx());
		expect(scheduled).not.toHaveBeenCalled();
	});

	it("passes through queue handlers untouched", () => {
		const queueHandler = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), {
			queue: queueHandler,
		});

		expect((handler as Record<string, unknown>).queue).toBe(queueHandler);
	});

	it("passes through arbitrary handlers", () => {
		const emailHandler = vi.fn();
		const tailHandler = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), {
			email: emailHandler,
			tail: tailHandler,
		});

		expect((handler as Record<string, unknown>).email).toBe(emailHandler);
		expect((handler as Record<string, unknown>).tail).toBe(tailHandler);
	});

	it("does not include fetch/scheduled in result when not provided", () => {
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), {});

		expect(handler.fetch).toBeUndefined();
		expect(handler.scheduled).toBeUndefined();
	});

	it("reuses guard instance across calls", async () => {
		setupFetchMock(mockGraphQLResponse());

		const scheduled = vi.fn();
		const handler = withUsageGuard<TestEnv>(makeWrapperConfig(), { scheduled });

		const env = makeEnv();
		const ctx = makeCtx();

		await handler.scheduled!(makeController("0 6 * * *"), env, ctx);
		await handler.scheduled!(makeController("0 7 * * *"), env, ctx);

		expect(scheduled).toHaveBeenCalledTimes(2);
	});

	it("threads onEvaluate to guard config", async () => {
		setupFetchMock(mockGraphQLResponse());
		const onEvaluate = vi.fn();

		const handler = withUsageGuard<TestEnv>(
			{ ...makeWrapperConfig(), onEvaluate },
			{ scheduled: vi.fn() },
		);

		const env = makeEnv();
		const ctx = makeCtx();

		await handler.scheduled!(makeController("*/5 * * * *"), env, ctx);
		await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];

		expect(onEvaluate).toHaveBeenCalled();
	});

	it("threads optional config fields", async () => {
		setupFetchMock(mockGraphQLResponse());

		const handler = withUsageGuard<TestEnv>(
			{
				...makeWrapperConfig(),
				billingDay: 15,
				keyPrefix: "myapp:",
				alertTimeout: 5000,
				alerts: () => [],
				logger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
			},
			{ scheduled: vi.fn() },
		);

		const env = makeEnv();
		const ctx = makeCtx();
		await handler.scheduled!(makeController("0 6 * * *"), env, ctx);
	});
});
