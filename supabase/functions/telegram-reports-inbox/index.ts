// telegram-reports-inbox — PIN-gated server-side proxy onto telegram_shift_reconciliation
//
// `sales-admin.html` only ever holds the anon/publishable key, which has zero grants on
// telegram_shift_reconciliation (by design — see the shift-report-collector Edge
// Function's migration). This function is the one place that gap is bridged, and it is
// deliberately NOT a general read grant: every call re-verifies the admin PIN
// server-side via the existing verify_admin_pin() RPC (same mechanism hr-admin.html /
// timesheet-admin.html already use) before touching the table, using the service-role
// key — which never reaches the browser.
//
// This function only ever READS telegram_shift_reconciliation (plus updating its own
// import-tracking columns) and proxies Telegram's own getFile/download for a report's
// photo (so the Telegram bot token also never reaches the browser). It does not insert
// into, or otherwise touch, any fuel_* sales/inventory table — the actual save still
// only ever happens through sales-admin.html's own normal Dispensing form, client-side,
// going through every existing trigger/validation/Day-Close-gate exactly as a
// hand-typed entry would. Pre-fill only; this function cannot write a sale.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Every action re-checks the PIN itself — never trust a prior call in the same session. */
async function checkPin(pin: unknown): Promise<boolean> {
  if (typeof pin !== "string" || !pin) return false;
  const { data, error } = await adminClient.rpc("verify_admin_pin", { input_pin: pin });
  if (error) {
    console.error("verify_admin_pin error:", error.message);
    return false;
  }
  return data === true;
}

type ReconRow = {
  id: string;
  created_at: string;
  report_date: string | null;
  station: string | null;
  shift: string | null;
  attendant: string | null;
  product: string;
  hose_count: number;
  meter_sold_liters: number | null;
  written_sales_pesos: number | null;
  unit_price: number | null;
  written_sales_liters: number | null;
  dip_beg_liters: number | null;
  dip_end_liters: number | null;
  delivered_liters: number | null;
  dip_sold_liters: number | null;
  variance_liters: number | null;
  variance_pct: number | null;
  flagged: boolean;
  flags: string | null;
  extraction_confidence: string | null;
  extraction_notes: string | null;
  hose_detail: unknown;
  reported_by: string | null;
  telegram_message_id: number;
  telegram_file_id: string;
  telegram_photo_link: string | null;
  imported_at: string | null;
  imported_by: string | null;
  linked_entry_ids: unknown;
};

/** Groups the per-product rows for one photo back into one report object. */
function groupByReport(rows: ReconRow[]) {
  const byMsg = new Map<number, ReconRow[]>();
  for (const r of rows) {
    const list = byMsg.get(r.telegram_message_id) ?? [];
    list.push(r);
    byMsg.set(r.telegram_message_id, list);
  }
  return [...byMsg.entries()]
    .sort(([, a], [, b]) => (b[0].created_at > a[0].created_at ? 1 : -1))
    .map(([telegram_message_id, productRows]) => {
      const first = productRows[0];
      return {
        telegram_message_id,
        report_date: first.report_date,
        station: first.station,
        shift: first.shift,
        attendant: first.attendant,
        reported_by: first.reported_by,
        extraction_confidence: first.extraction_confidence,
        extraction_notes: first.extraction_notes,
        telegram_file_id: first.telegram_file_id,
        telegram_photo_link: first.telegram_photo_link,
        created_at: first.created_at,
        imported_at: first.imported_at,
        imported_by: first.imported_by,
        linked_entry_ids: first.linked_entry_ids,
        products: productRows.map((r) => ({
          id: r.id,
          product: r.product,
          hose_count: r.hose_count,
          meter_sold_liters: r.meter_sold_liters,
          written_sales_pesos: r.written_sales_pesos,
          unit_price: r.unit_price,
          written_sales_liters: r.written_sales_liters,
          dip_beg_liters: r.dip_beg_liters,
          dip_end_liters: r.dip_end_liters,
          delivered_liters: r.delivered_liters,
          dip_sold_liters: r.dip_sold_liters,
          variance_liters: r.variance_liters,
          variance_pct: r.variance_pct,
          flagged: r.flagged,
          flags: r.flags,
          hose_detail: r.hose_detail,
        })),
      };
    });
}

async function handleList(body: any) {
  const scope = body.scope === "imported" ? "imported" : "pending";
  let query = adminClient
    .from("telegram_shift_reconciliation")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300); // plenty for a few weeks of reports; this is a temporary tool

  query = scope === "imported" ? query.not("imported_at", "is", null) : query.is("imported_at", null);

  const { data, error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ reports: groupByReport((data ?? []) as ReconRow[]) });
}

async function handlePhoto(body: any) {
  const fileId = body.telegram_file_id;
  if (typeof fileId !== "string" || !fileId) return json({ error: "telegram_file_id required" }, 400);
  if (!TELEGRAM_BOT_TOKEN) return json({ error: "Bot token not configured" }, 500);

  const fileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const fileJson = await fileRes.json().catch(() => ({}));
  if (!fileJson?.ok) return json({ error: fileJson?.description ?? "getFile failed" }, 502);

  const filePath = fileJson.result.file_path;
  const photoRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!photoRes.ok) return json({ error: `Photo download failed: HTTP ${photoRes.status}` }, 502);

  const contentType = String(filePath).toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return new Response(photoRes.body, { headers: { ...CORS, "Content-Type": contentType } });
}

async function handleMarkImported(body: any) {
  const telegramMessageId = Number(body.telegram_message_id);
  if (!Number.isFinite(telegramMessageId)) return json({ error: "telegram_message_id required" }, 400);
  const importedBy = typeof body.imported_by === "string" && body.imported_by.trim() ? body.imported_by.trim() : null;
  const linkedEntryIds = Array.isArray(body.linked_entry_ids) ? body.linked_entry_ids : [];

  const { data, error } = await adminClient
    .from("telegram_shift_reconciliation")
    .update({ imported_at: new Date().toISOString(), imported_by: importedBy, linked_entry_ids: linkedEntryIds })
    .eq("telegram_message_id", telegramMessageId)
    .is("imported_at", null)
    .select("id");

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, rows_updated: (data ?? []).length });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const pinOk = await checkPin(body?.pin);
  if (!pinOk) return json({ error: "Incorrect or missing PIN." }, 403);

  switch (body.action) {
    case "list":
      return handleList(body);
    case "photo":
      return handlePhoto(body);
    case "mark_imported":
      return handleMarkImported(body);
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
