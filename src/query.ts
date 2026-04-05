import {
	RESOURCES,
	type ResolvedConfig,
	type ResourceName,
	type ResourceStatus,
	type UsageData,
} from "./types";

const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const USAGE_QUERY = `
query UsageCheck($accountTag: String!, $since: Date!, $until: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { requests cpuTimeUs }
      }
      kvOperationsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 10
      ) {
        dimensions { actionType }
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { readQueries writeQueries }
      }
      r2OperationsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 10
      ) {
        dimensions { actionType }
        sum { requests }
      }
      queueMessageOperationsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { billableOperations }
      }
      durableObjectsInvocationsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { requests wallTime }
      }
      aiInferenceAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { totalNeurons }
      }
      vectorizeV2QueriesAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { queriedVectorDimensions }
      }
      pagesFunctionsInvocationsAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { requests }
      }
      streamMinutesViewedAdaptiveGroups(
        filter: { date_geq: $since, date_leq: $until }
        limit: 1
      ) {
        sum { minutesViewed }
      }
    }
  }
}`;

const R2_CLASS_B_ACTIONS = new Set([
	"GetObject",
	"HeadObject",
	"ListObjects",
	"ListBuckets",
	"ListMultipartUploads",
	"ListParts",
]);

interface AccountData {
	workersInvocationsAdaptive?: Array<{
		sum?: { requests?: number; cpuTimeUs?: number };
	}>;
	kvOperationsAdaptiveGroups?: Array<{
		dimensions?: { actionType?: string };
		sum?: { requests?: number };
	}>;
	d1AnalyticsAdaptiveGroups?: Array<{
		sum?: { readQueries?: number; writeQueries?: number };
	}>;
	r2OperationsAdaptiveGroups?: Array<{
		dimensions?: { actionType?: string };
		sum?: { requests?: number };
	}>;
	queueMessageOperationsAdaptiveGroups?: Array<{
		sum?: { billableOperations?: number };
	}>;
	durableObjectsInvocationsAdaptiveGroups?: Array<{
		sum?: { requests?: number; wallTime?: number };
	}>;
	aiInferenceAdaptiveGroups?: Array<{
		sum?: { totalNeurons?: number };
	}>;
	vectorizeV2QueriesAdaptiveGroups?: Array<{
		sum?: { queriedVectorDimensions?: number };
	}>;
	pagesFunctionsInvocationsAdaptiveGroups?: Array<{
		sum?: { requests?: number };
	}>;
	streamMinutesViewedAdaptiveGroups?: Array<{
		sum?: { minutesViewed?: number };
	}>;
}

interface GraphQLResponse {
	data?: {
		viewer?: {
			accounts?: AccountData[];
		};
	};
	errors?: Array<{ message: string }>;
}

export function getBillingPeriod(billingDay: number, now: Date): { start: string; end: string } {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const today = now.getUTCDate();

	const clampedDay = clampBillingDay(billingDay, year, month);

	let startDate: Date;
	if (today >= clampedDay) {
		startDate = new Date(Date.UTC(year, month, clampedDay));
	} else {
		const prevMonth = month === 0 ? 11 : month - 1;
		const prevYear = month === 0 ? year - 1 : year;
		const prevClamped = clampBillingDay(billingDay, prevYear, prevMonth);
		startDate = new Date(Date.UTC(prevYear, prevMonth, prevClamped));
	}

	return {
		start: formatDate(startDate),
		end: formatDate(now),
	};
}

export function getBillingPeriodEnd(billingDay: number, now: Date): Date {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const today = now.getUTCDate();

	const clampedDay = clampBillingDay(billingDay, year, month);

	if (today >= clampedDay) {
		const nextMonth = month === 11 ? 0 : month + 1;
		const nextYear = month === 11 ? year + 1 : year;
		const nextClamped = clampBillingDay(billingDay, nextYear, nextMonth);
		return new Date(Date.UTC(nextYear, nextMonth, nextClamped));
	}

	return new Date(Date.UTC(year, month, clampedDay));
}

function clampBillingDay(day: number, year: number, month: number): number {
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return Math.min(day, daysInMonth);
}

function formatDate(d: Date): string {
	return d.toISOString().split("T")[0];
}

