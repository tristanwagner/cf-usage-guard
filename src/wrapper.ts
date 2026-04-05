import { createUsageGuard } from "./guard";
import type { UsageGuard, WrapperConfig } from "./types";

type ScheduledHandler<E> = (
	controller: ScheduledController,
	env: E,
	ctx: ExecutionContext,
) => void | Promise<void>;

type FetchHandler<E> = (
	request: Request,
	env: E,
	ctx: ExecutionContext,
) => Response | Promise<Response>;

interface WorkerHandlers<E> {
	fetch?: FetchHandler<E>;
	scheduled?: ScheduledHandler<E>;
	[key: string]: unknown;
}

export function withUsageGuard<E>(
	wrapperConfig: WrapperConfig<E>,
	handlers: WorkerHandlers<E>,
): ExportedHandler<E> {
	let guard: UsageGuard | null = null;

	const getGuard = (env: E): UsageGuard => {
		if (!guard) {
			guard = createUsageGuard({
				kv: wrapperConfig.kv(env),
				accountId: wrapperConfig.accountId(env),
				apiToken: wrapperConfig.apiToken(env),
				billingDay: wrapperConfig.billingDay,
				thresholds: wrapperConfig.thresholds,
				alerts: wrapperConfig.alerts?.(env),
				logger: wrapperConfig.logger?.(env),
				keyPrefix: wrapperConfig.keyPrefix,
				alertTimeout: wrapperConfig.alertTimeout,
				onEvaluate: wrapperConfig.onEvaluate,
			});
		}
		return guard;
	};

	const result: ExportedHandler<E> = {};

	if (handlers.fetch) {
		const originalFetch = handlers.fetch;
		result.fetch = (request: Request, env: E, ctx: ExecutionContext) => {
			return originalFetch(request, env, ctx);
		};
	}

	if (handlers.scheduled) {
		const originalScheduled = handlers.scheduled;
		result.scheduled = async (
			controller: ScheduledController,
			env: E,
			ctx: ExecutionContext,
		): Promise<void> => {
			const g = getGuard(env);

			if (controller.cron === wrapperConfig.evaluateCron) {
				ctx.waitUntil(g.evaluate());
				return;
			}

			if (await g.isTripped()) return;

			await originalScheduled(controller, env, ctx);
		};
	}

	for (const [key, value] of Object.entries(handlers)) {
		if (key !== "fetch" && key !== "scheduled" && typeof value === "function") {
			(result as Record<string, unknown>)[key] = value;
		}
	}

	return result;
}
