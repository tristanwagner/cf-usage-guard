import { describe, expect, it, vi } from "vitest";
import { UsageGuardError } from "../errors";
import {
	guardAI,
	guardD1,
	guardEnv,
	guardKV,
	guardQueue,
	guardR2,
	guardVectorize,
} from "../proxies";
import type { ResourceName, UsageGuard } from "../types";

function mockGuard(trippedResources: ResourceName[] = []): UsageGuard {
	return {
		kv: {} as KVNamespace,
		isTripped: vi.fn(async (resource?: ResourceName) => {
			if (!resource) return trippedResources.length > 0;
			return trippedResources.includes(resource);
		}),
		trippedResources: vi.fn(async () => trippedResources),
		evaluate: vi.fn(),
		getState: vi.fn(async () => null),
		trip: vi.fn(),
		reset: vi.fn(),
	};
}

function mockKV() {
	return {
		get: vi.fn(async () => "value"),
		getWithMetadata: vi.fn(async () => ({ value: "v", metadata: null })),
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
	} as unknown as KVNamespace;
}

function mockD1() {
	const stmt = {
		bind: vi.fn().mockReturnThis(),
		first: vi.fn(async () => ({ id: 1 })),
		all: vi.fn(async () => ({ results: [], success: true, meta: {} })),
		raw: vi.fn(async () => []),
		run: vi.fn(async () => ({ results: [], success: true, meta: {} })),
	} as unknown as D1PreparedStatement;
	return {
		db: {
			prepare: vi.fn(() => stmt),
			batch: vi.fn(async () => []),
			exec: vi.fn(async () => ({ count: 0, duration: 0 })),
			dump: vi.fn(async () => new ArrayBuffer(0)),
		} as unknown as D1Database,
		stmt,
	};
}

function mockR2() {
	return {
		get: vi.fn(async () => null),
		head: vi.fn(async () => null),
		list: vi.fn(async () => ({ objects: [], truncated: false })),
		put: vi.fn(async () => null),
		delete: vi.fn(async () => {}),
		createMultipartUpload: vi.fn(async () => ({})),
		resumeMultipartUpload: vi.fn(() => ({})),
	} as unknown as R2Bucket;
}

function mockQueue() {
	return {
		send: vi.fn(async () => {}),
		sendBatch: vi.fn(async () => {}),
	} as unknown as Queue;
}

function mockAi() {
	return {
		run: vi.fn(async () => ({ response: "ok" })),
	} as unknown as Ai;
}

describe("guardKV", () => {
	it("passes through when not tripped", async () => {
		const kv = mockKV();
		const guard = mockGuard();
		const guarded = guardKV(kv, guard);

		await guarded.get("key");
		expect(kv.get).toHaveBeenCalledWith("key");

		await guarded.put("key", "val");
		expect(kv.put).toHaveBeenCalledWith("key", "val");

		await guarded.delete("key");
		expect(kv.delete).toHaveBeenCalledWith("key");

		await guarded.list();
		expect(kv.list).toHaveBeenCalled();
	});

	it("throws UsageGuardError when kv-writes is tripped", async () => {
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-writes"]));

		await expect(guarded.put("k", "v")).rejects.toThrow(UsageGuardError);
		await expect(guarded.put("k", "v")).rejects.toThrow("kv-writes is tripped");
		expect(kv.put).not.toHaveBeenCalled();
	});

	it("passes through getWithMetadata when not tripped", async () => {
		const kv = mockKV();
		const guard = mockGuard();
		const guarded = guardKV(kv, guard);

		const result = await guarded.getWithMetadata("key");
		expect(kv.getWithMetadata).toHaveBeenCalledWith("key");
		expect(result).toEqual({ value: "v", metadata: null });
	});

	it("throws on get when kv-reads is tripped", async () => {
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-reads"]));

		await expect(guarded.get("k")).rejects.toThrow(UsageGuardError);
		await expect(guarded.getWithMetadata("k")).rejects.toThrow(UsageGuardError);
		expect(kv.get).not.toHaveBeenCalled();
	});

	it("throws on delete when kv-deletes is tripped", async () => {
		const guarded = guardKV(mockKV(), mockGuard(["kv-deletes"]));
		await expect(guarded.delete("k")).rejects.toThrow(UsageGuardError);
	});

	it("throws on list when kv-lists is tripped", async () => {
		const guarded = guardKV(mockKV(), mockGuard(["kv-lists"]));
		await expect(guarded.list()).rejects.toThrow(UsageGuardError);
	});

	it("allows reads when only writes are tripped", async () => {
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-writes"]));
		await guarded.get("key");
		expect(kv.get).toHaveBeenCalled();
	});

	it("skips silently in skip mode", async () => {
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-writes"]), { onTrip: "skip" });
		await guarded.put("k", "v");
		expect(kv.put).not.toHaveBeenCalled();
	});

	it("returns safe fallbacks in skip mode for all methods", async () => {
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-reads", "kv-writes", "kv-deletes", "kv-lists"]), {
			onTrip: "skip",
		});
		expect(await guarded.get("k")).toBeNull();
		const meta = await guarded.getWithMetadata("k");
		expect(meta).toEqual({ value: null, metadata: null });
		const list = await guarded.list();
		expect(list.keys).toEqual([]);
		expect(list.list_complete).toBe(true);
		await guarded.delete("k");
		expect(kv.delete).not.toHaveBeenCalled();
	});

	it("calls custom handler in custom mode", async () => {
		const handler = vi.fn();
		const kv = mockKV();
		const guarded = guardKV(kv, mockGuard(["kv-writes"]), { onTrip: handler });
		await guarded.put("k", "v");
		expect(handler).toHaveBeenCalledWith("kv-writes", "put");
		expect(kv.put).not.toHaveBeenCalled();
	});
});

