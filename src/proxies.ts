import { UsageGuardError } from "./errors";
import type { ResourceName, UsageGuard } from "./types";
import { RESOURCES } from "./types";

export type OnTrip = "throw" | "skip" | ((resource: string, method: string) => void);
export interface ProxyOptions {
	onTrip?: OnTrip;
}
export interface GuardEnvOptions extends ProxyOptions {
	exclude?: string[];
}

function handleTrip(resource: ResourceName, method: string, onTrip: OnTrip): void {
	if (onTrip === "skip") return;
	if (typeof onTrip === "function") {
		onTrip(resource, method);
		return;
	}
	throw new UsageGuardError(resource, method);
}

async function check(
	guard: UsageGuard,
	resource: ResourceName,
	method: string,
	onTrip: OnTrip,
): Promise<boolean> {
	const tripped = await guard.isTripped(resource);
	if (tripped) {
		handleTrip(resource, method, onTrip);
		return true;
	}
	return false;
}

export function guardKV(kv: KVNamespace, guard: UsageGuard, opts?: ProxyOptions): KVNamespace {
	const onTrip = opts?.onTrip ?? "throw";

	return {
		async get(...args: Parameters<KVNamespace["get"]>) {
			if (await check(guard, RESOURCES.KV_READS, "get", onTrip)) return null;
			return (kv.get as (...a: unknown[]) => unknown)(...args) as ReturnType<KVNamespace["get"]>;
		},
		async getWithMetadata(...args: Parameters<KVNamespace["getWithMetadata"]>) {
			if (await check(guard, RESOURCES.KV_READS, "getWithMetadata", onTrip))
				return { value: null, metadata: null } as never;
			return (kv.getWithMetadata as (...a: unknown[]) => unknown)(...args) as ReturnType<
				KVNamespace["getWithMetadata"]
			>;
		},
		async put(...args: Parameters<KVNamespace["put"]>) {
			if (await check(guard, RESOURCES.KV_WRITES, "put", onTrip)) return;
			return kv.put(...args);
		},
		async delete(key: string) {
			if (await check(guard, RESOURCES.KV_DELETES, "delete", onTrip)) return;
			return kv.delete(key);
		},
		async list(options?: KVNamespaceListOptions) {
			if (await check(guard, RESOURCES.KV_LISTS, "list", onTrip))
				return { keys: [], list_complete: true, cacheStatus: null } as never;
			return kv.list(options);
		},
	} as KVNamespace;
}

export function guardD1(db: D1Database, guard: UsageGuard, opts?: ProxyOptions): D1Database {
	const onTrip = opts?.onTrip ?? "throw";

	const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
		({
			bind(...values: unknown[]) {
				return wrapStatement(stmt.bind(...values));
			},
			async first(colName?: string) {
				if (await check(guard, RESOURCES.D1_READS, "first", onTrip)) return null;
				return colName ? stmt.first(colName) : stmt.first();
			},
			async all() {
				if (await check(guard, RESOURCES.D1_READS, "all", onTrip))
					return { results: [], success: true, meta: {} } as never;
				return stmt.all();
			},
			async raw(options?: { columnNames?: boolean }) {
				if (await check(guard, RESOURCES.D1_READS, "raw", onTrip)) return [] as never;
				return stmt.raw(options as { columnNames: true });
			},
			async run() {
				if (await check(guard, RESOURCES.D1_WRITES, "run", onTrip))
					return { results: [], success: true, meta: {} } as never;
				return stmt.run();
			},
		}) as unknown as D1PreparedStatement;

	return {
		prepare(query: string) {
			return wrapStatement(db.prepare(query));
		},
		async batch<T = unknown>(statements: D1PreparedStatement[]) {
			if (await check(guard, RESOURCES.D1_WRITES, "batch", onTrip)) return [] as never;
			return db.batch<T>(statements);
		},
		async exec(query: string) {
			if (await check(guard, RESOURCES.D1_WRITES, "exec", onTrip))
				return { count: 0, duration: 0 } as never;
			return db.exec(query);
		},
		async dump() {
			if (await check(guard, RESOURCES.D1_READS, "dump", onTrip)) return new ArrayBuffer(0);
			return db.dump();
		},
	} as D1Database;
}

