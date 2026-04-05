import { billingPeriodRemainderSeconds, sendAlerts } from "./alerts";
import {
	fetchUsage,
	fetchUsageForPeriod,
	getBillingPeriod,
	getDailyPeriod,
	getWeeklyPeriod,
} from "./query";
import {
	computeBudgetStatus,
	evaluateThresholds,
	isBudgetTripped,
	isOverThreshold,
	isTrippable,
} from "./thresholds";
import {
	ALERT_LEVELS,
	type AlertLevel,
	type BudgetStatus,
	type EvaluateEvent,
	type GuardState,
	RESOURCES,
	type ResolvedConfig,
	type ResourceName,
	type ResourceStatus,
	TRANSITIONS,
	TRIP_REASONS,
	type Transition,
	type TripReason,
	type UsageGuard,
	type UsageGuardConfig,
} from "./types";
import { validateAndResolve } from "./validation";

export function createUsageGuard(config: UsageGuardConfig): UsageGuard {
	const resolved = validateAndResolve(config);
	return new UsageGuardImpl(resolved);
}

class UsageGuardImpl implements UsageGuard {
	private config: ResolvedConfig;
	readonly kv: KVNamespace;

	constructor(config: ResolvedConfig) {
		this.config = config;
		this.kv = config.kv;
	}

	async isTripped(resource?: ResourceName): Promise<boolean> {
		if (this.config.dryRun) return false;

		let state: GuardState | null = null;
		try {
			const stateRaw = await this.config.kv.get(this.stateKey());
			if (stateRaw) state = JSON.parse(stateRaw) as GuardState;
		} catch {
			this.config.logger.warn("KV read failed for state key");
		}

		if (resource) {
			if (state) {
				const rs = state.resources.find((r) => r.name === resource);
				if (rs) return this.isResourceTripped(rs, state.budget);
			}
			return this.isSafetyNetTripped(resource);
		}

		if (state?.tripped) return true;

		try {
			const tripped = await this.config.kv.get(this.trippedKey());
			if (tripped) return true;
		} catch {
			this.config.logger.warn("KV read failed for tripped key");
		}

		return false;
	}

	async trippedResources(): Promise<ResourceName[]> {
		let state: GuardState | null = null;
		try {
			const raw = await this.config.kv.get(this.stateKey());
			if (raw) state = JSON.parse(raw) as GuardState;
		} catch {
			this.config.logger.warn("KV read failed for trippedResources");
		}

		if (state) {
			const result: ResourceName[] = [];
			for (const rs of state.resources) {
				if (this.isResourceTripped(rs, state.budget)) {
					result.push(rs.name);
				}
			}
			return result;
		}

		try {
			const tripped = await this.config.kv.get(this.trippedKey());
			if (tripped) {
				return Object.values(RESOURCES).filter((name) => isTrippable(this.config.thresholds[name]));
			}
		} catch {
			this.config.logger.warn("KV read failed for tripped key in trippedResources");
		}

		return [];
	}

	private async isSafetyNetTripped(resource: ResourceName): Promise<boolean> {
		if (!isTrippable(this.config.thresholds[resource])) return false;
		try {
			const tripped = await this.config.kv.get(this.trippedKey());
			if (tripped) return true;
		} catch {
			this.config.logger.warn("KV read failed for tripped key");
		}
		return false;
	}

