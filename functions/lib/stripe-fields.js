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
