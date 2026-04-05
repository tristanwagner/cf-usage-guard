import type { GuardState, ResolvedConfig, ResolvedThreshold, ResourceStatus } from "./types";

export interface ThresholdResult {
	shouldTrip: boolean;
	shouldRecover: boolean;
	warnResources: ResourceStatus[];
	tripResources: ResourceStatus[];
}

export function isTrippable(t: ResolvedThreshold): boolean {
	return t.trip !== null || t.tripAt !== null || t.maxOverageUsd !== null;
}

export function isOverThreshold(rs: ResourceStatus, t: ResolvedThreshold): boolean {
	if (t.trip !== null && rs.percent >= t.trip) return true;
	if (t.tripAt !== null && rs.current >= t.tripAt) return true;
	if (t.maxOverageUsd !== null) {
		const overageUnits = Math.max(0, rs.current - t.limit);
		const overageCost = (overageUnits * t.overageCost) / 1_000_000;
		if (overageCost >= t.maxOverageUsd) return true;
	}
	return false;
}

export function evaluateThresholds(
	resources: ResourceStatus[],
	config: ResolvedConfig,
	currentState: GuardState | null,
): ThresholdResult {
	const isCurrentlyTripped = currentState?.tripped ?? false;

	const warnResources: ResourceStatus[] = [];
	const tripResources: ResourceStatus[] = [];
	let allTrippableBelowRecover = true;
	let hasTrippableResource = false;

	for (const resource of resources) {
		const threshold = config.thresholds[resource.name];

		if (resource.percent >= threshold.warn) {
			warnResources.push(resource);
		}

		if (isTrippable(threshold)) {
			hasTrippableResource = true;

			if (isOverThreshold(resource, threshold)) {
				tripResources.push(resource);
				allTrippableBelowRecover = false;
			} else if (threshold.recover !== null && resource.percent >= threshold.recover) {
				allTrippableBelowRecover = false;
			}
		}
	}

	const shouldTrip = !isCurrentlyTripped && tripResources.length > 0;
	const shouldRecover =
		isCurrentlyTripped &&
		currentState?.tripReason === "threshold" &&
		hasTrippableResource &&
		allTrippableBelowRecover;

	return { shouldTrip, shouldRecover, warnResources, tripResources };
}