	async evaluate(): Promise<void> {
		const now = new Date();

		let currentState: GuardState | null = null;
		try {
			const raw = await this.config.kv.get(this.stateKey());
			if (raw) currentState = JSON.parse(raw) as GuardState;
		} catch {
			this.config.logger.warn("KV read failed for state during evaluate");
		}

		if (!currentState) {
			try {
				const trippedVal = await this.config.kv.get(this.trippedKey());
				if (trippedVal) {
					currentState = {
						version: 1,
						tripped: true,
						trippedAt: trippedVal,
						tripReason: TRIP_REASONS.THRESHOLD,
						manualTripReason: null,
						resources: [],
						budget: null,
						lastCheckAt: trippedVal,
					};
					this.config.logger.debug("Reconciled state from tripped safety net key");
				}
			} catch {
				this.config.logger.warn("KV read failed for tripped key during evaluate reconciliation");
			}
		}

		let resources: ResourceStatus[];
		let budgetResources: ResourceStatus[] | undefined;
		try {
			const fetched = await this.fetchMergedResources(now);
			resources = fetched.resources;
			budgetResources = fetched.budgetResources;
		} catch (err) {
			this.config.logger.error("CF API query failed, maintaining cached state", {
				error: String(err),
			});
			return;
		}

		const result = evaluateThresholds(resources, this.config, currentState, budgetResources);
		const budgetStatus = result.budgetStatus;
		const period = getBillingPeriod(this.config.billingDay, now);
		let transitioned: Transition | null = null;

		if (this.config.dryRun) {
			if (result.shouldTrip) transitioned = TRANSITIONS.TRIP;
			else if (result.shouldRecover) transitioned = TRANSITIONS.RECOVER;
			await this.fireDryRunOnEvaluate(
				resources,
				budgetStatus,
				period,
				now,
				transitioned,
				currentState,
			);
			return;
		}

		if (result.shouldTrip) {
			await this.tripInternal(TRIP_REASONS.THRESHOLD, null, resources, budgetStatus, now);
			await this.alert(ALERT_LEVELS.TRIP, result.tripResources, period, now);
			transitioned = TRANSITIONS.TRIP;
		} else if (result.shouldRecover) {
			await this.recoverInternal(resources, budgetStatus, now);
			await this.alert(ALERT_LEVELS.RECOVER, resources, period, now);
			transitioned = TRANSITIONS.RECOVER;
		} else {
			await this.saveState(
				currentState?.tripped ?? false,
				currentState?.trippedAt ?? null,
				currentState?.tripReason ?? null,
				currentState?.manualTripReason ?? null,
				resources,
				budgetStatus,
				now,
			);
		}

		if (result.warnResources.length > 0 && !result.shouldTrip) {
			for (const resource of result.warnResources) {
				await this.alert(ALERT_LEVELS.WARN, [resource], period, now);
			}
		}

		await this.fireOnEvaluate(resources, period, now, transitioned);
	}

	async getState(): Promise<GuardState | null> {
		try {
			const raw = await this.config.kv.get(this.stateKey());
			if (!raw) return null;
			return JSON.parse(raw) as GuardState;
		} catch {
			this.config.logger.warn("KV read failed for getState");
			return null;
		}
	}

	async trip(reason?: string): Promise<void> {
		const now = new Date();
		const currentState = await this.getState();
		await this.tripInternal(
			TRIP_REASONS.MANUAL,
			reason ?? null,
			currentState?.resources ?? [],
			currentState?.budget ?? null,
			now,
		);
		this.config.logger.debug("Guard manually tripped", { reason });
	}

	async reset(): Promise<void> {
		const now = new Date();
		const currentState = await this.getState();
		await this.recoverInternal(currentState?.resources ?? [], currentState?.budget ?? null, now);
		this.config.logger.debug("Guard manually reset");
	}

	private async tripInternal(
		tripReason: TripReason,
		manualTripReason: string | null,
		resources: ResourceStatus[],
		budgetStatus: BudgetStatus | null,
		now: Date,
	): Promise<void> {
		await this.saveState(
			true,
			now.toISOString(),
			tripReason,
			manualTripReason,
			resources,
			budgetStatus,
			now,
		);

		const ttl = billingPeriodRemainderSeconds(this.config.billingDay, now);
		try {
			await this.config.kv.put(this.trippedKey(), now.toISOString(), {
				expirationTtl: Math.max(60, ttl),
			});
		} catch {
			this.config.logger.warn("KV write failed for tripped safety net key");
		}
	}

	private async recoverInternal(
		resources: ResourceStatus[],
		budgetStatus: BudgetStatus | null,
		now: Date,
	): Promise<void> {
		await this.saveState(false, null, null, null, resources, budgetStatus, now);

		try {
			await this.config.kv.delete(this.trippedKey());
		} catch {
			this.config.logger.warn("KV delete failed for tripped key during recovery");
		}
	}

	private async saveState(
		tripped: boolean,
		trippedAt: string | null,
		tripReason: TripReason | null,
		manualTripReason: string | null,
		resources: ResourceStatus[],
		budgetStatus: BudgetStatus | null,
		now: Date,
	): Promise<void> {
		const state: GuardState = {
			version: 1,
			tripped,
			trippedAt,
			tripReason,
			manualTripReason,
			resources,
			budget: budgetStatus,
			lastCheckAt: now.toISOString(),
		};

		try {
			await this.config.kv.put(this.stateKey(), JSON.stringify(state));
		} catch {
			this.config.logger.warn("KV write failed for state");
		}
	}

	private async alert(
		level: AlertLevel,
		resources: ResourceStatus[],
		period: { start: string; end: string },
		now: Date,
	): Promise<void> {
		await sendAlerts(
			{
				level,
				resources,
				accountId: this.config.accountId,
				timestamp: now.toISOString(),
				billingPeriod: period,
			},
			this.config,
			now,
		);
	}

