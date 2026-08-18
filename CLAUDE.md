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

## Per-branch data differences that aren't visible in code

`fuel_tank_calibration` has both a `height_cm` and a `liters` column. In practice:
- **GS1** has tanks in `fuel_tanks` but **zero** rows in `fuel_tank_calibration` — its physical dipstick is graduated directly in liters, so readings are used as-is with no curve lookup.
- **GS2–GS5** each have hundreds of `fuel_tank_calibration` rows per tank, all with `height_cm` populated — dipstick readings there are a height in cm that must be converted to liters via that tank's own calibration curve.

This is purely a data-level fact (which branches happen to have calibration rows) — nothing in the app code enforces or branches on it structurally. Don't assume a new branch will/won't have a calibration table, or that dipstick-reading UI can treat all branches identically; check `fuel_tank_calibration` for that branch's tanks first.

## Delivery visits: `delivery_visits` sits above `fuel_deliveries`, checks attach to the visit

A delivery **visit** is one truck's stop — up to 3 products (Diesel/Premium/Unleaded, GS1's fixed set) entered together in `sales-admin.html` and committed together in one atomic call. This superseded an earlier per-product atomic save (`fn_save_delivery_with_check`, shipped then replaced) once it became clear Mario's real workflow enters all of a visit's products before writing any check.

- **`fuel_deliveries` is unchanged** — still exactly one row per product, same columns, same generated `total_cost`. It just gained a `visit_id` FK.
- **`delivery_visits`** is the new parent row: one per truck stop, holding the shared vendor/driver/plate/invoice/shift/date. Its `id` is **client-generated** (`crypto.randomUUID()`, same convention as other client-side IDs in this app, e.g. `timesheet-clock.html`'s offline queue) since the visit exists as an in-progress local draft (see below) before anything is written to the DB.
- **`fuel_delivery_supplier_check_allocations` / `fuel_delivery_receivable_check_allocations`** now key on `visit_id`, not an individual delivery row — one check (or split across several) covers a visit's *combined* total across however many products it has, not any single product's own total. A row in the Recent Deliveries table shows the same visit-wide payment status as its siblings, not its own product's cost vs. payment.
- **`fn_save_delivery_visit`** (replaces `fn_save_delivery_with_check`) takes the visit's shared fields, a `p_products` jsonb array (one entry per resolved slot), and `p_checks` jsonb array. It raises — rolling back everything, including the `delivery_visits` row — if there are zero resolved products, zero checks, or the checks don't sum exactly to the combined total of the resolved products. This validation lives inside the function (not a standing table trigger) deliberately: a trigger enforcing "sum == total" at all times would also constrain the *separate*, still-supported "Track Payments for a Visit" flow in the Checks tab, which deliberately builds up allocations incrementally over time for older/partially-paid visits.
- **Reporting was reworked, not left alone**: `fuel_delivery_supplier_payment_status` / `fuel_delivery_receivable_payment_status` (per-delivery) were replaced by `fuel_visit_supplier_payment_status` / `fuel_visit_receivable_payment_status` (per-visit, summing all of a visit's `fuel_deliveries` rows). `business_debt_summary` was rewritten to sum cleared allocations by `visit_id` directly rather than joining through `fuel_deliveries.id` — its output math is unchanged (still fuel owed vs. fuel paid), only the join path changed. `fuel_delivery_stock_reconciliation`, `fuel_profit_by_shift`/`fuel_profit_cumulative_daily`, and the WAC functions were **not** touched — none of them ever referenced check allocations, so they read `fuel_deliveries` exactly as before.
- **Deleting a single delivery row doesn't rebalance its visit.** `deleteDelivery()` still deletes one `fuel_deliveries` row at a time. If that visit's checks were saved summing to the *original* combined total across all its products, deleting one product leaves the remaining products' combined total lower than what the checks add up to — nothing auto-corrects this (the sum-match rule only fires at visit save time, not as a standing invariant). The Payment Status for that visit will show as over-paid; that's the signal to re-split a check manually via "Track Payments for a Visit," not a bug.
- **Local draft autosave** (`sales-admin.html` only, `localStorage` key `gs_delivery_visit_draft`) is a client-side safety net against a dropped tab/crash while entering a visit — text/number fields only, no photos, nothing written to the DB until the real atomic save. It is explicitly **not** an offline-sync mechanism like `timesheet-clock.html`'s queue; don't conflate the two.

## Known RLS gap: visit/delivery check-required rule is app-enforced, not DB-enforced (open, not fixed)

`fn_save_delivery_visit` re-validates the check-sum rule server-side (raises and rolls back the whole call, including the `delivery_visits` row, on a mismatch or zero checks), so a client going through the RPC genuinely cannot save an under/over/un-checked visit.

But RLS on `fuel_deliveries` still allows **any branch-scoped authenticated user to INSERT directly** (`fuel_deliveries_insert_branch_or_owner`: owner OR `branch_id` match) — it isn't restricted to going through the RPC. A raw `supabase.from("fuel_deliveries").insert(...)` (bypassing the RPC entirely) could still create a delivery row with `visit_id = null` and zero attached checks. (RLS on `fuel_supplier_check_payments`/the allocation tables *is* owner-write-only, which is why a non-owner's RPC call fails partway if they tried to attach a check themselves — but that doesn't stop a bypass that just never calls the RPC. `delivery_visits` itself mirrors `fuel_deliveries`' insert policy — owner or branch-scoped — for the same reason, not owner-only.)

This is a pre-existing gap (predates the visit model), not something newly introduced or fixed here — still called out deliberately rather than fixed, because closing it (tightening `fuel_deliveries` INSERT to route only through the RPC) is entangled with `sales-clock.html`'s mobile delivery form, which still does a raw `fuel_deliveries` insert directly and has never adopted checks — single or split — at all. Tightening the policy without first migrating mobile onto the RPC would break mobile delivery logging outright. Don't tighten this RLS policy without addressing mobile in the same change.

## Known iOS Safari pitfalls already fixed

- **Login fields must be real `type="password"` inputs**, not a text input with CSS-based masking — Safari's autofill/keychain integration behaves inconsistently (or not at all) against a faked password field.
- **Camera `facingMode` switching (front ↔ back) must happen inside a direct user-tap handler**, not from an async chain (e.g. after a QR-detection loop resolves). iOS Safari silently refuses the switch otherwise. See `timesheet-clock.html`'s `switchToSelfieCamera()`: it's called once opportunistically right after QR match (best-effort, may not take on iOS), then called again inside the actual `selfieCaptureBtn` click handler, which is the one that reliably works.
