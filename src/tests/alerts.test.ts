import { afterEach, describe, expect, it, vi } from "vitest";
import { billingPeriodRemainderSeconds, formatResourceLines, sendAlerts } from "../alerts";
import type { AlertEvent, ResolvedConfig, ResourceStatus } from "../types";
import { validateAndResolve } from "../validation";
import { createFailingKV, createMockKV } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeEvent(overrides?: Partial<AlertEvent>): AlertEvent {
	return {
		level: "warn",
		resources: [
			{
				name: "kv-writes",
				current: 820_000,
				limit: 1_000_000,
				percent: 82,
				overageCost: 5,
				estimatedOverage: 0,
			},
		],
		accountId: "abc12345",
		timestamp: "2026-04-15T00:00:00.000Z",
		billingPeriod: { start: "2026-04-01", end: "2026-04-15" },
		...overrides,
	};
}

function makeConfig(overrides?: Partial<Parameters<typeof validateAndResolve>[0]>): ResolvedConfig {
	return validateAndResolve({
		kv: createMockKV(),
		accountId: "abc12345",
		apiToken: "test-token",
		...overrides,
	});
}

describe("sendAlerts", () => {
	it("does nothing when no alert channels configured", async () => {
		const config = makeConfig();
		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));
	});

	it("sends Discord webhook with correct format", async () => {
		const fetchSpy = vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));

		expect(fetch).toHaveBeenCalledTimes(1);
		const call = vi.mocked(fetch).mock.calls[0];
		expect(call[0]).toBe("https://discord.example.com/webhook");
		const body = JSON.parse((call[1] as RequestInit).body as string);
		expect(body.embeds[0].title).toContain("Usage Warning");
		expect(body.embeds[0].fields[1].value).toBe("****2345");
	});

	it("sends Discord trip alert with red color", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			kv: createMockKV(),
			accountId: "abc12345678",
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await sendAlerts(makeEvent({ level: "trip" }), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.embeds[0].color).toBe(0xff0000);
	});

	it("sends Discord recover alert with green color", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await sendAlerts(makeEvent({ level: "recover" }), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.embeds[0].color).toBe(0x00ff00);
		expect(body.embeds[0].title).toContain("Usage Recovered");
	});

	it("sends Slack webhook with correct block format", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			alerts: [{ type: "slack", url: "https://hooks.slack.com/test" }],
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.blocks[0].text.text).toContain("Usage Warning");
		expect(body.blocks[1].text.text).toContain("kv-writes");
	});

	it("sends Slack trip alert with red circle emoji", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			alerts: [{ type: "slack", url: "https://hooks.slack.com/test" }],
		});

		await sendAlerts(makeEvent({ level: "trip" }), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.blocks[2].elements[0].text).toContain(":red_circle:");
	});

	it("sends Slack recover alert with check mark emoji", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			alerts: [{ type: "slack", url: "https://hooks.slack.com/test" }],
		});

		await sendAlerts(makeEvent({ level: "recover" }), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.blocks[2].elements[0].text).toContain(":white_check_mark:");
	});

	it("calls custom handler with event", async () => {
		const handler = vi.fn(async () => {});
		const config = makeConfig({
			alerts: [{ type: "custom", handler }],
		});

		const event = makeEvent();
		await sendAlerts(event, config, new Date("2026-04-15T00:00:00Z"));

		expect(handler).toHaveBeenCalledWith(event);
	});

	it("times out custom handler after alertTimeout", async () => {
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const handler = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 60_000)));
		const config = makeConfig({
			alerts: [{ type: "custom", handler }],
			alertTimeout: 50,
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));

		expect(logger.error).toHaveBeenCalledWith(
			"Alert channel failed",
			expect.objectContaining({ error: expect.stringContaining("timed out") }),
		);
	});

	it("deduplicates warn alerts per resource per billing period", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const kv = createMockKV();
		const config = makeConfig({
			kv,
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		const now = new Date("2026-04-15T00:00:00Z");
		await sendAlerts(makeEvent(), config, now);
		expect(fetch).toHaveBeenCalledTimes(1);

		await sendAlerts(makeEvent(), config, now);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("deduplicates trip alerts globally per billing period", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const kv = createMockKV();
		const config = makeConfig({
			kv,
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		const now = new Date("2026-04-15T00:00:00Z");
		await sendAlerts(makeEvent({ level: "trip" }), config, now);
		expect(fetch).toHaveBeenCalledTimes(1);

		await sendAlerts(makeEvent({ level: "trip" }), config, now);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("never deduplicates recover alerts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const kv = createMockKV();
		const config = makeConfig({
			kv,
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		const now = new Date("2026-04-15T00:00:00Z");
		await sendAlerts(makeEvent({ level: "recover" }), config, now);
		await sendAlerts(makeEvent({ level: "recover" }), config, now);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("continues sending when one channel fails", async () => {
		const handler1 = vi.fn(async () => {
			throw new Error("channel 1 failed");
		});
		const handler2 = vi.fn(async () => {});
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const config = makeConfig({
			alerts: [
				{ type: "custom", handler: handler1 },
				{ type: "custom", handler: handler2 },
			],
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));

		expect(handler2).toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			"Alert channel failed",
			expect.objectContaining({
				error: expect.stringContaining("channel 1 failed"),
			}),
		);
	});

	it("throws on Discord webhook failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const config = makeConfig({
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));
		expect(logger.error).toHaveBeenCalled();
	});

	it("throws on Slack webhook failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const config = makeConfig({
			alerts: [{ type: "slack", url: "https://hooks.slack.com/test" }],
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));
		expect(logger.error).toHaveBeenCalled();
	});

	it("handles KV failure during dedup check gracefully", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const config = makeConfig({
			kv: createFailingKV(),
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalled();
	});

	it("does not write dedup when all channels fail", async () => {
		const handler = vi.fn(async () => {
			throw new Error("channel failed");
		});
		const kv = createMockKV();
		const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

		const config = makeConfig({
			kv,
			alerts: [{ type: "custom", handler }],
			logger,
		});

		await sendAlerts(makeEvent(), config, new Date("2026-04-15T00:00:00Z"));
		expect(kv.put).not.toHaveBeenCalledWith(
			expect.stringContaining("alert:"),
			expect.any(String),
			expect.any(Object),
		);
	});

	it("masks short account IDs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const config = makeConfig({
			accountId: "ab",
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await sendAlerts(makeEvent({ accountId: "ab" }), config, new Date("2026-04-15T00:00:00Z"));

		const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
		expect(body.embeds[0].fields[1].value).toBe("****");
	});

	it("uses unknown resource name when event has empty resources", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);
		const kv = createMockKV();

		const config = makeConfig({
			kv,
			alerts: [{ type: "discord", url: "https://discord.example.com/webhook" }],
		});

		await sendAlerts(makeEvent({ resources: [] }), config, new Date("2026-04-15T00:00:00Z"));

		expect(kv.put).toHaveBeenCalledWith(
			expect.stringContaining("unknown"),
			expect.any(String),
			expect.any(Object),
		);
	});
});

