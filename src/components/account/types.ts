export type Subscription = {
  id: string;
  name: string;
  status: string;
  stripeStatus: string;
  extraPacks: number;
  capacity: number;
  used: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type Device = {
  id: string;
  name: string;
  platform: string;
  status: string;
  subscriptionId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
  placement: { status: string; error: string | null } | null;
};

export type Overview = {
  email: string;
  role: string;
  trialAvailable: boolean;
  billingAccount: boolean;
  subscriptions: Subscription[];
  devices: Device[];
  capacity: { total: number; used: number };
  plan: {
    includedDevices: number;
    devicesPerPack: number;
    basePriceCents: number;
    packPriceCents: number;
    maxExtraPacks: number;
  };
};

export const LIVE = new Set(["trialing", "active", "past_due", "cancelling"]);

export function monthlyCents(plan: Overview["plan"], packs: number) {
  return plan.basePriceCents + plan.packPriceCents * packs;
}

export function statusLabel(sub: Subscription) {
  switch (sub.status) {
    case "active":
      return "Active";
    case "trialing":
      return "Free trial";
    case "past_due":
      return "Payment problem";
    case "cancelling":
      return "Ends at period end";
    case "canceled":
      return "Cancelled";
    case "unpaid":
      return "Unpaid";
    default:
      return sub.status;
  }
}