describe("guardD1", () => {
	it("passes through reads and writes when not tripped", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard());
		await guarded.prepare("SELECT 1").first();
		expect(stmt.first).toHaveBeenCalled();
		await guarded.prepare("SELECT 1").all();
		expect(stmt.all).toHaveBeenCalled();
		await guarded.prepare("SELECT 1").raw();
		expect(stmt.raw).toHaveBeenCalled();
		await guarded.prepare("INSERT INTO t VALUES (1)").run();
		expect(stmt.run).toHaveBeenCalled();
		await guarded.batch([]);
		expect(db.batch).toHaveBeenCalled();
	});

	it("passes through first with column name when not tripped", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard());
		await guarded.prepare("SELECT id FROM t").first("id");
		expect(stmt.first).toHaveBeenCalledWith("id");
	});

	it("passes through exec when not tripped", async () => {
		const { db } = mockD1();
		const guarded = guardD1(db, mockGuard());
		await guarded.exec("CREATE TABLE t (id INTEGER)");
		expect(db.exec).toHaveBeenCalledWith("CREATE TABLE t (id INTEGER)");
	});

	it("throws on reads when d1-reads is tripped", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard(["d1-reads"]));
		await expect(guarded.prepare("SELECT 1").first()).rejects.toThrow(UsageGuardError);
		await expect(guarded.prepare("SELECT 1").all()).rejects.toThrow(UsageGuardError);
		await expect(guarded.prepare("SELECT 1").raw()).rejects.toThrow(UsageGuardError);
		await expect(guarded.dump()).rejects.toThrow(UsageGuardError);
		expect(stmt.first).not.toHaveBeenCalled();
	});

	it("throws on writes when d1-writes is tripped", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard(["d1-writes"]));
		await expect(guarded.prepare("INSERT INTO t VALUES (1)").run()).rejects.toThrow(
			UsageGuardError,
		);
		await expect(guarded.batch([])).rejects.toThrow(UsageGuardError);
		await expect(guarded.exec("DROP TABLE t")).rejects.toThrow(UsageGuardError);
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it("allows reads when only writes are tripped", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard(["d1-writes"]));
		await guarded.prepare("SELECT 1").first();
		expect(stmt.first).toHaveBeenCalled();
	});

	it("passes through dump when not tripped", async () => {
		const { db } = mockD1();
		const guarded = guardD1(db, mockGuard());
		const result = await guarded.dump();
		expect(db.dump).toHaveBeenCalled();
		expect(result).toBeInstanceOf(ArrayBuffer);
	});

	it("passes through bind and delegates to underlying statement", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard());
		const bound = guarded.prepare("SELECT ? WHERE ?").bind("a", "b");
		expect(stmt.bind).toHaveBeenCalledWith("a", "b");
		await bound.first();
		expect(stmt.first).toHaveBeenCalled();
	});

	it("preserves bind chaining", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard());
		await guarded.prepare("SELECT ?").bind(1).first();
		expect(stmt.bind).toHaveBeenCalledWith(1);
		expect(stmt.first).toHaveBeenCalled();
	});

	it("skips silently in skip mode", async () => {
		const { db, stmt } = mockD1();
		const guarded = guardD1(db, mockGuard(["d1-writes"]), { onTrip: "skip" });
		await guarded.prepare("INSERT").run();
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it("returns safe fallbacks in skip mode for all methods", async () => {
		const { db } = mockD1();
		const guarded = guardD1(db, mockGuard(["d1-reads", "d1-writes"]), { onTrip: "skip" });
		expect(await guarded.prepare("SELECT 1").first()).toBeNull();
		const all = await guarded.prepare("SELECT 1").all();
		expect(all).toEqual({ results: [], success: true, meta: {} });
		const raw = await guarded.prepare("SELECT 1").raw();
		expect(raw).toEqual([]);
		const dump = await guarded.dump();
		expect(dump.byteLength).toBe(0);
		const batch = await guarded.batch([]);
		expect(batch).toEqual([]);
		const exec = await guarded.exec("DROP TABLE t");
		expect(exec).toEqual({ count: 0, duration: 0 });
	});
});

