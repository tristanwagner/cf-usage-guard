import {
	GRANULARITIES,
	RESOURCES,
	type ResolvedBudget,
	type ResolvedConfig,
	type ResolvedThreshold,
	type ResourceName,
	type UsageGuardConfig,
} from "./types";

const RESOURCE_NAMES: ResourceName[] = Object.values(RESOURCES);

/** Default thresholds for all resources. Exported so consumers can restore defaults after overriding. Frozen to prevent accidental mutation. */
export const DEFAULT_THRESHOLDS: Readonly<Record<ResourceName, Readonly<ResolvedThreshold>>> =
	Object.freeze({
		[RESOURCES.WORKERS_REQUESTS]: {
			limit: 10_000_000,
			warn: 80,
			trip: 95,
			recover: 90,
			overageCost: 0.3,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.WORKERS_CPU]: {
			limit: 30_000_000_000,
			warn: 80,
			trip: 95,
			recover: 90,
			overageCost: 0.02,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.KV_READS]: {
			limit: 10_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.5,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.KV_WRITES]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 5.0,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.KV_DELETES]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 5.0,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.KV_LISTS]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 5.0,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.D1_READS]: {
			limit: 25_000_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.001,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.D1_WRITES]: {
			limit: 50_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 1.0,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.R2_CLASS_A]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 4.5,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.R2_CLASS_B]: {
			limit: 10_000_000,
			warn: 80,
			trip: 95,
			recover: 90,
			overageCost: 0.36,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.QUEUE_OPERATIONS]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.4,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.DO_REQUESTS]: {
			limit: 1_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.15,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.DO_WALL_TIME]: {
			limit: 400_000_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 12.5,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.AI_NEURONS]: {
			limit: 10_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.011,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.DAILY,
		},
		[RESOURCES.VECTORIZE_QUERIES]: {
			limit: 50_000_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 0.01,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.PAGES_REQUESTS]: {
			limit: 10_000_000,
			warn: 80,
			trip: 95,
			recover: 90,
			overageCost: 0.3,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
		[RESOURCES.STREAM_MINUTES]: {
			limit: 1_000,
			warn: 80,
			trip: 90,
			recover: 85,
			overageCost: 1000,
			tripAt: null,
			maxOverageUsd: null,
			granularity: GRANULARITIES.MONTHLY,
		},
	});

const noopLogger = {
	warn: () => {},
	error: () => {},
	debug: () => {},
};

export function validateAndResolve(config: UsageGuardConfig): ResolvedConfig {
	if (!config.accountId || config.accountId.trim() === "") {
		throw new Error("accountId is required and must not be empty.");
	}
	if (!config.apiToken || config.apiToken.trim() === "") {
		throw new Error("apiToken is required and must not be empty.");
	}

	const billingDay = config.billingDay ?? 1;
	if (billingDay < 1 || billingDay > 31 || !Number.isInteger(billingDay)) {
		throw new Error(`Invalid billingDay: ${billingDay}. Must be an integer between 1 and 31.`);
	}

	const keyPrefix = config.keyPrefix ?? "cfug:";
	if (!keyPrefix.endsWith(":")) {
		throw new Error(`Invalid keyPrefix: "${keyPrefix}". Must end with ":".`);
	}

	const alertTimeout = config.alertTimeout ?? 10_000;
	if (alertTimeout <= 0) {
		throw new Error(`Invalid alertTimeout: ${alertTimeout}. Must be a positive number.`);
	}

	const thresholds = { ...DEFAULT_THRESHOLDS };
	if (config.thresholds) {
		for (const name of RESOURCE_NAMES) {
			const override = config.thresholds[name];
			if (override) {
				thresholds[name] = mergeThreshold(name, thresholds[name], override);
			}
		}
	}

	return {
		kv: config.kv,
		accountId: config.accountId,
		apiToken: config.apiToken,
		billingDay,
		thresholds,
		budget: resolveBudget(config),
		alerts: config.alerts ?? [],
		logger: config.logger ?? noopLogger,
		keyPrefix,
		alertTimeout,
		onEvaluate: config.onEvaluate ?? null,
		dryRun: config.dryRun ?? false,
	};
}

const VALID_GRANULARITIES = new Set<string>(Object.values(GRANULARITIES));

function resolveBudget(config: UsageGuardConfig): ResolvedBudget | null {
	if (!config.budget) return null;

	const { maxUsd, warn, granularity } = config.budget;

	if (maxUsd <= 0) {
		throw new Error(`Invalid budget: maxUsd (${maxUsd}) must be positive.`);
	}

	const resolvedWarn = warn ?? 80;
	if (resolvedWarn < 0 || resolvedWarn > 100) {
		throw new Error(`Invalid budget: warn (${resolvedWarn}) must be between 0 and 100.`);
	}

	const resolvedGranularity = granularity ?? GRANULARITIES.MONTHLY;
	if (!VALID_GRANULARITIES.has(resolvedGranularity)) {
		throw new Error(
			`Invalid budget: granularity "${resolvedGranularity}" must be one of: ${[...VALID_GRANULARITIES].join(", ")}.`,
		);
	}

	return {
		maxUsd,
		warn: resolvedWarn,
		granularity: resolvedGranularity,
	};
}

function mergeThreshold(
	name: ResourceName,
	base: ResolvedThreshold,
	override: Partial<ResolvedThreshold>,
): ResolvedThreshold {
	const merged: ResolvedThreshold = {
		limit: override.limit ?? base.limit,
		warn: override.warn ?? base.warn,
		trip: override.trip !== undefined ? override.trip : base.trip,
		recover: override.recover !== undefined ? override.recover : base.recover,
		overageCost: override.overageCost ?? base.overageCost,
		tripAt: override.tripAt !== undefined ? override.tripAt : base.tripAt,
		maxOverageUsd:
			override.maxOverageUsd !== undefined ? override.maxOverageUsd : base.maxOverageUsd,
		granularity: override.granularity ?? base.granularity,
	};

	if (merged.warn < 0 || merged.warn > 100) {
		throw new Error(
			`Invalid threshold for ${name}: warn (${merged.warn}) must be between 0 and 100.`,
		);
	}

	if (merged.trip !== null) {
		if (merged.trip < 0 || merged.trip > 100) {
			throw new Error(
				`Invalid threshold for ${name}: trip (${merged.trip}) must be between 0 and 100.`,
			);
		}
		if (merged.warn >= merged.trip) {
			throw new Error(
				`Invalid threshold for ${name}: warn (${merged.warn}) must be less than trip (${merged.trip}).`,
			);
		}

		const recover = merged.recover ?? merged.trip - 5;
		if (recover < 0 || recover > 100) {
			throw new Error(
				`Invalid threshold for ${name}: recover (${recover}) must be between 0 and 100.`,
			);
		}
		if (recover >= merged.trip) {
			throw new Error(
				`Invalid threshold for ${name}: recover (${recover}) must be less than trip (${merged.trip}).`,
			);
		}
		merged.recover = recover;
	} else {
		merged.recover = null;
	}

	if (merged.limit <= 0) {
		throw new Error(`Invalid threshold for ${name}: limit (${merged.limit}) must be positive.`);
	}

	if (merged.tripAt !== null && merged.tripAt <= 0) {
		throw new Error(`Invalid threshold for ${name}: tripAt (${merged.tripAt}) must be positive.`);
	}

	if (merged.maxOverageUsd !== null && merged.maxOverageUsd <= 0) {
		throw new Error(
			`Invalid threshold for ${name}: maxOverageUsd (${merged.maxOverageUsd}) must be positive.`,
		);
	}

	return merged;
}
