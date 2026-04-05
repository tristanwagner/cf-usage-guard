import type {
	BudgetStatus,
	GuardState,
	ResolvedBudget,
	ResolvedConfig,
	ResolvedThreshold,
	ResourceStatus,
} from "./types";

export interface ThresholdResult {
	shouldTrip: boolean;
	shouldRecover: boolean;
	warnResources: ResourceStatus[];
	tripResources: ResourceStatus[];
	budgetStatus: BudgetStatus | null;
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

export function computeBudgetStatus(
	resources: ResourceStatus[],
	budget: ResolvedBudget,
): BudgetStatus {
	let totalOverageUsd = 0;
	for (const r of resources) {
		totalOverageUsd += r.estimatedOverage;
	}
	totalOverageUsd = Math.round(totalOverageUsd * 100) / 100;
	const percent = budget.maxUsd > 0 ? (totalOverageUsd / budget.maxUsd) * 100 : 0;
	return { totalOverageUsd, maxUsd: budget.maxUsd, percent };
}

export function isBudgetTripped(rs: ResourceStatus, budgetStatus: BudgetStatus): boolean {
	return budgetStatus.percent >= 100 && rs.estimatedOverage > 0;
}

export function evaluateThresholds(
	resources: ResourceStatus[],
	config: ResolvedConfig,
	currentState: GuardState | null,
	budgetResources?: ResourceStatus[],
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

	let budgetStatus: BudgetStatus | null = null;

	if (config.budget) {
		const budgetSource = budgetResources ?? resources;
		budgetStatus = computeBudgetStatus(budgetSource, config.budget);
		hasTrippableResource = true;

		if (budgetStatus.percent >= 100) {
			for (const resource of resources) {
				if (resource.estimatedOverage > 0 && !tripResources.includes(resource)) {
					tripResources.push(resource);
				}
			}
			allTrippableBelowRecover = false;
		} else if (budgetStatus.percent >= config.budget.warn) {
			for (const resource of resources) {
				if (resource.estimatedOverage > 0 && !warnResources.includes(resource)) {
					warnResources.push(resource);
				}
			}
			if (isCurrentlyTripped) {
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

	return { shouldTrip, shouldRecover, warnResources, tripResources, budgetStatus };
}
