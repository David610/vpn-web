type PlanSubscription = { id: string; status: string; used: number; capacity: number };

/** Client names are capped at 40 characters by the server. */
export function firstClientName(linkName: string): string {
  return linkName.slice(0, 40);
}

/** The subscription a new Link's first client should use: live, with a free device place. */
export function subscriptionForFirstClient<T extends PlanSubscription>(subscriptions: T[]): T | null {
  return subscriptions.find((s) => s.status !== "canceled" && s.used < s.capacity) ?? null;
}
