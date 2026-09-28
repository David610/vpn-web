// Defensive accessors for Stripe object fields that have moved between API
// versions. Stripe's own SDK types confirm both of these moves as of API
// version 2025-03-31.basil (installed SDK pins a later version, so both
// moves are in effect): Subscription.current_period_end now lives per-item
// under items.data[0]; Invoice.subscription now lives under
// parent.subscription_details.subscription. Both helpers check the new
// location first and fall back to the pre-basil top-level field, so this
// code works whether or not the connected Stripe account's webhook API
// version predates the move. Every place this codebase reads one of these
// fields MUST go through these helpers, not inline field access — that
// inline-access pattern is exactly what broke the previous draft of this
// handler (it silently nulled every renewal's expiry once tested against a
// real, current-API-version payload).

import { SEAT_PACK_SIZE } from "./seat-constants.js";

/**
 * @param {object} subscription - a Stripe Subscription object
 * @returns {number | null} unix seconds, or null if genuinely absent
 */
export function getSubscriptionPeriodEnd(subscription) {
  const fromItem = subscription.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  if (typeof subscription.current_period_end === "number") {
    return subscription.current_period_end;
  }
  return null;
}

/**
 * @param {object} invoice - a Stripe Invoice object
 * @returns {string | null} the subscription id, or null if this invoice
 *   isn't associated with a subscription (e.g. a one-off invoice)
 */
export function getInvoiceSubscriptionId(invoice) {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (fromParent) {
    return typeof fromParent === "string" ? fromParent : fromParent.id;
  }
  if (invoice.subscription) {
    return typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription.id;
  }
  return null;
}

/**
 * The device-pack line item on a subscription, if one has been added
 * (legacy "seat" naming: STRIPE_SEAT_PRICE_ID is the +3-device pack price).
 *
 * A subscription carries the flat base price (which includes the first
 * INCLUDED_SEATS = 3 devices) and, once the owner buys extra capacity, a
 * second licensed item priced per pack of SEAT_PACK_SIZE devices — its
 * quantity is the number of extra packs, not the number of extra devices. Matching on the configured
 * price id rather than on position is what keeps this from mistaking the
 * base item for the device-pack item when Stripe reorders them.
 *
 * @param {object} subscription - a Stripe Subscription object
 * @param {string | undefined} seatPriceId - env.STRIPE_SEAT_PRICE_ID
 * @returns {object | null} the subscription item, or null if no device packs
 */
export function getSeatSubscriptionItem(subscription, seatPriceId) {
  if (!seatPriceId) return null;
  const items = subscription.items?.data;
  if (!Array.isArray(items)) return null;
  return (
    items.find((item) => {
      const priceId = typeof item.price === "string" ? item.price : item.price?.id;
      return priceId === seatPriceId;
    }) ?? null
  );
}

/**
 * The base (non-pack) item's price id — the item Checkout put the customer
 * on, as opposed to the +3-device pack item matched by seatPriceId.
 *
 * F-31/C-04: this is the id validated against an allowlist before a
 * subscription is trusted to grant entitlement. A subscription normally
 * carries exactly one non-pack item; if Stripe ever reports more than one
 * (a manual dashboard edit, a plan migration), the first is used — the same
 * "match by price id, not position" reasoning as getSeatSubscriptionItem
 * applies here too, just inverted (this wants the one item that ISN'T the
 * pack).
 *
 * @param {object} subscription - a Stripe Subscription object
 * @param {string | undefined} seatPriceId - env.STRIPE_SEAT_PRICE_ID
 * @returns {string | null}
 */
export function getBaseSubscriptionPriceId(subscription, seatPriceId) {
  const items = subscription.items?.data;
  if (!Array.isArray(items) || items.length === 0) return null;
  const base = items.find((item) => {
    const priceId = typeof item.price === "string" ? item.price : item.price?.id;
    return priceId !== seatPriceId;
  });
  if (!base) return null;
  return typeof base.price === "string" ? base.price : base.price?.id ?? null;
}

