# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"A's Fuel — GS Apps": a set of standalone, installable (PWA) HTML pages for running fuel-station operations — rostering, timesheets/clock in-out, fuel sales/inventory, HR enrollment, ID cards, and reports. There is no build system, no bundler, no package.json, and no test suite. Each `.html` file is a fully self-contained app: markup, CSS, and JS all live in a single file, loading its dependencies from CDN `<script>` tags (Supabase JS, qrcode, xlsx, jsQR, tesseract.js).

`index.html` is just a launcher grid of tiles linking to the other pages (plus one external link to `roster-hr`, a separate deployed app).

## Running / deploying

There's no dev server or build step. Open any `.html` file directly, or serve the directory statically (e.g. `python3 -m http.server`) since the service worker (`sw.js`) requires an http(s) origin to register. The site is deployed via GitHub Pages at `https://emsunnyjr-art.github.io/gs-timesheet/`.

There is no lint or test command — changes are validated by opening the page in a browser and exercising the flow against the live Supabase project (see below). When making UI changes, actually open the affected page and click through the golden path before calling the work done.

## Backend: Supabase

Every app talks directly to the same Supabase project from client-side JS — there is no server layer in this repo:

```js
const SUPABASE_URL = "https://cztkovsjxuaiburaudgk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_...";
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

All schema, RLS policies, and Postgres functions live in Supabase itself, not in this repo — use the Supabase MCP tools (`list_tables`, `execute_sql`, `list_migrations`, `get_advisors`) to inspect current schema/state rather than grepping for it here. Business logic that needs to be atomic or privileged is pushed into Postgres RPC functions and called via `supabase.rpc(...)` (e.g. `verify_admin_pin`, `verify_enroll_pin`, `fn_fuel_close_meter_period`, `fn_fuel_recompute_wac_chain`) rather than done client-side — follow that pattern for new privileged/multi-step writes instead of doing multi-statement logic in the browser.

Row Level Security is enabled on every table; access is scoped through `user_branch_roles` (see Auth below), so a new table/feature should get RLS policies, not rely on the anon key alone for protection.

## Auth model — two tiers, don't conflate them

1. **PIN-gated admin screens** (`hr-admin.html`, `timesheet-admin.html`, parts of `enroll.html`): protected by a shared PIN checked via `supabase.rpc("verify_admin_pin", ...)` / `verify_enroll_pin`, with the "unlocked" state cached in `sessionStorage` (e.g. `hr_admin_ok`). No per-user identity — just a shared secret.
2. **Real Supabase Auth accounts, scoped per branch** (`roster-admin.html`, `sales-admin.html`, `sales-clock.html`, `reports.html`, `enroll.html`'s owner check): `supabase.auth.signInWithPassword(...)`, then the user's access is looked up from `user_branch_roles` (`user_id`, `branch_id`, `role`, `apps[]`):
   - A row with `branch_id === null` means **owner** (all branches).
   - Otherwise the row scopes that user to one branch.
   - The `apps` text array on each role row gates which app tiles (`roster`, `sales_admin`, `sales_clock`, `reports`, ...) that grant allows; a page checks `myRoles.some(r => (r.apps||[]).includes("<app>"))` before letting the user in, and signs them out otherwise.
   - New role-gated pages should follow the `afterLogin()` pattern in `roster-admin.html`/`sales-admin.html`: fetch `user_branch_roles`, derive `isOwner`/`myBranchIds`, verify the relevant `apps` entry, then filter all subsequent queries by `myBranchIds` unless `isOwner`.

`enroll.html` is where owners grant accounts branch/role/app access — new apps that need role gating must be added to its checkbox list of `apps` values to actually be grantable.

## Offline queueing (timesheet-clock.html)

The clock in/out page is designed to be used with a flaky connection. Failed writes are queued in `localStorage` (`QUEUE_KEY`) — including any captured photo, base64-encoded via `FileReader` — and retried via `syncQueue()`. If you touch clock in/out logic, preserve this queue-and-retry path rather than assuming every Supabase write succeeds inline.

## PWA shell

`manifest.json` + `sw.js` exist solely to satisfy "Add to Home Screen" installability requirements (mainly Android/Chrome). `sw.js` is intentionally a no-op — no offline caching of the HTML/assets — because every page requires a live Supabase connection to function, so caching stale shells would be actively misleading. Don't add caching logic to `sw.js` without reconsidering this tradeoff.

## Domain structure (for orientation, not exhaustive)

- **Timesheets**: `employees`, `shifts`, `shift_templates`, `roster_assignments`, `timesheet_entries`, `employee_rate_history`, `rates`, `wage_rules`, `allowances`, `payroll*`.
- **Fuel operations**: `fuel_tanks`/`fuel_tank_calibration`, `fuel_deliveries` (with WAC — weighted average cost — before/after snapshots), `fuel_pumps`/`fuel_meter_readings`/`fuel_meter_periods`/`fuel_dispense_allocations` (meter periods must reconcile: allocated liters must sum to `total_liters_dispensed`), `fuel_credit_customers`/`fuel_credit_transactions` (receivables, distinct from `fuel_vendors` which are suppliers), `fuel_shift_cash_reconciliation` (variance-flagged shift closeout).
- **Access control**: `branches`, `user_branch_roles`.

Several fuel tables have detailed `comment`s in Postgres describing invariants (e.g. cache-vs-source-of-truth relationships, how balances are derived) — check `list_tables(verbose=true)` / table comments via Supabase MCP before changing anything in the fuel sales/inventory flow, since the invariants aren't duplicated here.

## Why WAC, not FIFO, for fuel cost basis

`fuel_deliveries` prices sold fuel using Weighted Average Cost, not FIFO batch tracking, because fuel is fungible once it hits the tank: a delivery gets pumped straight into a tank that may already hold fuel from a prior delivery at a different cost, and the physical product mixes completely — there is no way to say a given liter sold today came from "batch A" vs "batch B". FIFO would require attributing sold liters to a specific delivery batch, which isn't physically meaningful for a mixed liquid in a shared tank.

The mechanics live in Postgres, not the client:
- `fn_fuel_delivery_apply_wac()` (a `BEFORE INSERT` trigger on `fuel_deliveries`) reads the branch+product's current `fuel_inventory_state` row, stamps the new delivery's `wac_before`/`wac_after` (`wac_after = ((current_liters * current_wac) + (invoiced_liters * cost_per_liter)) / (current_liters + invoiced_liters)`), then updates `fuel_inventory_state.current_liters`/`current_wac`.
- `fn_fuel_recompute_wac_chain(branch_id, product_id)` replays every delivery for that branch+product in `delivery_date, created_at` order and re-derives the whole `wac_before`/`wac_after` chain plus the resulting `fuel_inventory_state` row — call this if a historical delivery's cost or quantity is corrected, rather than hand-patching `wac_after` on one row (that would desync it from every later delivery's `wac_before`).

## Why `calibration`-category dispenses don't reduce inventory

`fuel_dispense_allocations.category = 'calibration'` liters are pump-calibration test pours — physically poured back into the same tank they came from, not sold or removed. Every other category (`cash_sale`, `credit_sale`, `company_use`, etc.) represents fuel that actually left the tank and reduces `fuel_inventory_state.current_liters` accordingly.

This is enforced in `fn_fuel_dispense_decrement_inventory()` (trigger on `fuel_dispense_allocations`): it returns early for `category = 'calibration'` before touching `fuel_inventory_state`, with the invariant spelled out in the function itself ("poured back into the tank, no net inventory change"). If you add a new dispense category, decide explicitly whether it represents fuel leaving the tank — don't assume every category should decrement inventory.

## Recently added business rules in `timesheet-clock.html`

The confirm-panel flow (`showConfirm()`) runs two live checks against Supabase before letting someone clock in/out, and both can block the confirm button behind an explicit "Yes, Continue" acknowledgment (`clockWarningPanel` / `pendingClockWarning`):

- **Over-headcount warning on Time In**: if the branch's current shift (from `detectCurrentShiftForBranch`) has a nonzero rostered headcount (`roster_assignments` count for that `shift_id`), and the number of people already on an open entry at that branch plus this new clock-in would exceed that rostered count, the warning fires (`"Clocking in <name> would go over the rostered headcount"`).
- **Suspiciously-recent Time Out warning**: if the employee's currently open entry has `time_in` less than 5 minutes ago, Time Out shows `"clocked in only N minute(s) ago... is that really intended?"` — meant to catch an accidental double-scan.

Both warnings gate the same mechanism: `pendingClockWarning` is set true whenever `clockWarningText` is non-null, and `renderActionBadge()` (which enables the confirm button and, for QR-verified identities, starts the 2-second auto-save countdown via `scheduleAutoSave`) is only called once `pendingClockWarning` is false — either because no warning fired, or because the user tapped "Yes, Continue" (`clockWarningProceedBtn`'s handler clears the flag and calls `renderActionBadge()` itself). Tapping "Cancel" on the warning aborts the whole punch (`cancelAutoSave()`, stops the camera, resets the mode) rather than just dismissing the warning. Auto-save itself only ever arms for QR-verified identities (`verifiedViaQr`) — a roster-button tap alone has no independent verification, so it always waits for a manual confirm tap.

## Background jobs invisible from this repo

A `pg_cron` job (`flag-stale-open-entries`, id 1, schedule `*/15 * * * *`) runs `select public.fn_flag_stale_open_entries();` every 15 minutes. That function sets `auto_clockout_flagged = true` / `auto_clockout_flagged_at = now()` on any `timesheet_entries` row where `time_out is null` and `time_in < now() - interval '8 hours'`.

Critically, it only **flags** — it never writes a `time_out` or otherwise closes the entry. A human (supervisor/admin) must review flagged rows in Timesheet Admin's Review tab and manually confirm/enter the real time-out. Don't build anything that treats `auto_clockout_flagged = true` as if the shift had actually ended, and don't add logic that auto-finalizes these entries without a supervisor's explicit input.

## Edge Functions

One deployed Edge Function, `enroll-employee` (Deno, `verify_jwt: true`), handles new-account creation for `enroll.html`. It exists because creating a Supabase Auth user and inserting into `user_branch_roles` requires the **service-role key**, which must never be shipped to client-side JS (every other page in this repo only ever uses the anon/publishable key) — the Edge Function is the one place that key is allowed to live, server-side.

It does not trust the caller's claim to be an owner: it takes the caller's JWT from the `Authorization` header, resolves the calling user via `callerClient.auth.getUser()`, then re-checks `user_branch_roles` server-side with the service-role client for a row where `role = 'owner'` before doing anything — returning 403 otherwise. The UI's owner-only gating in `enroll.html` is a UX convenience, not the actual security boundary; this server-side re-check is. Any future privileged action that needs the service-role key should follow the same pattern (verify JWT → look up caller's own role server-side → only then act), not add a second Edge Function that trusts a role/flag passed in the request body.

## Testing discipline for schema/function changes

Before applying any migration or Postgres function change with `apply_migration`, test it first inside `begin; ... rollback;` via `execute_sql` — write/run the statements, inspect the result, then roll back rather than committing blind. This matters most for anything touching wage calculation, WAC (`fn_fuel_delivery_apply_wac`, `fn_fuel_recompute_wac_chain`), or cash reconciliation (`fuel_shift_cash_reconciliation`) — these compute derived financial values from chains of prior rows, so a bad function body can silently corrupt numbers across many existing rows rather than just failing loudly on the new one.

## Role model constraint

`user_branch_roles.role` has a Postgres CHECK constraint (`user_branch_roles_role_check`) limiting it to exactly `'owner'`, `'manager'`, `'supervisor'`, `'cashier'`. Verify this constraint via Supabase MCP (`execute_sql` against `pg_constraint`) before adding any new role option to `enroll.html`'s UI — a role value not in this list will fail the insert (in `enroll-employee`'s `adminClient.from("user_branch_roles").insert(...)`) rather than silently working, and the constraint is the source of truth, not this list (it can change without this file being updated).

## Dipstick mode is an explicit per-tank toggle, not inferred from data

`fuel_tanks.dipstick_mode` (`'calibration_curve'` | `'direct_liter'`, default `'calibration_curve'`) explicitly decides how `sales-clock.html`'s Dipstick Check panel interprets a reading for that tank — set in Sales Admin → Setup → Tanks (`toggleDipstickMode()`), not derived from whether `fuel_tank_calibration` happens to have rows. `applyDipstickModeUI()` in `sales-clock.html` reads the selected tank's mode and shows/hides the Height (cm) field accordingly:
- **`calibration_curve`** (GS2–GS5 today): Height (cm) is shown; `lookupLitersFromCm()` linearly interpolates it to Liters via that tank's `fuel_tank_calibration` rows.
- **`direct_liter`** (GS1 today, all 3 tanks): Height (cm) is hidden entirely; the dipstick's physical graduation is already in liters, so Liters is entered directly with no conversion.

This was backfilled from each tank's existing behavior at migration time (zero `fuel_tank_calibration` rows → `direct_liter`, otherwise → `calibration_curve`), so don't assume the current GS1-vs-GS2–5 split is permanent or hardcoded — check `fuel_tanks.dipstick_mode` for a given tank rather than inferring it from calibration-row presence, since Mario can flip it per tank (e.g. a curve becomes unreliable, or dipstick hardware changes). Flipping the mode only affects `fuel_dipstick_checks` rows entered *after* the change — nothing recomputes `height_cm`/`liters` on historical rows (there's no trigger on that table at all), so a reading taken under one mode stays exactly as entered even if the tank's mode later changes.

## Delivery trips: `supplier_trips` → `delivery_visits` → `fuel_deliveries`, checks attach to the trip

A **trip** is one supplier truck run — one vendor, one date, possibly spanning **several branches** in a single run (confirmed real: GS1/GS2/GS3/GS4/GS5 can all be on one truck's route). A **visit** is one branch's stop within that trip — up to 3 products (Diesel/Premium/Unleaded, GS1's fixed set) entered together and committed together in one atomic call from `sales-admin.html`. This is the second restructure of this flow: `fn_save_delivery_with_check` (single product) → `fn_save_delivery_visit` (single branch, multi-product) → `fn_save_delivery_trip` (multi-branch, multi-product), each shipped and then superseded as Mario's actual workflow became clearer.

- **`fuel_deliveries` is still unchanged** — one row per product, same columns, same generated `total_cost`. It carries `visit_id` (unchanged from the visit-only design).
- **`supplier_trips`**: one row per truck run. Holds `vendor_id`/`driver_id`/`plate_number`/`trip_date` — these live here, *not* on `delivery_visits`, because they're always identical across every branch one truck visits in a run (a deliberate placement choice, not locked in by spec but the clear call given the data doesn't vary per branch). `id` is **client-generated** (`crypto.randomUUID()`) since the trip exists as an in-progress local draft before anything hits the DB.
- **`delivery_visits`**: one row per branch within a trip. Holds `trip_id`, `branch_id`, and the things that legitimately *can* differ per branch even on one truck run: `invoice_number` (suppliers sometimes invoice per drop-off site even on a combined run) and `shift_id` (shifts are inherently branch-scoped).
- **Split basis is liters, not peso value** (locked-in business rule) — a branch's share of a shared trip check is proportional to the liters *that branch* received, not the peso value. This happens to be mathematically equivalent to a value-based split in the common case (cost/liter to the supplier doesn't vary by branch for the same product/trip — retail markup is a downstream concern, irrelevant to what's owed upstream), but the code always computes by liters, never by value.
- **`fuel_delivery_supplier_check_allocations`** now keys on `trip_id` (renamed from `visit_id`) — a check's amount is its contribution to the *whole trip*, not any one branch. **`fuel_trip_check_visit_splits`** is the new layer underneath: one row per (allocation, visit) recording that check's liters-proportional dollar contribution to *that specific branch*, computed and stored once at the moment the check is attached (`fn_allocate_check_to_trip`) — a frozen, auditable record, not a live-recomputed ratio. Rounding remainder (always centavo-scale) goes to whichever branch had the most liters in the trip. `fuel_delivery_receivable_check_allocations` (branch owes GS1 back for wholesale-marked-up stock) **intentionally still keys on `visit_id`, not `trip_id`** — a receivable is a per-branch relationship with GS1, unrelated to which supplier truck delivered the fuel; migrating it to trip_id would incorrectly imply two branches' receivables could be tangled together via a shared trip.
- **`fn_save_delivery_trip`** (replaces `fn_save_delivery_visit`) takes the trip's shared fields, a `p_visits` jsonb array (one entry per branch, each with its own `p_products` array), and `p_checks`. Raises — rolling back everything, including the `supplier_trips` row — if any branch has zero resolved products, there are zero checks, or checks don't sum exactly to the trip's combined total across every branch. `fn_allocate_check_to_trip` (insert the trip-level allocation + compute/store the per-branch splits) is a **shared** function used both by the atomic trip save and by the Checks tab's incremental "Track Payments for a Trip / Visit" flow, so the split math lives in exactly one place regardless of when a check gets attached.
- **Reporting, again reworked not left alone**: `fuel_visit_supplier_payment_status` (per-visit) was replaced by `fuel_trip_supplier_payment_status` (per-trip — payment status only makes sense at the level checks actually attach to) plus the new `fuel_visit_debt_breakdown` (per-branch `owed`/`paid_cleared`/`allocated_total`, for granularity Debt Tracker and Delivery Detail need). `fuel_visit_receivable_payment_status` is untouched (still visit-scoped, correctly). `business_debt_summary` needed **no changes at all** for this migration — its `total_paid` already summed `fuel_delivery_supplier_check_allocations.amount` directly without ever referencing `visit_id`/`trip_id`, so the rename didn't touch it. `fuel_delivery_stock_reconciliation`, WAC functions, and profit views remain untouched — none of them ever referenced check allocations.
- **Sales Admin UI**: the Deliveries tab renders one "visit block" per branch in the current draft trip. Visit 0 always follows the global branch selector (so the common single-branch case shows zero extra UI); "+ Add Another Branch to This Trip" appends further visit blocks, each with its own branch picker excluding branches already on the trip. Only the most-recently-added branch can be removed (avoids renumbering every other block's DOM ids mid-entry). Checks stay visible but locked (dimmed, inputs disabled — not hidden, so entered data survives toggling) until every product slot in every branch on the trip is resolved.
- **Deleting a single delivery row still doesn't rebalance anything above it.** Same caveat as the visit-only design, now one level deeper: if a trip's checks were saved summing to the trip's *original* combined total, deleting one product leaves that total lower than the checks add up to — nothing auto-corrects this. Track Payments / Delivery Detail will show it as over-paid; that's the signal, not a bug.
- **Local draft autosave** (`sales-admin.html` only, `localStorage` key `gs_delivery_visit_draft`) now serializes the whole trip — every visit block's fields/slots plus the check rows. Still text/number only, no photos, not an offline-sync mechanism (don't conflate with `timesheet-clock.html`'s queue).

## Tank overflow: capacity, the held/external container, and its own WAC pool

Delivered volume sometimes exceeds what a branch's tank can currently hold; the excess physically goes into an external container. **Locked-in rule: held stock is real, paid-for inventory, but is NOT sellable/dispensable until physically transferred into the tank** — it must never count toward stock available for dispensing.

- **`fuel_tanks.capacity_liters`** (nullable, set in Sales Admin → Setup → Tanks): null (the default) means no capacity limit — overflow logic never triggers for that tank until Mario sets a value. This is opt-in per tank specifically so it can never change behavior for a tank nobody has configured.
- **`fuel_tank_held_stock`** (PK `branch_id, product_id`, mirroring `fuel_inventory_state`'s grain) is the held container's **own mini WAC pool** — blended with the *exact same* weighted-average formula as the tank's own `fuel_inventory_state`. This was a deliberate design choice (confirmed, not the only option considered): it means multiple overflow events at different costs blend correctly into one running average before any of it is transferred back in, without needing FIFO-style per-lot cost tracking.
- **`fuel_deliveries.liters_overflow_to_held`**: how many of a delivery's liters didn't fit in the tank at insert time (0 if it all fit, or if the tank has no `capacity_liters` configured). `wac_before`/`wac_after` on the delivery row continue to mean the *tank's* WAC only (never blended with held stock) — that's what dispensing/COGS actually reads, so the two must stay consistent: only the liters that actually reach the tank affect `fuel_inventory_state`; held liters only affect `fuel_tank_held_stock`.
- **`fn_fuel_delivery_apply_wac()`** (the same `BEFORE INSERT` trigger as before) now computes, per delivery: `liters_to_tank = LEAST(invoiced_liters, GREATEST(capacity_liters - current_liters, 0))` when capacity is configured (else all of it goes to tank), blends `liters_to_tank` into `fuel_inventory_state` and any remainder into `fuel_tank_held_stock`.
- **`fuel_tank_transfer_events`** + **`fn_transfer_held_to_tank(branch_id, product_id, liters, created_by)`**: a "move liters from held into the tank" stock movement, **not a new delivery** — doesn't touch what was owed/paid on any delivery, doesn't require a check. Rejects a transfer larger than what's currently held. Draws the liters out of the held pool at the held pool's *own current WAC* and blends that into the tank's WAC via the same formula.
- **`fn_fuel_recompute_wac_chain(branch_id, product_id)`** was rewritten to replay `fuel_deliveries` **and** `fuel_tank_transfer_events` for that branch+product in one true chronological order (merged by timestamp, not deliveries-only) — a transfer that happened between two deliveries correctly affects the second delivery's remaining-capacity calculation on replay. Call this after correcting a historical delivery *or* backdating/correcting a transfer event.
- Dispensing (`fn_fuel_dispense_decrement_inventory`) was **not touched** — it only ever reads/writes `fuel_inventory_state`, never `fuel_tank_held_stock`, so held stock is automatically excluded from sellable stock by construction, not by an added check.

## Inter-branch stock transfer (`Transfers` tab, Sales Admin only)

Internal movement of already-owned stock between two branches — a branch running low borrows from another rather than waiting for the next supplier delivery. **No supplier, no check, no payment is involved** — this is unrelated to `supplier_trips`/`delivery_visits`/checks entirely, and to `fuel_tank_held_stock`/overflow (that's a same-branch tank↔held-container movement; this is a branch↔branch movement).

- **`fuel_branch_transfers`** (id, product_id, from_branch_id, to_branch_id, liters, cost_per_liter_used, transfer_date, created_at, created_by) is the history/audit table — `check (from_branch_id <> to_branch_id)`, `check (liters > 0)`.
- **`fn_transfer_branch_stock(p_from_branch_id, p_to_branch_id, p_product_id, p_liters, p_transfer_date, p_created_by)`** is the only way to do this — one RPC, atomic:
  - Sending branch: `fuel_inventory_state.current_liters` decreases by the transferred amount; **its `current_wac` is left untouched**, the same principle as a sale — you're not changing what the branch's *remaining* stock cost, just how much of it there is. Raises if the sending branch doesn't have enough on hand.
  - Receiving branch: `current_liters` increases and `current_wac` blends using the same weighted-average formula as a delivery, but **`incoming_price` is the sending branch's most recent single delivery's `cost_per_liter`** (`fuel_deliveries` for that branch+product, latest `delivery_date`/`created_at`) — **deliberately not the sending branch's current blended WAC**. These two numbers can differ, and using the actual last-paid price rather than a blended average is the entire point of the rule (it reflects what was really paid for the specific stock being moved, not a smeared-out historical average). Raises if the sending branch has no delivery history at all for that product (nothing to price the transfer at).
  - Receiving branch's `fuel_inventory_state` row is created on the fly (0 liters/0 WAC) if it doesn't already exist.
- **Deliberately not integrated into `fn_fuel_recompute_wac_chain`'s replay** — consistent with how sales/dispensing already sit outside that chain (see the "not sales-aware" note below); a branch transfer is a simple one-shot direct write against `fuel_inventory_state`, not a chain-replayed event like deliveries/overflow transfers.
- RLS: `fuel_branch_transfers_select` open (`using (true)`), `fuel_branch_transfers_write_owner` owner-only — same pattern as every other new table this phase. Only Sales Admin has the UI for this; `sales-clock.html` was not touched.

## `fn_fuel_recompute_wac_chain` is not sales-aware (pre-existing, not fixed)

It rebuilds `fuel_inventory_state.current_liters`/`current_wac` purely by replaying `fuel_deliveries` and `fuel_tank_transfer_events` in chronological order — it has no knowledge of `fn_fuel_dispense_decrement_inventory`'s direct sales decrements. Calling the recompute function after a correction will NOT reproduce liters actually sold since the corrected event; this is a pre-existing characteristic of the chain, not something introduced or fixed in this repo's recent work. New features that touch `fuel_inventory_state` (like inter-branch transfers, above) are deliberately designed as simple direct writes rather than chain-replayed events, to stay consistent with how sales already behave rather than fight this gap.

## Known RLS gap: trip/visit/delivery check-required rule is app-enforced, not DB-enforced (open, not fixed)

`fn_save_delivery_trip` re-validates the check-sum rule server-side (raises and rolls back the whole call, including the `supplier_trips` row, on a mismatch or zero checks), so a client going through the RPC genuinely cannot save an under/over/un-checked trip.

But RLS on `fuel_deliveries` still allows **any branch-scoped authenticated user to INSERT directly** (`fuel_deliveries_insert_branch_or_owner`: owner OR `branch_id` match) — it isn't restricted to going through the RPC. A raw `supabase.from("fuel_deliveries").insert(...)` (bypassing the RPC entirely) could still create a delivery row with `visit_id = null` and zero attached checks. (RLS on `fuel_supplier_check_payments`/the allocation tables *is* owner-write-only, which is why a non-owner's RPC call fails partway if they tried to attach a check themselves — but that doesn't stop a bypass that just never calls the RPC. `supplier_trips` and `delivery_visits` mirror `fuel_deliveries`' insert policy — owner or branch-scoped — for the same reason, not owner-only. In practice, since checks are always required and the check tables are owner-write-only, only owners can ever *complete* a trip save today regardless.)

This is a pre-existing gap (predates the visit/trip model), not something newly introduced or fixed here — still called out deliberately rather than fixed, because closing it (tightening `fuel_deliveries` INSERT to route only through the RPC) is entangled with `sales-clock.html`'s mobile delivery form, which still does a raw `fuel_deliveries` insert directly and has never adopted checks — single, split, or trip-level — at all. Tightening the policy without first migrating mobile onto the RPC would break mobile delivery logging outright. Don't tighten this RLS policy without addressing mobile in the same change.

## Known iOS Safari pitfalls already fixed

- **Login fields must be real `type="password"` inputs**, not a text input with CSS-based masking — Safari's autofill/keychain integration behaves inconsistently (or not at all) against a faked password field.
- **Camera `facingMode` switching (front ↔ back) must happen inside a direct user-tap handler**, not from an async chain (e.g. after a QR-detection loop resolves). iOS Safari silently refuses the switch otherwise. See `timesheet-clock.html`'s `switchToSelfieCamera()`: it's called once opportunistically right after QR match (best-effort, may not take on iOS), then called again inside the actual `selfieCaptureBtn` click handler, which is the one that reliably works.