	private async fireDryRunOnEvaluate(
		resources: ResourceStatus[],
		budgetStatus: BudgetStatus | null,
		period: { start: string; end: string },
		now: Date,
		transitioned: Transition | null,
		currentState: GuardState | null,
	): Promise<void> {
		if (!this.config.onEvaluate) return;

		const wouldTrip = transitioned === TRANSITIONS.TRIP;
		const state: GuardState = {
			version: 1,
			tripped: wouldTrip || (currentState?.tripped ?? false),
			trippedAt: wouldTrip ? now.toISOString() : (currentState?.trippedAt ?? null),
			tripReason: wouldTrip ? TRIP_REASONS.THRESHOLD : (currentState?.tripReason ?? null),
			manualTripReason: currentState?.manualTripReason ?? null,
			resources,
			budget: budgetStatus,
			lastCheckAt: now.toISOString(),
		};

		if (transitioned === TRANSITIONS.RECOVER) {
			state.tripped = false;
			state.trippedAt = null;
			state.tripReason = null;
		}

		const event: EvaluateEvent = { state, billingPeriod: period, transitioned };

		try {
			await this.config.onEvaluate(event);
		} catch (err) {
			this.config.logger.error("onEvaluate hook failed", {
				error: String(err),
			});
		}
	}

	private async fireOnEvaluate(
		resources: ResourceStatus[],
		period: { start: string; end: string },
		now: Date,
		transitioned: Transition | null,
	): Promise<void> {
		if (!this.config.onEvaluate) return;

		const state = await this.getState();
		if (!state) return;

		const event: EvaluateEvent = { state, billingPeriod: period, transitioned };

		try {
			await this.config.onEvaluate(event);
		} catch (err) {
			this.config.logger.error("onEvaluate hook failed", {
				error: String(err),
			});
		}
	}

	private async fetchMergedResources(
		now: Date,
	): Promise<{ resources: ResourceStatus[]; budgetResources: ResourceStatus[] | undefined }> {
		const budgetGranularity = this.config.budget?.granularity;
		const needsDaily =
			Object.values(this.config.thresholds).some((t) => t.granularity === "daily") ||
			budgetGranularity === "daily";
		const needsWeekly =
			Object.values(this.config.thresholds).some((t) => t.granularity === "weekly") ||
			budgetGranularity === "weekly";

		const monthlyUsage = await fetchUsage(this.config, now);
		const monthlyByName = new Map(monthlyUsage.resources.map((r) => [r.name, r]));

		let dailyByName: Map<ResourceName, ResourceStatus> | null = null;
		if (needsDaily) {
			const dailyPeriod = getDailyPeriod(now);
			const dailyUsage = await fetchUsageForPeriod(this.config, dailyPeriod, now);
			dailyByName = new Map(dailyUsage.resources.map((r) => [r.name, r]));
		}

		let weeklyByName: Map<ResourceName, ResourceStatus> | null = null;
		if (needsWeekly) {
			const weeklyPeriod = getWeeklyPeriod(now);
			const weeklyUsage = await fetchUsageForPeriod(this.config, weeklyPeriod, now);
			weeklyByName = new Map(weeklyUsage.resources.map((r) => [r.name, r]));
		}

		const merged: ResourceStatus[] = [];
		for (const [name, threshold] of Object.entries(this.config.thresholds)) {
			const resourceName = name as ResourceName;
			let source: ResourceStatus | undefined;

			if (threshold.granularity === "daily" && dailyByName) {
				source = dailyByName.get(resourceName);
			} else if (threshold.granularity === "weekly" && weeklyByName) {
				source = weeklyByName.get(resourceName);
			}

			if (!source) {
				source = monthlyByName.get(resourceName);
			}

			if (source) {
				merged.push(source);
			}
		}

		let budgetResources: ResourceStatus[] | undefined;
		if (budgetGranularity && budgetGranularity !== "monthly") {
			const sourceMap = budgetGranularity === "daily" ? dailyByName : weeklyByName;
			if (sourceMap) {
				budgetResources = [...sourceMap.values()];
			}
		}

		return { resources: merged, budgetResources };
	}

	private isResourceTripped(rs: ResourceStatus, budgetStatus?: BudgetStatus | null): boolean {
		if (isOverThreshold(rs, this.config.thresholds[rs.name])) return true;
		if (budgetStatus) return isBudgetTripped(rs, budgetStatus);
		return false;
	}

	private stateKey(): string {
		return `${this.config.keyPrefix}state:v1`;
	}

	private trippedKey(): string {
		return `${this.config.keyPrefix}tripped`;
	}
}
