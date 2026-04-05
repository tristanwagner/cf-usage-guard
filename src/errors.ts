import type { ResourceName } from "./types";

export class UsageGuardError extends Error {
	readonly resource: ResourceName;
	readonly method: string;

	constructor(resource: ResourceName, method: string) {
		super(`[cf-usage-guard] ${resource} is tripped -- blocked ${method}()`);
		this.name = "UsageGuardError";
		this.resource = resource;
		this.method = method;
	}
}