describe("guardR2", () => {
	it("passes through when not tripped", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard());
		await guarded.get("key");
		expect(r2.get).toHaveBeenCalled();
		await guarded.head("key");
		expect(r2.head).toHaveBeenCalledWith("key");
		await guarded.list();
		expect(r2.list).toHaveBeenCalled();
		await guarded.put("key", "data");
		expect(r2.put).toHaveBeenCalled();
		await guarded.delete("key");
		expect(r2.delete).toHaveBeenCalledWith("key");
	});

	it("throws on mutations when r2-class-a is tripped", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard(["r2-class-a"]));
		await expect(guarded.put("k", "v")).rejects.toThrow(UsageGuardError);
		await expect(guarded.delete("k")).rejects.toThrow(UsageGuardError);
		await expect(guarded.createMultipartUpload("k")).rejects.toThrow(UsageGuardError);
		expect(r2.put).not.toHaveBeenCalled();
	});

	it("throws on reads when r2-class-b is tripped", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard(["r2-class-b"]));
		await expect(guarded.get("k")).rejects.toThrow(UsageGuardError);
		await expect(guarded.head("k")).rejects.toThrow(UsageGuardError);
		await expect(guarded.list()).rejects.toThrow(UsageGuardError);
		expect(r2.get).not.toHaveBeenCalled();
	});

	it("allows reads when only class-a is tripped", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard(["r2-class-a"]));
		await guarded.get("key");
		expect(r2.get).toHaveBeenCalled();
	});

	it("passes through createMultipartUpload when not tripped", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard());
		await guarded.createMultipartUpload("key");
		expect(r2.createMultipartUpload).toHaveBeenCalledWith("key", undefined);
	});

	it("returns safe fallbacks in skip mode for all methods", async () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard(["r2-class-a", "r2-class-b"]), { onTrip: "skip" });
		expect(await guarded.get("k")).toBeNull();
		expect(await guarded.head("k")).toBeNull();
		expect((await guarded.list()).objects).toEqual([]);
		expect(await guarded.put("k", "v")).toBeNull();
		await guarded.delete("k");
		expect(r2.delete).not.toHaveBeenCalled();
		expect(await guarded.createMultipartUpload("k")).toBeNull();
		expect(r2.createMultipartUpload).not.toHaveBeenCalled();
	});

	it("passes resumeMultipartUpload through without checking", () => {
		const r2 = mockR2();
		const guarded = guardR2(r2, mockGuard(["r2-class-a"]));
		guarded.resumeMultipartUpload("key", "upload-id");
		expect(r2.resumeMultipartUpload).toHaveBeenCalledWith("key", "upload-id");
	});
});

describe("guardQueue", () => {
	it("passes through when not tripped", async () => {
		const queue = mockQueue();
		const guarded = guardQueue(queue, mockGuard());
		await guarded.send("msg");
		expect(queue.send).toHaveBeenCalledWith("msg", undefined);
	});

	it("throws on send when queue-operations is tripped", async () => {
		const queue = mockQueue();
		const guarded = guardQueue(queue, mockGuard(["queue-operations"]));
		await expect(guarded.send("msg")).rejects.toThrow(UsageGuardError);
		await expect(guarded.sendBatch([])).rejects.toThrow(UsageGuardError);
		expect(queue.send).not.toHaveBeenCalled();
	});

	it("passes through sendBatch when not tripped", async () => {
		const queue = mockQueue();
		const guarded = guardQueue(queue, mockGuard());
		await guarded.sendBatch([]);
		expect(queue.sendBatch).toHaveBeenCalledWith([], undefined);
	});

	it("skips silently in skip mode for send and sendBatch", async () => {
		const queue = mockQueue();
		const guarded = guardQueue(queue, mockGuard(["queue-operations"]), { onTrip: "skip" });
		await guarded.send("msg");
		expect(queue.send).not.toHaveBeenCalled();
		await guarded.sendBatch([]);
		expect(queue.sendBatch).not.toHaveBeenCalled();
	});
});