export function guardR2(bucket: R2Bucket, guard: UsageGuard, opts?: ProxyOptions): R2Bucket {
	const onTrip = opts?.onTrip ?? "throw";

	return {
		async get(...args: Parameters<R2Bucket["get"]>) {
			if (await check(guard, RESOURCES.R2_CLASS_B, "get", onTrip)) return null as never;
			return (bucket.get as (...a: unknown[]) => unknown)(...args) as ReturnType<R2Bucket["get"]>;
		},
		async head(key: string) {
			if (await check(guard, RESOURCES.R2_CLASS_B, "head", onTrip)) return null as never;
			return bucket.head(key);
		},
		async list(options?: R2ListOptions) {
			if (await check(guard, RESOURCES.R2_CLASS_B, "list", onTrip))
				return { objects: [], truncated: false, delimitedPrefixes: [] } as never;
			return bucket.list(options);
		},
		async put(...args: Parameters<R2Bucket["put"]>) {
			if (await check(guard, RESOURCES.R2_CLASS_A, "put", onTrip)) return null as never;
			return (bucket.put as (...a: unknown[]) => unknown)(...args) as ReturnType<R2Bucket["put"]>;
		},
		async delete(keys: string | string[]) {
			if (await check(guard, RESOURCES.R2_CLASS_A, "delete", onTrip)) return;
			return bucket.delete(keys);
		},
		async createMultipartUpload(key: string, options?: R2MultipartOptions) {
			if (await check(guard, RESOURCES.R2_CLASS_A, "createMultipartUpload", onTrip))
				return null as never;
			return bucket.createMultipartUpload(key, options);
		},
		resumeMultipartUpload(key: string, uploadId: string) {
			return bucket.resumeMultipartUpload(key, uploadId);
		},
	} as R2Bucket;
}

export function guardQueue<T = unknown>(
	queue: Queue<T>,
	guard: UsageGuard,
	opts?: ProxyOptions,
): Queue<T> {
	const onTrip = opts?.onTrip ?? "throw";

	return {
		async send(message: T, options?: QueueSendOptions) {
			if (await check(guard, RESOURCES.QUEUE_OPERATIONS, "send", onTrip)) return;
			return queue.send(message, options);
		},
		async sendBatch(messages: Iterable<MessageSendRequest<T>>, options?: QueueSendBatchOptions) {
			if (await check(guard, RESOURCES.QUEUE_OPERATIONS, "sendBatch", onTrip)) return;
			return queue.sendBatch(messages, options);
		},
	} as Queue<T>;
}

export function guardAI(ai: Ai, guard: UsageGuard, opts?: ProxyOptions): Ai {
	const onTrip = opts?.onTrip ?? "throw";

	return {
		async run(...args: Parameters<Ai["run"]>) {
			if (await check(guard, RESOURCES.AI_NEURONS, "run", onTrip)) return null as never;
			return (ai.run as (...a: unknown[]) => unknown)(...args) as ReturnType<Ai["run"]>;
		},
	} as Ai;
}

export function guardVectorize(
	index: VectorizeIndex,
	guard: UsageGuard,
	opts?: ProxyOptions,
): VectorizeIndex {
	const onTrip = opts?.onTrip ?? "throw";

	return {
		async query(vector: VectorFloatArray | number[], options: VectorizeQueryOptions) {
			if (await check(guard, RESOURCES.VECTORIZE_QUERIES, "query", onTrip))
				return { count: 0, matches: [] } as never;
			return index.query(vector, options);
		},
		async insert(vectors: VectorizeVector[]) {
			return index.insert(vectors);
		},
		async upsert(vectors: VectorizeVector[]) {
			return index.upsert(vectors);
		},
		async deleteByIds(ids: string[]) {
			return index.deleteByIds(ids);
		},
		async getByIds(ids: string[]) {
			return index.getByIds(ids);
		},
		async describe() {
			return index.describe();
		},
	} as VectorizeIndex;
}

function hasMethod(obj: unknown, ...methods: string[]): boolean {
	if (!obj || typeof obj !== "object") return false;
	return methods.every((m) => typeof (obj as Record<string, unknown>)[m] === "function");
}

function detectAndWrap(binding: unknown, guard: UsageGuard, opts?: ProxyOptions): unknown {
	if (!binding || typeof binding !== "object") return binding;
	if (hasMethod(binding, "prepare", "batch", "exec"))
		return guardD1(binding as D1Database, guard, opts);
	if (hasMethod(binding, "head", "createMultipartUpload"))
		return guardR2(binding as R2Bucket, guard, opts);
	if (hasMethod(binding, "getWithMetadata")) return guardKV(binding as KVNamespace, guard, opts);
	if (hasMethod(binding, "send", "sendBatch") && !hasMethod(binding, "get"))
		return guardQueue(binding as Queue, guard, opts);
	if (hasMethod(binding, "run") && !hasMethod(binding, "get", "send"))
		return guardAI(binding as Ai, guard, opts);
	if (hasMethod(binding, "query", "insert", "describe") && !hasMethod(binding, "prepare"))
		return guardVectorize(binding as VectorizeIndex, guard, opts);
	return binding;
}

export function guardEnv<E extends Record<string, unknown>>(
	env: E,
	guard: UsageGuard,
	opts?: GuardEnvOptions,
): E {
	const exclude = new Set(opts?.exclude ?? []);
	const result = { ...env };
	for (const key of Object.keys(result)) {
		if (exclude.has(key)) continue;
		if (result[key] === guard.kv) continue;
		(result as Record<string, unknown>)[key] = detectAndWrap(result[key], guard, opts);
	}
	return result as E;
}