/**
 * F-31/C-04: is this price id one this deployment actually sells as a base
 * subscription? STRIPE_PRICE_ID is the current price; STRIPE_PRICE_ID_LEGACY
 * (optional, comma-separated) lets a price that was retired still be
 * honored for customers already on it, without silently accepting an
 * arbitrary price a compromised or fat-fingered dashboard edit switched a
 * subscription to.
 *
 * @param {string | null} priceId
 * @param {{ STRIPE_PRICE_ID?: string, STRIPE_PRICE_ID_LEGACY?: string }} env
 * @returns {boolean}
 */
export function isAllowedBasePrice(priceId, env) {
  if (!priceId) return false;
  const allowlist = [env.STRIPE_PRICE_ID, ...(env.STRIPE_PRICE_ID_LEGACY?.split(",") ?? [])]
    .map((id) => id?.trim())
    .filter(Boolean);
  return allowlist.includes(priceId);
}

/**
 * How many +3-device packs a subscription is paying for. Absent a pack
 * item — the common case — that is zero, not unknown.
 *
 * @returns {number}
 */
export function getSeatPackQuantity(subscription, seatPriceId) {
  const item = getSeatSubscriptionItem(subscription, seatPriceId);
  const quantity = item?.quantity;
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

/**
 * How many devices beyond the included ones a subscription is paying for —
 * the pack item's quantity converted from packs to devices. Absent a
 * pack item that is zero, not unknown.
 *
 * @returns {number}
 */
export function getExtraSeatCount(subscription, seatPriceId) {
  return getSeatPackQuantity(subscription, seatPriceId) * SEAT_PACK_SIZE;
}

/**
 * @param {object} invoice - a Stripe Invoice object
 * @returns {number | null} unix seconds of the paid service period's end,
 *   from the most specific source available
 *
 * F-19: this used to read only invoice.lines.data[0].period.end. Stripe does
 * not guarantee line order, and a combined invoice (proration + renewal, the
 * common case for a mid-cycle pack purchase or an upgrade) can put the
 * proration line first — that line's period ends at the OLD period end, so
 * reading position [0] could silently set node expiry to a date in the past
 * relative to the real new period. Taking the max across every line with a
 * numeric period.end is order-independent and always resolves to the
 * furthest-out (i.e. correct, newest) period end on the invoice.
 */
export function getInvoiceLinePeriodEnd(invoice) {
  const lines = invoice.lines?.data;
  if (Array.isArray(lines) && lines.length > 0) {
    const ends = lines
      .map((line) => line?.period?.end)
      .filter((end) => typeof end === "number");
    if (ends.length > 0) return Math.max(...ends);
  }
  if (typeof invoice.period_end === "number") return invoice.period_end;
  return null;
}

/**
 * F-19/C-04: legacy (pre-managed-client) node expiry is not the exact
 * `current_period_end` — singbox-vpn enforces service as `now < expires_at`
 * with no grace of its own, so a webhook delayed even a few minutes past the
 * boundary (Stripe's renewal invoices finalize roughly an hour after the new
 * period starts) drops the customer's connection until the next successful
 * sync. This grace absorbs that normal webhook-processing lag; it is added
 * only to the node-facing expiry (entitlement.serviceExpiresAt), never to
 * the raw Stripe period end shown to the customer or stored for billing
 * logic (entitlement.currentPeriodEnd / subscriptions.current_period_end).
 */
export const LEGACY_NODE_EXPIRY_GRACE_MS = 72 * 60 * 60 * 1000;

/**
 * @param {string | null} iso
 * @returns {string | null} `iso` plus the legacy grace window, or `iso`
 *   unchanged (including null) if it isn't a valid timestamp to extend
 */
export function applyLegacyExpiryGrace(iso) {
  if (!iso) return iso;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + LEGACY_NODE_EXPIRY_GRACE_MS).toISOString();
}
