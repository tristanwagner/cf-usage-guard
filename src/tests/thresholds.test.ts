import { describe, expect, it } from "vitest";
import { evaluateThresholds } from "../thresholds";
import type { GuardState, ResourceStatus } from "../types";
import { validateAndResolve } from "../validation";
import { createMockKV } from "./helpers";

function resolvedConfig(overrides?: Parameters<typeof validateAndResolve>[0]["thresholds"]) {
	return validateAndResolve({
		kv: createMockKV(),
		accountId: "test",
		apiToken: "test",
		thresholds: overrides,
	});
}

function makeResource(name: ResourceStatus["name"], percent: number): ResourceStatus {
	return {
		name,
		current: percent * 10_000,
		limit: 1_000_000,
		percent,
		overageCost: 5,
		estimatedOverage: 0,
	};
}

function trippedState(tripReason: "threshold" | "manual" = "threshold"): GuardState {
	return {
		version: 1,
		tripped: true,
		trippedAt: "2026-04-10T00:00:00Z",
		tripReason,
		manualTripReason: null,
		resources: [],
		lastCheckAt: "2026-04-10T00:00:00Z",
	};
}

describe("evaluateThresholds", () => {
	it("no trip, no warn when all below warn threshold", () => {
		const resources = [makeResource("kv-writes", 50)];
		const result = evaluateThresholds(resources, resolvedConfig(), null);
		expect(result.shouldTrip).toBe(false);
		expect(result.shouldRecover).toBe(false);
		expect(result.warnResources).toHaveLength(0);
		expect(result.tripResources).toHaveLength(0);
	});

	it("warns when resource hits warn threshold", () => {
		const resources = [makeResource("kv-writes", 82)];
		const result = evaluateThresholds(resources, resolvedConfig(), null);
		expect(result.shouldTrip).toBe(false);
		expect(result.warnResources).toHaveLength(1);
		expect(result.warnResources[0].name).toBe("kv-writes");
	});

	it("trips when trippable resource hits trip threshold", () => {
		const resources = [makeResource("kv-writes", 92)];
		const result = evaluateThresholds(resources, resolvedConfig(), null);
		expect(result.shouldTrip).toBe(true);
		expect(result.tripResources).toHaveLength(1);
	});

	it("does not trip on warn-only resources even at 100%", () => {
		const config = resolvedConfig({ "workers-requests": { trip: null } });
		const resources = [makeResource("workers-requests", 100)];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(false);
		expect(result.warnResources).toHaveLength(1);
	});

	it("does not re-trip when already tripped", () => {
		const resources = [makeResource("kv-writes", 95)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldTrip).toBe(false);
	});

	it("recovers when all trippable resources below recover threshold", () => {
		const resources = [makeResource("kv-writes", 84), makeResource("d1-writes", 70)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(true);
	});

	it("stays tripped when any trippable resource is between recover and trip (hysteresis)", () => {
		const resources = [makeResource("kv-writes", 87)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(false);
		expect(result.shouldTrip).toBe(false);
	});

	it("stays tripped when one resource recovers but another stays high", () => {
		const resources = [makeResource("kv-writes", 50), makeResource("d1-writes", 88)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(false);
	});

	it("does not recover manually tripped guard via thresholds", () => {
		const resources = [makeResource("kv-writes", 10)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState("manual"));
		expect(result.shouldRecover).toBe(false);
	});

	it("handles resource at exact trip threshold", () => {
		const resources = [makeResource("kv-writes", 90)];
		const result = evaluateThresholds(resources, resolvedConfig(), null);
		expect(result.shouldTrip).toBe(true);
	});

	it("handles resource at exact recover threshold (does not recover)", () => {
		const resources = [makeResource("kv-writes", 85)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(false);
	});

	it("recovers when resource just below recover threshold", () => {
		const resources = [makeResource("kv-writes", 84.9)];
		const result = evaluateThresholds(resources, resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(true);
	});

	it("handles mixed trippable and warn-only resources", () => {
		const config = resolvedConfig({ "workers-requests": { trip: null } });
		const resources = [makeResource("workers-requests", 95), makeResource("kv-writes", 92)];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(true);
		expect(result.tripResources).toHaveLength(1);
		expect(result.tripResources[0].name).toBe("kv-writes");
		expect(result.warnResources).toHaveLength(2);
	});

	it("handles empty resources list", () => {
		const result = evaluateThresholds([], resolvedConfig(), null);
		expect(result.shouldTrip).toBe(false);
		expect(result.shouldRecover).toBe(false);
	});

	it("does not recover with empty resources when tripped (no trippable resources evaluated)", () => {
		const result = evaluateThresholds([], resolvedConfig(), trippedState());
		expect(result.shouldRecover).toBe(false);
	});

	it("handles custom thresholds", () => {
		const config = resolvedConfig({ "kv-writes": { trip: 70, warn: 50, recover: 60 } });
		const resources = [makeResource("kv-writes", 72)];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(true);
	});

	it("trips on absolute tripAt even when percent is below trip", () => {
		const config = resolvedConfig({ "kv-writes": { tripAt: 900_000 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 900_000,
				limit: 1_000_000,
				percent: 90,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(true);
	});

	it("does not trip on tripAt when current is below", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, tripAt: 900_000 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 800_000,
				limit: 1_000_000,
				percent: 80,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(false);
	});

	it("trips on maxOverageUsd when overage cost exceeds budget", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, maxOverageUsd: 5 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 2_000_000,
				limit: 1_000_000,
				percent: 200,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(true);
	});

	it("does not trip on maxOverageUsd when overage cost is under budget", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, maxOverageUsd: 10 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 1_500_000,
				limit: 1_000_000,
				percent: 150,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(false);
	});

	it("trips on any condition: percent OR tripAt OR maxOverageUsd", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, tripAt: null, maxOverageUsd: 1 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 1_200_000,
				limit: 1_000_000,
				percent: 120,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, null);
		expect(result.shouldTrip).toBe(true);
	});

	it("recovers from tripAt when current drops below", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, tripAt: 900_000 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 800_000,
				limit: 1_000_000,
				percent: 80,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, trippedState());
		expect(result.shouldRecover).toBe(true);
	});

	it("does not recover from tripAt when still above", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, tripAt: 900_000 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 950_000,
				limit: 1_000_000,
				percent: 95,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, trippedState());
		expect(result.shouldRecover).toBe(false);
	});

	it("recovers from maxOverageUsd when overage drops to zero", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, maxOverageUsd: 5 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 1_000_000,
				limit: 1_000_000,
				percent: 100,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, trippedState());
		expect(result.shouldRecover).toBe(true);
	});

	it("does not recover from maxOverageUsd when still over budget", () => {
		const config = resolvedConfig({ "kv-writes": { trip: null, maxOverageUsd: 3 } });
		const resources = [
			{
				name: "kv-writes" as const,
				current: 2_000_000,
				limit: 1_000_000,
				percent: 200,
				overageCost: 5,
				estimatedOverage: 0,
			},
		];
		const result = evaluateThresholds(resources, config, trippedState());
		expect(result.shouldRecover).toBe(false);
	});
});
