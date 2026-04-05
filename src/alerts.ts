import { getDailyPeriod, getWeeklyPeriod } from "./query";
import {
	ALERT_CHANNEL_TYPES,
	ALERT_LEVELS,
	type AlertChannel,
	type AlertEvent,
	type Granularity,
	type ResolvedConfig,
	type ResourceStatus,
} from "./types";

export async function sendAlerts(
	event: AlertEvent,
	config: ResolvedConfig,
	now: Date,
): Promise<void> {
	if (config.alerts.length === 0) return;

	if (event.level !== ALERT_LEVELS.RECOVER) {
		const isDuplicate = await checkDedup(event, config, now);
		if (isDuplicate) {
			config.logger.debug("Alert deduplicated", { level: event.level });
			return;
		}
	}

	const results = await Promise.allSettled(
		config.alerts.map((channel) => dispatchAlert(channel, event, config)),
	);

	let anySucceeded = false;
	for (const result of results) {
		if (result.status === "rejected") {
			config.logger.error("Alert channel failed", {
				error: String(result.reason),
			});
		} else {
			anySucceeded = true;
		}
	}

	if (event.level !== ALERT_LEVELS.RECOVER && anySucceeded) {
		await writeDedup(event, config, now);
	}
}

async function checkDedup(event: AlertEvent, config: ResolvedConfig, now: Date): Promise<boolean> {
	const key = dedupKey(event, config, now);
	try {
		const existing = await config.kv.get(key);
		return existing !== null;
	} catch {
		config.logger.warn("KV read failed for alert dedup check", { key });
		return false;
	}
}

async function writeDedup(event: AlertEvent, config: ResolvedConfig, now: Date): Promise<void> {
	const key = dedupKey(event, config, now);
	const ttl = dedupTtl(event, config, now);
	try {
		await config.kv.put(key, now.toISOString(), {
			expirationTtl: Math.max(60, ttl),
		});
	} catch {
		config.logger.warn("KV write failed for alert dedup marker", { key });
	}
}

function resourceGranularity(event: AlertEvent, config: ResolvedConfig): Granularity {
	const resourceName = event.resources[0]?.name;
	if (!resourceName) return "monthly";
	return config.thresholds[resourceName]?.granularity ?? "monthly";
}

function dedupPeriodKey(granularity: Granularity, event: AlertEvent, now: Date): string {
	if (granularity === "daily") {
		return getDailyPeriod(now).start;
	}
	if (granularity === "weekly") {
		return getWeeklyPeriod(now).start;
	}
	return event.billingPeriod.start.slice(0, 7);
}

function dedupTtl(event: AlertEvent, config: ResolvedConfig, now: Date): number {
	if (event.level === ALERT_LEVELS.TRIP) {
		return billingPeriodRemainderSeconds(config.billingDay, now);
	}
	const granularity = resourceGranularity(event, config);
	if (granularity === "daily") return 48 * 3600;
	if (granularity === "weekly") return 8 * 86400;
	return billingPeriodRemainderSeconds(config.billingDay, now);
}

function dedupKey(event: AlertEvent, config: ResolvedConfig, now: Date): string {
	if (event.level === ALERT_LEVELS.TRIP) {
		const period = event.billingPeriod.start.slice(0, 7);
		return `${config.keyPrefix}alert:${ALERT_LEVELS.TRIP}:global:${period}`;
	}
	const granularity = resourceGranularity(event, config);
	const period = dedupPeriodKey(granularity, event, now);
	const resourceName = event.resources[0]?.name ?? "unknown";
	return `${config.keyPrefix}alert:${event.level}:${resourceName}:${period}`;
}

async function dispatchAlert(
	channel: AlertChannel,
	event: AlertEvent,
	config: ResolvedConfig,
): Promise<void> {
	if (channel.type === ALERT_CHANNEL_TYPES.DISCORD) {
		await sendDiscord(channel.url, event);
	} else if (channel.type === ALERT_CHANNEL_TYPES.SLACK) {
		await sendSlack(channel.url, event);
	} else {
		await withTimeout(channel.handler(event), config.alertTimeout);
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`Alert handler timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function sendDiscord(url: string, event: AlertEvent): Promise<void> {
	const color =
		event.level === ALERT_LEVELS.TRIP
			? 0xff0000
			: event.level === ALERT_LEVELS.WARN
				? 0xffa500
				: 0x00ff00;
	const title = `[cf-usage-guard] ${titleForLevel(event.level)}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			embeds: [
				{
					title,
					description: formatResourceLines(event.resources),
					color,
					fields: [
						{
							name: "Billing Period",
							value: `${event.billingPeriod.start} - ${event.billingPeriod.end}`,
							inline: true,
						},
						{
							name: "Account",
							value: maskAccountId(event.accountId),
							inline: true,
						},
					],
					timestamp: event.timestamp,
				},
			],
		}),
	});

	if (!response.ok) {
		throw new Error(`Discord webhook returned ${response.status}`);
	}
}

async function sendSlack(url: string, event: AlertEvent): Promise<void> {
	const emoji =
		event.level === ALERT_LEVELS.TRIP
			? ":red_circle:"
			: event.level === ALERT_LEVELS.WARN
				? ":warning:"
				: ":white_check_mark:";
	const title = `${emoji} ${titleForLevel(event.level)}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `[cf-usage-guard] ${titleForLevel(event.level)}`,
					},
				},
				{
					type: "section",
					text: { type: "mrkdwn", text: formatResourceLines(event.resources) },
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `${title} | Billing: ${event.billingPeriod.start} - ${event.billingPeriod.end} | Account: ${maskAccountId(event.accountId)}`,
						},
					],
				},
			],
		}),
	});

	if (!response.ok) {
		throw new Error(`Slack webhook returned ${response.status}`);
	}
}

function titleForLevel(level: AlertEvent["level"]): string {
	if (level === ALERT_LEVELS.TRIP) return "Guard Tripped";
	if (level === ALERT_LEVELS.WARN) return "Usage Warning";
	return "Usage Recovered";
}

export function formatResourceLines(resources: ResourceStatus[]): string {
	return resources
		.map((r) => {
			const bar = progressBar(r.percent);
			const currentStr = formatNumber(r.current);
			const limitStr = formatNumber(r.limit);
			const displayPercent = Math.round(r.percent * 10) / 10;
			return `${r.name}  ${bar} ${displayPercent.toFixed(1)}% (${currentStr} / ${limitStr}) -- $${r.overageCost}/M overage`;
		})
		.join("\n");
}

function progressBar(percent: number): string {
	const filled = Math.round(Math.min(percent, 100) / 10);
	return "=".repeat(filled) + "-".repeat(10 - filled);
}

function formatNumber(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function maskAccountId(id: string): string {
	if (id.length <= 4) return "****";
	return `****${id.slice(-4)}`;
}

export function billingPeriodRemainderSeconds(billingDay: number, now: Date): number {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const today = now.getUTCDate();

	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const clampedDay = Math.min(billingDay, daysInMonth);

	let endDate: Date;
	if (today >= clampedDay) {
		const nextMonth = month === 11 ? 0 : month + 1;
		const nextYear = month === 11 ? year + 1 : year;
		const nextDaysInMonth = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
		const nextClamped = Math.min(billingDay, nextDaysInMonth);
		endDate = new Date(Date.UTC(nextYear, nextMonth, nextClamped));
	} else {
		endDate = new Date(Date.UTC(year, month, clampedDay));
	}

	return Math.max(60, Math.floor((endDate.getTime() - now.getTime()) / 1000));
}
