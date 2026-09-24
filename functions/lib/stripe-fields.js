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

import { SEAT_PACK_SIZE } from "./accounts.js";

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
 * The per-seat-pack line item on a subscription, if one has been added.
 *
 * A subscription carries the flat base price (which includes the first
 * INCLUDED_SEATS) and, once the owner buys extra capacity, a second licensed
 * item priced per pack of SEAT_PACK_SIZE seats — its quantity is the number
 * of extra packs, not the number of extra seats. Matching on the configured
 * price id rather than on position is what keeps this from mistaking the
 * base item for the seat-pack item when Stripe reorders them.
 *
 * @param {object} subscription - a Stripe Subscription object
 * @param {string | undefined} seatPriceId - env.STRIPE_SEAT_PRICE_ID
 * @returns {object | null} the subscription item, or null if no seat packs
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
 * How many extra seat packs a subscription is paying for. Absent a seat
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
 * How many seats beyond the included ones a subscription is paying for —
 * the seat-pack item's quantity converted from packs to seats. Absent a
 * seat item that is zero, not unknown.
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
 */
export function getInvoiceLinePeriodEnd(invoice) {
  const fromLine = invoice.lines?.data?.[0]?.period?.end;
  if (typeof fromLine === "number") return fromLine;
  if (typeof invoice.period_end === "number") return invoice.period_end;
  return null;
}
