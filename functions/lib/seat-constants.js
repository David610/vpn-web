/**
 * Product model (current): one person per account; an account can hold
 * several subscriptions; each subscription covers 3 devices and can add
 * +3-device packs; devices can be moved between the account's
 * subscriptions. There are no shared seats, seat pools or member invites.
 *
 * The "seat" identifiers below are LEGACY NAMES kept for compatibility
 * with the Stripe pack price (STRIPE_SEAT_PRICE_ID) and the
 * subscriptions.extra_seats column, which now count extra DEVICES on one
 * subscription. New code should use INCLUDED_DEVICES / DEVICE_PACK_SIZE.
 *
 * Device-pack billing constants shared between server code (functions/lib,
 * functions/api) and client UI (src/components) so there is exactly one
 * place that defines them — no independently-maintained duplicate on
 * either side to drift out of sync.
 *
 * This file has zero dependencies (no Supabase client, no Stripe SDK) so
 * it is safe to import from a client bundle.
 */

/** Devices included in a subscription's base price (legacy name). */
export const INCLUDED_SEATS = 3;

/**
 * Extra devices are sold in packs, not one at a time. `subscriptions.
 * extra_seats` remains the source-of-truth mirror of Stripe's pack-item
 * quantity, in extra devices (not packs); this constant only converts between the
 * two at the edges — the purchase API's request/response shape and
 * pack-quantity-shaped error messages.
 *
 * Deliberately its own literal, not `= INCLUDED_SEATS`: the two happen to
 * share the value 3 today (per the fleet platform plan's target model,
 * `seat_capacity = INCLUDED_SEATS * (1 + pack_quantity)`), but they are
 * billed as separate Stripe prices and are conceptually independent knobs
 * — changing a subscription's included-device count must not silently
 * change what a device pack contains, and vice versa.
 */
export const SEAT_PACK_SIZE = 3;

/**
 * How many whole extra packs `extraSeats` represents. Rounds up so a
 * non-pack-aligned `extra_seats` value (only reachable via a manual Stripe
 * dashboard edit — our own purchase API only ever writes multiples of
 * SEAT_PACK_SIZE) is never under-reported: the caller always sees at least
 * as many packs as the extra devices actually in place.
 */
export function packQuantityFromExtraSeats(extraSeats) {
  return Math.ceil(Math.max(0, extraSeats) / SEAT_PACK_SIZE);
}

/**
 * Device model (current billing): each subscription covers
 * INCLUDED_DEVICES devices, plus DEVICE_PACK_SIZE more per paid pack. The
 * seat names above are kept because the Stripe pack item and the
 * subscriptions.extra_seats mirror still use them; extra_seats now counts
 * extra devices.
 */
export const INCLUDED_DEVICES = INCLUDED_SEATS;
export const DEVICE_PACK_SIZE = SEAT_PACK_SIZE;
/** Monthly price of the base plan and of each pack, in euro cents. */
export const BASE_PRICE_CENTS = 699;
export const PACK_PRICE_CENTS = 699;

export function deviceCapacity(extraSeats) {
  return INCLUDED_DEVICES + Math.max(0, extraSeats ?? 0);
}