export async function fetchUsage(config: ResolvedConfig, now: Date): Promise<UsageData> {
	const period = getBillingPeriod(config.billingDay, now);

	const response = await fetch(CF_GRAPHQL_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query: USAGE_QUERY,
			variables: {
				accountTag: config.accountId,
				since: period.start,
				until: period.end,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(`CF GraphQL API returned ${response.status}: ${response.statusText}`);
	}

	const json = (await response.json()) as GraphQLResponse;

	if (json.errors?.length) {
		throw new Error(`CF GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
	}

	const account = json.data?.viewer?.accounts?.[0];
	if (!account) {
		throw new Error("No account data returned from CF GraphQL API");
	}

	const resources = parseResources(account, config);

	return { resources, fetchedAt: now.toISOString() };
}

function parseResources(account: AccountData, config: ResolvedConfig): ResourceStatus[] {
	const raw = new Map<ResourceName, number>();

	const workers = account.workersInvocationsAdaptive?.[0]?.sum;
	raw.set(RESOURCES.WORKERS_REQUESTS, workers?.requests ?? 0);
	raw.set(RESOURCES.WORKERS_CPU, workers?.cpuTimeUs ?? 0);

	let kvReads = 0;
	let kvWrites = 0;
	let kvDeletes = 0;
	let kvLists = 0;
	for (const group of account.kvOperationsAdaptiveGroups ?? []) {
		const action = group.dimensions?.actionType;
		const count = group.sum?.requests ?? 0;
		if (action === "read") kvReads += count;
		else if (action === "write") kvWrites += count;
		else if (action === "delete") kvDeletes += count;
		else if (action === "list") kvLists += count;
	}
	raw.set(RESOURCES.KV_READS, kvReads);
	raw.set(RESOURCES.KV_WRITES, kvWrites);
	raw.set(RESOURCES.KV_DELETES, kvDeletes);
	raw.set(RESOURCES.KV_LISTS, kvLists);

	const d1 = account.d1AnalyticsAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.D1_READS, d1?.readQueries ?? 0);
	raw.set(RESOURCES.D1_WRITES, d1?.writeQueries ?? 0);

	let r2ClassA = 0;
	let r2ClassB = 0;
	for (const group of account.r2OperationsAdaptiveGroups ?? []) {
		const action = group.dimensions?.actionType ?? "";
		const count = group.sum?.requests ?? 0;
		if (R2_CLASS_B_ACTIONS.has(action)) {
			r2ClassB += count;
		} else {
			r2ClassA += count;
		}
	}
	raw.set(RESOURCES.R2_CLASS_A, r2ClassA);
	raw.set(RESOURCES.R2_CLASS_B, r2ClassB);

	const queues = account.queueMessageOperationsAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.QUEUE_OPERATIONS, queues?.billableOperations ?? 0);

	const doInv = account.durableObjectsInvocationsAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.DO_REQUESTS, doInv?.requests ?? 0);
	raw.set(RESOURCES.DO_WALL_TIME, doInv?.wallTime ?? 0);

	const ai = account.aiInferenceAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.AI_NEURONS, ai?.totalNeurons ?? 0);

	const vectorize = account.vectorizeV2QueriesAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.VECTORIZE_QUERIES, vectorize?.queriedVectorDimensions ?? 0);

	const pages = account.pagesFunctionsInvocationsAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.PAGES_REQUESTS, pages?.requests ?? 0);

	const stream = account.streamMinutesViewedAdaptiveGroups?.[0]?.sum;
	raw.set(RESOURCES.STREAM_MINUTES, stream?.minutesViewed ?? 0);

	const results: ResourceStatus[] = [];
	for (const [name, current] of raw) {
		const threshold = config.thresholds[name];
		const limit = threshold.limit;
		const percent = limit > 0 ? (current / limit) * 100 : 0;
		const overAmount = Math.max(0, current - limit);
		const estimatedOverage = (overAmount / 1_000_000) * threshold.overageCost;

		results.push({
			name,
			current,
			limit,
			percent,
			overageCost: threshold.overageCost,
			estimatedOverage: Math.round(estimatedOverage * 100) / 100,
		});
	}

	return results;
}