describe("formatResourceLines", () => {
	it("formats resource with progress bar and numbers", () => {
		const resources: ResourceStatus[] = [
			{
				name: "kv-writes",
				current: 820_000,
				limit: 1_000_000,
				percent: 82,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const line = formatResourceLines(resources);
		expect(line).toContain("kv-writes");
		expect(line).toContain("82.0%");
		expect(line).toContain("========--");
		expect(line).toContain("820.0K / 1.0M");
	});

	it("formats billions correctly", () => {
		const resources: ResourceStatus[] = [
			{
				name: "workers-cpu",
				current: 15_000_000_000,
				limit: 30_000_000_000,
				percent: 50,
				overageCost: 0.02,
				estimatedOverage: 0,
			},
		];
		const line = formatResourceLines(resources);
		expect(line).toContain("15.0B / 30.0B");
	});

	it("formats millions correctly", () => {
		const resources: ResourceStatus[] = [
			{
				name: "kv-reads",
				current: 6_100_000,
				limit: 10_000_000,
				percent: 61,
				overageCost: 0.5,
				estimatedOverage: 0,
			},
		];
		const line = formatResourceLines(resources);
		expect(line).toContain("6.1M / 10.0M");
	});

	it("formats small numbers without suffix", () => {
		const resources: ResourceStatus[] = [
			{
				name: "kv-writes",
				current: 500,
				limit: 1_000_000,
				percent: 0.1,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const line = formatResourceLines(resources);
		expect(line).toContain("500 / 1.0M");
	});

	it("clamps progress bar at 100%", () => {
		const resources: ResourceStatus[] = [
			{
				name: "kv-writes",
				current: 1_500_000,
				limit: 1_000_000,
				percent: 150,
				overageCost: 5,
				estimatedOverage: 2.5,
			},
		];
		const line = formatResourceLines(resources);
		expect(line).toContain("==========");
	});
});

describe("billingPeriodRemainderSeconds", () => {
	it("returns seconds until next billing day", () => {
		const now = new Date("2026-04-15T00:00:00Z");
		const seconds = billingPeriodRemainderSeconds(1, now);
		const days = seconds / 86400;
		expect(days).toBeCloseTo(16, 0);
	});

	it("returns seconds to next month when today >= billingDay", () => {
		const now = new Date("2026-04-01T00:00:00Z");
		const seconds = billingPeriodRemainderSeconds(1, now);
		const days = seconds / 86400;
		expect(days).toBeCloseTo(30, 0);
	});

	it("returns at least 60 seconds", () => {
		const now = new Date("2026-04-14T23:59:59Z");
		const seconds = billingPeriodRemainderSeconds(15, now);
		expect(seconds).toBeGreaterThanOrEqual(60);
	});

	it("handles December billing day rollover", () => {
		const now = new Date("2026-12-15T00:00:00Z");
		const seconds = billingPeriodRemainderSeconds(1, now);
		const days = seconds / 86400;
		expect(days).toBeCloseTo(17, 0);
	});

	it("clamps billing day for short months", () => {
		const now = new Date("2026-01-31T00:00:00Z");
		const seconds = billingPeriodRemainderSeconds(31, now);
		expect(seconds).toBeGreaterThan(60);
	});
});
