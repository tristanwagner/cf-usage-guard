import { describe, expect, it } from "vitest";
import { validateAndResolve } from "../validation";
import { createMockKV } from "./helpers";

function baseConfig() {
	return {
		kv: createMockKV(),
		accountId: "test-account",
		apiToken: "test-token",
	};
}

describe("validateAndResolve", () => {
	it("returns resolved config with all defaults", () => {
		const config = validateAndResolve(baseConfig());
		expect(config.billingDay).toBe(1);
		expect(config.keyPrefix).toBe("cfug:");
		expect(config.alertTimeout).toBe(10_000);
		expect(config.alerts).toEqual([]);
		expect(config.thresholds["kv-writes"].limit).toBe(1_000_000);
		expect(config.thresholds["kv-writes"].warn).toBe(80);
		expect(config.thresholds["kv-writes"].trip).toBe(90);
		expect(config.thresholds["kv-writes"].recover).toBe(85);
		expect(config.thresholds["workers-requests"].trip).toBe(95);
		expect(config.thresholds["workers-cpu"].limit).toBe(30_000_000_000);
	});

	it("applies threshold overrides via shallow merge", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: {
				"kv-writes": { trip: 85, recover: 80 },
			},
		});
		expect(config.thresholds["kv-writes"].trip).toBe(85);
		expect(config.thresholds["kv-writes"].recover).toBe(80);
		expect(config.thresholds["kv-writes"].warn).toBe(80);
		expect(config.thresholds["kv-writes"].limit).toBe(1_000_000);
	});

	it("auto-computes recover as trip - 5 when not provided", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: {
				"workers-requests": { trip: 95, warn: 70 },
			},
		});
		expect(config.thresholds["workers-requests"].recover).toBe(90);
	});

	it("sets recover to null when trip is null", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: {
				"d1-reads": { trip: null },
			},
		});
		expect(config.thresholds["d1-reads"].trip).toBeNull();
		expect(config.thresholds["d1-reads"].recover).toBeNull();
	});

	it("throws on billingDay < 1", () => {
		expect(() => validateAndResolve({ ...baseConfig(), billingDay: 0 })).toThrow(
			"Invalid billingDay: 0",
		);
	});

	it("throws on billingDay > 31", () => {
		expect(() => validateAndResolve({ ...baseConfig(), billingDay: 32 })).toThrow(
			"Invalid billingDay: 32",
		);
	});

	it("throws on non-integer billingDay", () => {
		expect(() => validateAndResolve({ ...baseConfig(), billingDay: 1.5 })).toThrow(
			"Invalid billingDay: 1.5",
		);
	});

	it("throws on keyPrefix not ending with :", () => {
		expect(() => validateAndResolve({ ...baseConfig(), keyPrefix: "myprefix" })).toThrow(
			'Must end with ":"',
		);
	});

	it("throws on negative alertTimeout", () => {
		expect(() => validateAndResolve({ ...baseConfig(), alertTimeout: -1 })).toThrow(
			"Invalid alertTimeout: -1",
		);
	});

	it("throws on zero alertTimeout", () => {
		expect(() => validateAndResolve({ ...baseConfig(), alertTimeout: 0 })).toThrow(
			"Invalid alertTimeout: 0",
		);
	});

	it("throws when recover >= trip", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { trip: 90, recover: 95 } },
			}),
		).toThrow("recover (95) must be less than trip (90)");
	});

	it("throws when recover equals trip", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { trip: 90, recover: 90 } },
			}),
		).toThrow("recover (90) must be less than trip (90)");
	});

	it("throws when warn >= trip", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { warn: 95, trip: 90 } },
			}),
		).toThrow("warn (95) must be less than trip (90)");
	});

	it("throws on negative warn", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { warn: -1 } },
			}),
		).toThrow("warn (-1) must be between 0 and 100");
	});

	it("throws on warn > 100", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { warn: 101 } },
			}),
		).toThrow("warn (101) must be between 0 and 100");
	});

	it("throws on negative trip", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { trip: -5, warn: -10 } },
			}),
		).toThrow("warn (-10) must be between 0 and 100");
	});

	it("throws on trip > 100", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { trip: 105 } },
			}),
		).toThrow("trip (105) must be between 0 and 100");
	});

	it("throws on negative recover from auto-compute", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { trip: 3, warn: 1, recover: -2 } },
			}),
		).toThrow("recover (-2) must be between 0 and 100");
	});

	it("throws on limit <= 0", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { limit: 0 } },
			}),
		).toThrow("limit (0) must be positive");
	});

	it("throws on negative limit", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { limit: -100 } },
			}),
		).toThrow("limit (-100) must be positive");
	});

	it("throws on tripAt <= 0", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { tripAt: 0 } },
			}),
		).toThrow("tripAt (0) must be positive");
	});

	it("throws on negative tripAt", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { tripAt: -100 } },
			}),
		).toThrow("tripAt (-100) must be positive");
	});

	it("throws on maxOverageUsd <= 0", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { maxOverageUsd: 0 } },
			}),
		).toThrow("maxOverageUsd (0) must be positive");
	});

	it("throws on negative maxOverageUsd", () => {
		expect(() =>
			validateAndResolve({
				...baseConfig(),
				thresholds: { "kv-writes": { maxOverageUsd: -5 } },
			}),
		).toThrow("maxOverageUsd (-5) must be positive");
	});

	it("accepts valid tripAt", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: { "kv-writes": { tripAt: 900_000 } },
		});
		expect(config.thresholds["kv-writes"].tripAt).toBe(900_000);
	});

	it("accepts valid maxOverageUsd", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: { "kv-writes": { maxOverageUsd: 5 } },
		});
		expect(config.thresholds["kv-writes"].maxOverageUsd).toBe(5);
	});

	it("accepts custom keyPrefix ending with :", () => {
		const config = validateAndResolve({ ...baseConfig(), keyPrefix: "myapp:" });
		expect(config.keyPrefix).toBe("myapp:");
	});

	it("accepts custom alertTimeout", () => {
		const config = validateAndResolve({ ...baseConfig(), alertTimeout: 5000 });
		expect(config.alertTimeout).toBe(5000);
	});

	it("uses noop logger when none provided", () => {
		const config = validateAndResolve(baseConfig());
		expect(() => config.logger.warn("test")).not.toThrow();
		expect(() => config.logger.error("test")).not.toThrow();
		expect(() => config.logger.debug("test")).not.toThrow();
	});

	it("uses provided logger", () => {
		const logger = { warn: () => {}, error: () => {}, debug: () => {} };
		const config = validateAndResolve({ ...baseConfig(), logger });
		expect(config.logger).toBe(logger);
	});

	it("passes through alerts array", () => {
		const alerts = [{ type: "discord" as const, url: "https://discord.example.com" }];
		const config = validateAndResolve({ ...baseConfig(), alerts });
		expect(config.alerts).toBe(alerts);
	});

	it("accepts overageCost override", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: { "kv-writes": { overageCost: 10 } },
		});
		expect(config.thresholds["kv-writes"].overageCost).toBe(10);
	});

	it("throws on empty accountId", () => {
		expect(() => validateAndResolve({ ...baseConfig(), accountId: "" })).toThrow(
			"accountId is required",
		);
	});

	it("throws on whitespace-only accountId", () => {
		expect(() => validateAndResolve({ ...baseConfig(), accountId: "  " })).toThrow(
			"accountId is required",
		);
	});

	it("throws on empty apiToken", () => {
		expect(() => validateAndResolve({ ...baseConfig(), apiToken: "" })).toThrow(
			"apiToken is required",
		);
	});

	it("includes new service defaults", () => {
		const config = validateAndResolve(baseConfig());
		expect(config.thresholds["do-requests"].limit).toBe(1_000_000);
		expect(config.thresholds["do-wall-time"].limit).toBe(400_000_000_000);
		expect(config.thresholds["ai-neurons"].limit).toBe(10_000);
		expect(config.thresholds["ai-neurons"].trip).toBe(90);
		expect(config.thresholds["ai-neurons"].granularity).toBe("daily");
		expect(config.thresholds["vectorize-queries"].limit).toBe(50_000_000);
		expect(config.thresholds["pages-requests"].limit).toBe(10_000_000);
		expect(config.thresholds["stream-minutes"].limit).toBe(1_000);
		expect(config.thresholds["stream-minutes"].trip).toBe(90);
		expect(config.thresholds["d1-reads"].limit).toBe(25_000_000_000);
	});

	it("defaults all resources to monthly granularity except ai-neurons", () => {
		const config = validateAndResolve(baseConfig());
		for (const [name, threshold] of Object.entries(config.thresholds)) {
			if (name === "ai-neurons") {
				expect(threshold.granularity).toBe("daily");
			} else {
				expect(threshold.granularity).toBe("monthly");
			}
		}
	});

	it("allows overriding granularity", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: { "kv-writes": { granularity: "weekly" } },
		});
		expect(config.thresholds["kv-writes"].granularity).toBe("weekly");
	});

	it("allows overriding ai-neurons to monthly granularity", () => {
		const config = validateAndResolve({
			...baseConfig(),
			thresholds: { "ai-neurons": { granularity: "monthly", limit: 300_000 } },
		});
		expect(config.thresholds["ai-neurons"].granularity).toBe("monthly");
		expect(config.thresholds["ai-neurons"].limit).toBe(300_000);
	});
});