describe("guardAI", () => {
	it("passes through when not tripped", async () => {
		const ai = mockAi();
		const guarded = guardAI(ai, mockGuard());
		await guarded.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {});
		expect(ai.run).toHaveBeenCalled();
	});

	it("throws on run when ai-neurons is tripped", async () => {
		const ai = mockAi();
		const guarded = guardAI(ai, mockGuard(["ai-neurons"]));
		await expect(
			guarded.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {}),
		).rejects.toThrow(UsageGuardError);
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("skips silently in skip mode", async () => {
		const ai = mockAi();
		const guarded = guardAI(ai, mockGuard(["ai-neurons"]), { onTrip: "skip" });
		const result = await guarded.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {});
		expect(result).toBeNull();
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("calls custom handler in custom mode", async () => {
		const handler = vi.fn();
		const ai = mockAi();
		const guarded = guardAI(ai, mockGuard(["ai-neurons"]), { onTrip: handler });
		await guarded.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {});
		expect(handler).toHaveBeenCalledWith("ai-neurons", "run");
		expect(ai.run).not.toHaveBeenCalled();
	});
});

function mockVectorize() {
	return {
		query: vi.fn(async () => ({ count: 1, matches: [{ id: "v1", score: 0.9 }] })),
		insert: vi.fn(async () => ({ ids: ["v1"], count: 1 })),
		upsert: vi.fn(async () => ({ ids: ["v1"], count: 1 })),
		deleteByIds: vi.fn(async () => ({ ids: ["v1"], count: 1 })),
		getByIds: vi.fn(async () => [{ id: "v1", values: [1, 2, 3] }]),
		describe: vi.fn(async () => ({ dimensions: 3 })),
	} as unknown as VectorizeIndex;
}

describe("guardVectorize", () => {
	it("passes through query when not tripped", async () => {
		const index = mockVectorize();
		const guarded = guardVectorize(index, mockGuard());
		await guarded.query([1, 2, 3], { topK: 5 } as VectorizeQueryOptions);
		expect(index.query).toHaveBeenCalledWith([1, 2, 3], { topK: 5 });
	});

	it("throws on query when vectorize-queries is tripped", async () => {
		const index = mockVectorize();
		const guarded = guardVectorize(index, mockGuard(["vectorize-queries"]));
		await expect(guarded.query([1, 2, 3], { topK: 5 } as VectorizeQueryOptions)).rejects.toThrow(
			UsageGuardError,
		);
		expect(index.query).not.toHaveBeenCalled();
	});

	it("passes through mutations even when tripped", async () => {
		const index = mockVectorize();
		const guarded = guardVectorize(index, mockGuard(["vectorize-queries"]));
		await guarded.insert([]);
		expect(index.insert).toHaveBeenCalled();
		await guarded.upsert([]);
		expect(index.upsert).toHaveBeenCalled();
		await guarded.deleteByIds(["v1"]);
		expect(index.deleteByIds).toHaveBeenCalled();
		await guarded.getByIds(["v1"]);
		expect(index.getByIds).toHaveBeenCalled();
		await guarded.describe();
		expect(index.describe).toHaveBeenCalled();
	});

	it("skips silently in skip mode", async () => {
		const index = mockVectorize();
		const guarded = guardVectorize(index, mockGuard(["vectorize-queries"]), { onTrip: "skip" });
		const result = await guarded.query([1, 2, 3], { topK: 5 } as VectorizeQueryOptions);
		expect(result).toEqual({ count: 0, matches: [] });
		expect(index.query).not.toHaveBeenCalled();
	});

	it("calls custom handler in custom mode", async () => {
		const handler = vi.fn();
		const index = mockVectorize();
		const guarded = guardVectorize(index, mockGuard(["vectorize-queries"]), { onTrip: handler });
		await guarded.query([1, 2, 3], { topK: 5 } as VectorizeQueryOptions);
		expect(handler).toHaveBeenCalledWith("vectorize-queries", "query");
		expect(index.query).not.toHaveBeenCalled();
	});
});

describe("UsageGuardError", () => {
	it("has correct properties", () => {
		const err = new UsageGuardError("kv-writes", "put");
		expect(err.name).toBe("UsageGuardError");
		expect(err.resource).toBe("kv-writes");
		expect(err.method).toBe("put");
		expect(err.message).toContain("kv-writes");
		expect(err.message).toContain("put");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(UsageGuardError);
	});
});

