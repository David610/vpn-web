# ADR-0001: Commercial model is one person, many device-subscriptions

> Status: ACCEPTED (retroactive). Written 2026-09-25 to make an already-shipped
> decision explicit; no schema/behavior change accompanies this ADR.

## Context

Two commercial models existed in this codebase's history:

**Model A (account/member, earlier)**: an account holds members/users, each
with a device; capacity is a shared, account-wide entitlement sold in
multiples (3, 6, 9…); users/devices move freely between connection profiles;
onboarding a new person means inviting them into the account.

**Model B (one-person/device-subscription, current)**: an account is one
person. A person may hold several subscriptions (e.g. "Personal", "Family
laptop"). Each subscription covers 3 devices, plus 3 more per paid device
pack. Invitations and account-wide seat purchases are retired.

A prior handoff brief flagged this as an unresolved conflict and, absent a
written decision, instructed defaulting back to Model A. Direct code
inspection (2026-09-25) found that default does not apply here — a written
decision already exists, just not as a formally labeled ADR.

## Decision

**Model B is the commercial model.** One account is one person. A person can
hold multiple subscriptions. Each subscription independently covers 3
devices, expandable in packs of 3. Billing and device capacity are tracked
per subscription, not per account.

## Evidence this was a deliberate decision, not WIP debris

- `supabase/migrations/20260926000000_subscription_devices.sql` is additive,
  not destructive: no table is dropped. It repurposes `subscriptions.
  extra_seats` to mean extra device capacity, drops the one-subscription-
  per-account unique constraint (multiple live subscriptions are now
  intentional), adds `devices.subscription_id` with a same-account trigger,
  and revokes pending `member_invites` — winding the old model down in
  place rather than deleting it out from under existing customers.
- It is its own dedicated commit (`6c6c136`, *not* folded into the large
  direct-merge commit the handoff brief was worried about), with a detailed
  message: "feat(billing): one person per account, 3 devices per
  subscription, many subscriptions" — explicitly stating invitations and
  account-wide seat packs are retired.
- It is wired consistently end-to-end: Stripe checkout creates one
  subscription per checkout call and allows a second, differently-named
  subscription for the same account (`functions/api/create-checkout-
  session.js`); `functions/api/account/subscriptions/[id]/packs.js` is the
  live per-subscription capacity-purchase path; `functions/api/admin/
  subscriptions.js` and the `20260926010000_admin_subscription_views.sql`
  RPCs compute device capacity per subscription (`3 + extra_seats`); the
  account UI (`AccountShell.tsx`) is labeled "Subscriptions" with state
  typed as `subscriptions`/`devices`/`devicesPerPack`, no `members`/`seats`
  fields; the landing page markets "€6.99 a month for 3 devices... add more
  in packs of three" throughout.
- The legacy seat/invite endpoints (`functions/api/account/seats.js`,
  `functions/api/account/invites.js`) are not orphaned dead code — they are
  intentionally repurposed to return `410` and point callers at the new
  flow, while teardown paths (`members/[id].js`, `invites/[id].js`) stay
  live so pre-existing member relationships and pending invites can still
  be removed gracefully.

In short: Model B is the only model implemented in Stripe, the schema's live
write paths, the admin tooling, and all user-facing copy. Model A's tables
remain solely to let existing member/invite state wind down without data
loss.

## Consequence

- `account_members` and `member_invites` tables stay in the schema
  indefinitely as a legacy read/teardown surface. They are not a commercial
  unit going forward and must not be reintroduced as one (no new invite
  creation, no account-wide seat purchase).
- Vocabulary across landing page, checkout, account UI, admin UI, Terms,
  emails, and API responses must consistently use "subscription" and
  "device" / "device pack" — never "seat" or "member" as a customer-facing
  concept. `docs/superpowers` fleet-platform plan and admin UI audits
  (tracked separately) should be checked against this and updated where
  stale.
- Internal/infra identifiers that predate this decision —
  `STRIPE_SEAT_PRICE_ID` (a deployed Cloudflare Pages secret binding),
  `subscriptions.extra_seats` (a live DB column), and the `SEAT_*` constants
  in `functions/lib/seat-constants.js` — are **not** renamed by this ADR.
  Renaming them requires a coordinated Stripe/Cloudflare secret change and a
  column migration, not a code-only edit, and carries real production risk
  for close to zero product benefit (they are internal wiring, never shown
  to a customer or admin). `seat-constants.js` already documents this
  explicitly and layers device-named exports (`INCLUDED_DEVICES`,
  `DEVICE_PACK_SIZE`, `deviceCapacity()`) on top for all new code to use.
  Any future rename of the underlying secret/column is its own change, done
  deliberately with a deploy plan, not bundled here.

## Alternatives considered

- **Revert to Model A**, per the handoff brief's stated default. Rejected:
  it would mean discarding a coherent, already-shipped, already-tested
  pivot — undoing live Stripe behavior and UI copy — to resurrect a model
  no live code path, schema write path, or customer-facing surface
  currently implements. The brief's default applied only in the absence of
  a documented decision; one exists.
- **Maintain both models simultaneously** (e.g. let some accounts use
  shared seats, others use per-subscription devices). Rejected: doubles the
  billing logic, UI copy, and admin tooling surface for no stated customer
  need, and the current schema's backfill (moving existing active devices
  onto the account's oldest subscription) already assumes a single target
  model going forward.

## Status

Accepted. Supersedes Model A for all new commercial behavior. Model A's
tables remain solely as a legacy teardown surface (see Consequence).
