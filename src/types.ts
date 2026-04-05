export const RESOURCES = {
	WORKERS_REQUESTS: "workers-requests",
	WORKERS_CPU: "workers-cpu",
	KV_READS: "kv-reads",
	KV_WRITES: "kv-writes",
	KV_DELETES: "kv-deletes",
	KV_LISTS: "kv-lists",
	D1_READS: "d1-reads",
	D1_WRITES: "d1-writes",
	R2_CLASS_A: "r2-class-a",
	R2_CLASS_B: "r2-class-b",
	QUEUE_OPERATIONS: "queue-operations",
	DO_REQUESTS: "do-requests",
	DO_WALL_TIME: "do-wall-time",
	AI_NEURONS: "ai-neurons",
	VECTORIZE_QUERIES: "vectorize-queries",
	PAGES_REQUESTS: "pages-requests",
	STREAM_MINUTES: "stream-minutes",
} as const;
export type ResourceName = (typeof RESOURCES)[keyof typeof RESOURCES];

export const ALERT_LEVELS = {
	WARN: "warn",
	TRIP: "trip",
	RECOVER: "recover",
} as const;
export type AlertLevel = (typeof ALERT_LEVELS)[keyof typeof ALERT_LEVELS];

export const ALERT_CHANNEL_TYPES = {
	DISCORD: "discord",
	SLACK: "slack",
	CUSTOM: "custom",
} as const;
export type AlertChannelType = (typeof ALERT_CHANNEL_TYPES)[keyof typeof ALERT_CHANNEL_TYPES];

export const TRIP_REASONS = {
	THRESHOLD: "threshold",
	MANUAL: "manual",
} as const;
export type TripReason = (typeof TRIP_REASONS)[keyof typeof TRIP_REASONS];

export const TRANSITIONS = {
	TRIP: "trip",
	RECOVER: "recover",
} as const;
export type Transition = (typeof TRANSITIONS)[keyof typeof TRANSITIONS];

export interface ResourceThreshold {
	limit?: number;
	warn?: number;
	trip?: number | null;
	recover?: number | null;
	overageCost?: number;
	tripAt?: number | null;
	maxOverageUsd?: number | null;
}

export type AlertChannel =
	| { type: typeof ALERT_CHANNEL_TYPES.DISCORD; url: string }
	| { type: typeof ALERT_CHANNEL_TYPES.SLACK; url: string }
	| { type: typeof ALERT_CHANNEL_TYPES.CUSTOM; handler: (event: AlertEvent) => Promise<void> };

export interface AlertEvent {
	level: AlertLevel;
	resources: ResourceStatus[];
	accountId: string;
	timestamp: string;
	billingPeriod: { start: string; end: string };
}

export interface ResourceStatus {
	name: ResourceName;
	current: number;
	limit: number;
	/** Full-precision percentage for threshold evaluation */
	percent: number;
	overageCost: number;
	estimatedOverage: number;
}

export interface Logger {
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
	debug(msg: string, meta?: Record<string, unknown>): void;
}

export interface EvaluateEvent {
	state: GuardState;
	billingPeriod: { start: string; end: string };
	transitioned: Transition | null;
}

export interface UsageGuardConfig {
	kv: KVNamespace;
	accountId: string;
	apiToken: string;
	billingDay?: number;
	thresholds?: Partial<Record<ResourceName, Partial<ResourceThreshold>>>;
	alerts?: AlertChannel[];
	logger?: Logger;
	keyPrefix?: string;
	alertTimeout?: number;
	onEvaluate?: (event: EvaluateEvent) => void | Promise<void>;
	dryRun?: boolean;
}

export interface UsageGuard {
	/** The KV namespace used by this guard (for guardEnv auto-exclusion) */
	readonly kv: KVNamespace;
	/** Global trip check (any resource), or per-resource when name is passed */
	isTripped(resource?: ResourceName): Promise<boolean>;
	/** Returns list of resources currently over their trip threshold */
	trippedResources(): Promise<ResourceName[]>;
	evaluate(): Promise<void>;
	getState(): Promise<GuardState | null>;
	trip(reason?: string): Promise<void>;
	reset(): Promise<void>;
}

export interface GuardState {
	version: 1;
	tripped: boolean;
	trippedAt: string | null;
	tripReason: TripReason | null;
	manualTripReason: string | null;
	resources: ResourceStatus[];
	lastCheckAt: string;
}

export interface ResolvedThreshold {
	limit: number;
	warn: number;
	trip: number | null;
	recover: number | null;
	overageCost: number;
	tripAt: number | null;
	maxOverageUsd: number | null;
}

export interface ResolvedConfig {
	kv: KVNamespace;
	accountId: string;
	apiToken: string;
	billingDay: number;
	thresholds: Record<ResourceName, ResolvedThreshold>;
	alerts: AlertChannel[];
	logger: Logger;
	keyPrefix: string;
	alertTimeout: number;
	onEvaluate: ((event: EvaluateEvent) => void | Promise<void>) | null;
	dryRun: boolean;
}

export interface UsageData {
	resources: ResourceStatus[];
	fetchedAt: string;
}

export interface WrapperConfig<E> {
	kv: (env: E) => KVNamespace;
	accountId: (env: E) => string;
	apiToken: (env: E) => string;
	billingDay?: number;
	thresholds?: Partial<Record<ResourceName, Partial<ResourceThreshold>>>;
	alerts?: (env: E) => AlertChannel[];
	logger?: (env: E) => Logger;
	keyPrefix?: string;
	alertTimeout?: number;
	evaluateCron: string;
	onEvaluate?: (event: EvaluateEvent) => void | Promise<void>;
}
