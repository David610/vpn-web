/**
 * Seat-pack billing constants shared between server code (functions/lib,
 * functions/api) and client UI (src/components) so there is exactly one
 * place that defines them — no independently-maintained duplicate on
 * either side to drift out of sync.
 *
 * This file has zero dependencies (no Supabase client, no Stripe SDK) so
 * it is safe to import from a client bundle.
 */

/** Seats included in the base price before any per-seat-pack item is billed. */
export const INCLUDED_SEATS = 3;

/**
 * Extra seats are sold in packs, not one at a time. `subscriptions.
 * extra_seats` remains the source-of-truth mirror of Stripe's seat-item
 * quantity, in seats (not packs); this constant only converts between the
 * two at the edges — the purchase API's request/response shape and
 * pack-quantity-shaped error messages.
 *
 * Deliberately its own literal, not `= INCLUDED_SEATS`: the two happen to
 * share the value 3 today (per the fleet platform plan's target model,
 * `seat_capacity = INCLUDED_SEATS * (1 + pack_quantity)`), but they are
 * billed as separate Stripe prices and are conceptually independent knobs
 * — changing the base plan's included-seat count must not silently change
 * what a seat pack contains, and vice versa.
 */
export const SEAT_PACK_SIZE = 3;

/**
 * How many whole extra packs `extraSeats` represents. Rounds up so a
 * non-pack-aligned `extra_seats` value (only reachable via a manual Stripe
 * dashboard edit — our own purchase API only ever writes multiples of
 * SEAT_PACK_SIZE) is never under-reported: the caller always sees at least
 * as many packs as the seats actually in place.
 */
export function packQuantityFromExtraSeats(extraSeats) {
  return Math.ceil(Math.max(0, extraSeats) / SEAT_PACK_SIZE);
}