describe("guardEnv", () => {
	it("auto-detects and wraps KV, D1, R2, Queue, AI, Vectorize bindings", async () => {
		const env = {
			MY_KV: mockKV(),
			MY_DB: mockD1().db,
			MY_BUCKET: mockR2(),
			MY_QUEUE: mockQueue(),
			MY_AI: mockAi(),
			MY_INDEX: mockVectorize(),
			PLAIN_STRING: "not-a-binding",
			PLAIN_NUMBER: 42,
		};
		const guard = mockGuard([
			"kv-writes",
			"d1-writes",
			"r2-class-a",
			"queue-operations",
			"ai-neurons",
			"vectorize-queries",
		]);
		const guarded = guardEnv(env, guard);

		await expect(guarded.MY_KV.put("k", "v")).rejects.toThrow(UsageGuardError);
		await expect(guarded.MY_DB.prepare("INSERT").run()).rejects.toThrow(UsageGuardError);
		await expect(guarded.MY_BUCKET.put("k", "v")).rejects.toThrow(UsageGuardError);
		await expect(guarded.MY_QUEUE.send("msg")).rejects.toThrow(UsageGuardError);
		await expect(
			guarded.MY_AI.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {}),
		).rejects.toThrow(UsageGuardError);
		await expect(
			guarded.MY_INDEX.query([1, 2, 3], { topK: 5 } as VectorizeQueryOptions),
		).rejects.toThrow(UsageGuardError);

		expect(guarded.PLAIN_STRING).toBe("not-a-binding");
		expect(guarded.PLAIN_NUMBER).toBe(42);
	});

	it("excludes specified bindings", async () => {
		const kv = mockKV();
		const env = { GUARD_KV: kv, APP_KV: mockKV() };
		const guard = mockGuard(["kv-writes"]);
		const guarded = guardEnv(env, guard, { exclude: ["GUARD_KV"] });

		await guarded.GUARD_KV.put("k", "v");
		expect(kv.put).toHaveBeenCalled();

		await expect(guarded.APP_KV.put("k", "v")).rejects.toThrow(UsageGuardError);
	});

	it("passes onTrip option to all wrapped bindings", async () => {
		const env = { MY_KV: mockKV(), MY_DB: mockD1().db };
		const guard = mockGuard(["kv-writes", "d1-writes"]);
		const guarded = guardEnv(env, guard, { onTrip: "skip" });

		await guarded.MY_KV.put("k", "v");
		expect(env.MY_KV.put).not.toHaveBeenCalled();

		await guarded.MY_DB.prepare("INSERT").run();
	});

	it("preserves env type", () => {
		const env = { MY_KV: mockKV(), SECRET: "abc" };
		const guarded = guardEnv(env, mockGuard());
		expect(guarded.SECRET).toBe("abc");
	});

	it("auto-detects Queue binding via duck-typing", async () => {
		const queue = mockQueue();
		const env = { MY_QUEUE: queue };
		const guard = mockGuard(["queue-operations"]);
		const guarded = guardEnv(env, guard);

		await expect(guarded.MY_QUEUE.send("msg")).rejects.toThrow(UsageGuardError);
		expect(queue.send).not.toHaveBeenCalled();
	});

	it("auto-detects AI binding via duck-typing", async () => {
		const ai = mockAi();
		const env = { MY_AI: ai };
		const guard = mockGuard(["ai-neurons"]);
		const guarded = guardEnv(env, guard);

		await expect(
			guarded.MY_AI.run("@cf/meta/llama-3-8b" as Parameters<Ai["run"]>[0], {}),
		).rejects.toThrow(UsageGuardError);
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("passes through unrecognized object bindings unchanged", () => {
		const unknownBinding = { foo: () => {}, bar: () => {} };
		const env = { UNKNOWN: unknownBinding };
		const guarded = guardEnv(env, mockGuard());
		expect(guarded.UNKNOWN).toBe(unknownBinding);
	});

	it("auto-excludes the guard's own KV by reference", async () => {
		const guardKvInstance = mockKV();
		const appKv = mockKV();
		const guard = {
			...mockGuard(["kv-writes"]),
			kv: guardKvInstance as unknown as KVNamespace,
		};
		const env = { GUARD_KV: guardKvInstance, APP_KV: appKv };
		const guarded = guardEnv(env, guard as unknown as UsageGuard);

		await guarded.GUARD_KV.put("k", "v");
		expect(guardKvInstance.put).toHaveBeenCalled();

		await expect(guarded.APP_KV.put("k", "v")).rejects.toThrow(UsageGuardError);
	});
});
