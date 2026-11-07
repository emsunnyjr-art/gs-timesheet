// shift-report-collector — Telegram group -> handwritten shift report -> Supabase table
//
// TEMPORARY RECONCILIATION TOOL. Not a system of record, and deliberately not wired
// into any gs-timesheet domain table (employees/payroll/timesheet_entries/sales-admin).
// Its only job is:
//   photo posted in the shift-report Telegram group
//     -> Claude vision extraction (same domain rules as the Shift Encoder)
//     -> one row per product inserted into telegram_shift_reconciliation
//     -> a one-line confirmation replied into the Telegram thread
//
// Sink: the `telegram_shift_reconciliation` Postgres table in this same Supabase
// project. RLS is enabled on it with ZERO policies, and anon/authenticated have no
// grants at all — only the service_role key (used below) can read or write it. Mario
// reviews it via the Supabase dashboard/MCP, not through any app page.
//
// The two liters figures this whole pipeline exists to compare, per product:
//   (1) meter_sold_liters — SUM over that product's hoses of (end_liter - beg_liter).
//       The liter meters are the only direct measurement of liters sold on the report.
//   (2) dip_sold_liters   — (dip_beg - dip_end) + liters delivered during the shift.
//       NULL (never 0) when the report has no dipstick reading for that product.
//   variance = (1) - (2)
//
// NOTE on the cashier's written "TOTAL SALES" column: on these report forms that column
// is PESOS (it tracks the peso sales meter, end_sales - beg_sales), not liters — verified
// against the Shift Encoder's own recalcHose(), where shift_sales = end_sales - beg_sales
// and the misread flag is a peso threshold. So it cannot serve as figure (1) directly.
// It is still captured verbatim (written_sales_pesos) and converted to liters at the
// report's own posted price (written_sales_liters) as an independent cross-check on the
// liter meters — a disagreement between the two is itself flagged.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// ---------------------------------------------------------------------------
// Tunables — the flagging thresholds live here on purpose, so they can be
// adjusted without touching any logic below.
// ---------------------------------------------------------------------------

/** Flag a variance at or beyond this many liters. */
const VARIANCE_ABS_LITERS = 20;
/** Flag a variance at or beyond this percentage of the dipstick-implied figure. */
const VARIANCE_PCT = 2;
/**
 * "or"  — flag if EITHER threshold is breached (as specified; more sensitive, and on a
 *         high-volume shift the 2% test does nearly all the work).
 * "and" — flag only when BOTH are breached (quieter on big shifts).
 */
const VARIANCE_MODE: "or" | "and" = "or";

/**
 * A single hose's written peso sales above this in one shift is a likely digit misread.
 * Mario's own stated rule (confirmed, not the Shift Encoder's looser ₱50,000 cell-tint
 * threshold — that one is calibrated for busier stations and doesn't fit here): his
 * busiest station sells only ~1,000L/day *total*, so ₱20,000 on a single hose in one
 * shift is already far outside normal volume and should flag, not slide by unnoticed.
 */
const HOSE_SALES_MISREAD_PESOS = 20000;
/** Tolerance before meter liters and price-converted written pesos are called inconsistent. */
const WRITTEN_VS_METER_PCT = 2;

/** Fixed product order, matching DELIVERY_PRODUCT_ORDER in the gs-timesheet apps. */
const PRODUCTS = ["Diesel", "Premium", "Unleaded"] as const;
type Product = (typeof PRODUCTS)[number];

const MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ALLOWED_CHAT_IDS = (Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provisioned automatically for every Edge
// Function in this project — same pair enroll-employee already relies on. Never shipped
// to client-side JS; this function is the only other place in the repo allowed to hold it.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tg(method: string, body: unknown): Promise<any> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  }
  return json.result;
}

async function reply(chatId: number | string, messageId: number, text: string) {
  try {
    await tg("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: messageId,
      allow_sending_without_reply: true,
      text,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("reply failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Download the photo at the highest resolution Telegram kept, as base64. */
async function downloadPhoto(
  photoSizes: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>,
) {
  const best = photoSizes.reduce((a, b) => {
    const area = (p: typeof a) => (p.width ?? 0) * (p.height ?? 0) || (p.file_size ?? 0);
    return area(b) > area(a) ? b : a;
  });
  const file = await tg("getFile", { file_id: best.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = String(file.file_path ?? "").toLowerCase();
  const mediaType = ext.endsWith(".png")
    ? "image/png"
    : ext.endsWith(".webp")
    ? "image/webp"
    : ext.endsWith(".gif")
    ? "image/gif"
    : "image/jpeg";
  return { base64: encodeBase64(bytes), mediaType, fileId: best.file_id };
}

/**
 * Deep link back to the original message for manual review. Private groups/supergroups
 * use the t.me/c/<internal id>/<message id> form, where the internal id is the chat id
 * with its -100 supergroup prefix stripped. Public chats use their @username.
 */
function messageLink(chat: any, messageId: number): string {
  if (chat?.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat?.id ?? "");
  if (id.startsWith("-100")) return `https://t.me/c/${id.slice(4)}/${messageId}`;
  return "";
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "report_date",
    "station",
    "shift",
    "attendant",
    "prices",
    "dipstick",
    "deliveries",
    "hoses",
    "confidence",
    "notes",
  ],
  properties: {
    report_date: { type: ["string", "null"], description: "YYYY-MM-DD as written on the report" },
    station: { type: ["string", "null"], description: "GS1, GS2 or GS5" },
    shift: { type: ["string", "null"], description: "AM, PM or GY" },
    attendant: { type: ["string", "null"], description: "the P/A (pump attendant) name" },
    prices: {
      type: "object",
      additionalProperties: false,
      required: ["unleaded", "premium", "diesel"],
      description: "posted price per liter, from the right side of the form",
      properties: {
        unleaded: { type: ["number", "null"] },
        premium: { type: ["number", "null"] },
        diesel: { type: ["number", "null"] },
      },
    },
    dipstick: {
      type: "object",
      additionalProperties: false,
      required: [
        "unleaded_beg",
        "unleaded_end",
        "premium_beg",
        "premium_end",
        "diesel_beg",
        "diesel_end",
      ],
      description:
        "tank dipstick LITERS at start and end of shift; null (never 0) when not written",
      properties: {
        unleaded_beg: { type: ["number", "null"] },
        unleaded_end: { type: ["number", "null"] },
        premium_beg: { type: ["number", "null"] },
        premium_end: { type: ["number", "null"] },
        diesel_beg: { type: ["number", "null"] },
        diesel_end: { type: ["number", "null"] },
      },
    },
    deliveries: {
      type: "array",
      description:
        "fuel deliveries/unloadings received DURING this shift, only if written on the report",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product", "liters"],
        properties: {
          product: { type: "string", enum: ["Unleaded", "Premium", "Diesel"] },
          liters: { type: "number" },
        },
      },
    },
    hoses: {
      type: "array",
      description: "every hose row under PUMP 1 and PUMP 2",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pump",
          "hose_no",
          "product",
          "beg_liter",
          "end_liter",
          "beg_sales",
          "end_sales",
          "written_total_sales",
        ],
        properties: {
          pump: { type: "integer" },
          hose_no: { type: "integer" },
          product: { type: "string", enum: ["Unleaded", "Premium", "Diesel"] },
          beg_liter: { type: ["number", "null"] },
          end_liter: { type: ["number", "null"] },
          beg_sales: { type: ["number", "null"] },
          end_sales: { type: ["number", "null"] },
          written_total_sales: {
            type: ["number", "null"],
            description:
              "the cashier's own far-right TOTAL SALES figure for this hose, in PESOS, exactly as written; null if blank",
          },
        },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: {
      type: ["string", "null"],
      description: "anything unreadable, ambiguous, or self-inconsistent on the report",
    },
  },
} as const;

const EXTRACTION_PROMPT = [
  "You are an expert at reading handwritten Philippine gas station shift reports.",
  "Study this image carefully and extract every value you can actually see.",
  "",
  "READING RULES:",
  "1. Liter and sales meter readings are VERY LARGE numbers like 8967362.78 or 48011205.30 — read every digit exactly.",
  "2. Shift is marked with a checkbox: AM, PM, or GY (graveyard/night).",
  "3. Date is written at top left. Station (GS1/GS2/GS5) is on the form or in its header.",
  "4. P/A field = pump attendant name.",
  "5. DIPSTICK has two numbers per product, beginning and ending, in LITERS (like 5628-5518).",
  "6. PRICES are on the right side: U = Unleaded, P = Premium, D = Diesel.",
  "7. PUMP 1 and PUMP 2 each have up to 4 hose rows, each with beg_liter, beg_sales, end_liter, end_sales, and the cashier's TOTAL SALES on the far right.",
  "8. The far-right TOTAL SALES column is in PESOS — it is the difference of the two SALES meters, not liters. Record it verbatim in written_total_sales; do not convert it.",
  "9. Each hose row has its own product. Do not assume hose order or that a pump is single-product — read each row's product.",
  "10. If a delivery/unloading of fuel during this shift is written anywhere on the form, record it under deliveries.",
  "",
  "ABSENT vs ZERO — this matters more than anything else here:",
  "- Use null for any value that is not written, is blank, or is genuinely unreadable.",
  "- Use 0 ONLY when the report actually shows a zero (e.g. an unused hose whose beg and end readings are identical).",
  "- Never substitute 0 for a missing dipstick reading or a missing price. A missing dipstick must come back as null so it is reported as 'not captured' rather than as 'nothing was sold'.",
  "- If no delivery is mentioned, return an empty deliveries array — not a zero-liter entry.",
  "",
  "BEFORE YOU ANSWER, verify your own extraction and fix what fails:",
  "a. For each hose, end_liter should be >= beg_liter and end_sales >= beg_sales (these are cumulative meters that only count up). If you read a decrease, you misread a digit — re-read that row.",
  "b. For each hose, (end_sales - beg_sales) should be close to (end_liter - beg_liter) x that product's posted price. If it is far off, re-read the row's digits.",
  "c. written_total_sales should be close to (end_sales - beg_sales) for that hose. If not, re-read both.",
  "d. A single hose's written_total_sales above 20,000 pesos in one shift is unusual and is usually a misread — re-check it.",
  "e. Confirm each digit count: these meters typically have 6-8 digits before the decimal point.",
  "",
  "Report anything still unreadable, ambiguous, or self-inconsistent after that check in notes, and set confidence accordingly. Do not invent values to fill gaps.",
].join("\n");

type Extraction = {
  report_date: string | null;
  station: string | null;
  shift: string | null;
  attendant: string | null;
  prices: { unleaded: number | null; premium: number | null; diesel: number | null };
  dipstick: Record<string, number | null>;
  deliveries: Array<{ product: string; liters: number }>;
  hoses: Array<{
    pump: number;
    hose_no: number;
    product: string;
    beg_liter: number | null;
    end_liter: number | null;
    beg_sales: number | null;
    end_sales: number | null;
    written_total_sales: number | null;
  }>;
  confidence: string;
  notes: string | null;
};

async function extractReport(base64: string, mediaType: string): Promise<Extraction> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const request = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" as const },
    output_config: {
      effort: "medium" as const,
      format: { type: "json_schema" as const, schema: EXTRACTION_SCHEMA },
    },
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: mediaType as any, data: base64 },
          },
          { type: "text" as const, text: EXTRACTION_PROMPT },
        ],
      },
    ],
  };

  let response: any;
  try {
    // Server-side refusal fallback: if a policy classifier declines, the API re-runs the
    // same request on a fallback model inside this one call instead of returning nothing.
    response = await client.beta.messages.create({
      ...request,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as any);
  } catch (e: any) {
    // If this deployment's API account doesn't have the fallback beta, don't fail the
    // whole report over it — retry once on the stable endpoint.
    const msg = String(e?.message ?? e);
    if (e?.status === 400 && /fallback|beta/i.test(msg)) {
      console.warn("refusal-fallback beta rejected, retrying without it:", msg);
      response = await client.messages.create(request as any);
    } else {
      throw e;
    }
  }

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to process this image.");
  }
  const text = (response.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  if (!text.trim()) throw new Error("Claude returned no extraction text.");
  return JSON.parse(text) as Extraction;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

function normProduct(raw: unknown): Product | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.startsWith("d")) return "Diesel";
  if (s.startsWith("p")) return "Premium";
  if (s.startsWith("u")) return "Unleaded";
  return null;
}

/** Shape of one row of telegram_shift_reconciliation — see the migration for columns. */
type Row = {
  report_date: string | null;
  station: string | null;
  shift: string | null;
  attendant: string | null;
  product: Product;
  hose_count: number;
  beg_meter_liters: number | null;
  end_meter_liters: number | null;
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
};

function buildRows(x: Extraction, ctx: {
  fileId: string;
  link: string;
  messageId: number;
  reportedBy: string;
}): Row[] {
  const rows: Row[] = [];

  for (const product of PRODUCTS) {
    const key = product.toLowerCase();
    const hoses = (x.hoses ?? []).filter((h) => normProduct(h.product) === product);
    const dipBeg = num(x.dipstick?.[`${key}_beg`]);
    const dipEnd = num(x.dipstick?.[`${key}_end`]);
    const unitPrice = num((x.prices as any)?.[key]);

    // Nothing at all on the report for this product — GS5 has no Diesel tank, for one.
    if (hoses.length === 0 && dipBeg === null && dipEnd === null) continue;

    const flags: string[] = [];

    // --- (1) meter liters: the only direct liters measurement on the form ---
    let begMeter = 0;
    let endMeter = 0;
    let meterSold: number | null = null;
    let meterReadable = 0;
    for (const h of hoses) {
      const b = num(h.beg_liter);
      const e = num(h.end_liter);
      if (b === null || e === null) continue;
      meterReadable++;
      begMeter += b;
      endMeter += e;
      // Kept raw (not clamped at 0) so an impossible decrease is visible, not hidden.
      meterSold = (meterSold ?? 0) + (e - b);
      if (e < b) {
        flags.push(`negative_meter_delta(P${h.pump}H${h.hose_no})`);
      }
    }
    if (hoses.length > 0 && meterReadable < hoses.length) {
      flags.push(`unreadable_meter_rows(${hoses.length - meterReadable})`);
    }

    // --- the cashier's written peso column, and its liters equivalent ---
    let writtenPesos: number | null = null;
    for (const h of hoses) {
      // Prefer the cashier's own written total; fall back to the sales-meter difference.
      let p = num(h.written_total_sales);
      if (p === null) {
        const bs = num(h.beg_sales);
        const es = num(h.end_sales);
        if (bs !== null && es !== null) p = es - bs;
      }
      if (p === null) continue;
      writtenPesos = (writtenPesos ?? 0) + p;
      if (p > HOSE_SALES_MISREAD_PESOS) {
        flags.push(`hose_sales_over_${HOSE_SALES_MISREAD_PESOS}(P${h.pump}H${h.hose_no})`);
      }
    }
    const writtenLiters =
      writtenPesos !== null && unitPrice !== null && unitPrice > 0
        ? writtenPesos / unitPrice
        : null;

    // Cross-check the two independent readings of the same shift.
    if (writtenLiters !== null && meterSold !== null && meterSold > 0) {
      const diffPct = Math.abs((meterSold - writtenLiters) / meterSold) * 100;
      if (diffPct > WRITTEN_VS_METER_PCT) flags.push("written_vs_meter_mismatch");
    }

    // --- (2) dipstick-implied liters, delivery-adjusted ---
    const delivered = (x.deliveries ?? [])
      .filter((d) => normProduct(d.product) === product)
      .reduce((s, d) => s + (num(d.liters) ?? 0), 0);
    const hasDelivery = (x.deliveries ?? []).some((d) => normProduct(d.product) === product);

    let dipSold: number | null = null;
    if (dipBeg !== null && dipEnd !== null) {
      // A delivery raises the tank level independently of sales, so add it back in.
      dipSold = dipBeg - dipEnd + delivered;
      if (dipEnd > dipBeg && !hasDelivery) flags.push("dipstick_rose_without_delivery");
    } else if (dipBeg !== null || dipEnd !== null) {
      flags.push("dipstick_half_recorded");
    }

    // --- variance ---
    let variance: number | null = null;
    let variancePct: number | null = null;
    if (meterSold !== null && dipSold !== null) {
      variance = meterSold - dipSold;
      if (Math.abs(dipSold) > 0) variancePct = (variance / dipSold) * 100;

      const overAbs = Math.abs(variance) >= VARIANCE_ABS_LITERS;
      const overPct = variancePct !== null && Math.abs(variancePct) >= VARIANCE_PCT;
      const breached = VARIANCE_MODE === "and" ? overAbs && overPct : overAbs || overPct;
      if (breached) flags.push("variance_over_threshold");
    }

    if (String(x.confidence) === "low") flags.push("low_extraction_confidence");

    rows.push({
      report_date: x.report_date ?? null,
      station: x.station ?? null,
      shift: x.shift ?? null,
      attendant: x.attendant ?? null,
      product,
      hose_count: hoses.length,
      // Sums across this product's hoses: the absolute totals are composite, but their
      // difference is the correct liters-sold figure. Per-hose detail is in hose_detail.
      beg_meter_liters: meterSold === null ? null : round2(begMeter),
      end_meter_liters: meterSold === null ? null : round2(endMeter),
      meter_sold_liters: meterSold === null ? null : round2(meterSold),
      written_sales_pesos: writtenPesos === null ? null : round2(writtenPesos),
      unit_price: unitPrice,
      written_sales_liters: writtenLiters === null ? null : round2(writtenLiters),
      dip_beg_liters: dipBeg,
      dip_end_liters: dipEnd,
      delivered_liters: hasDelivery ? round2(delivered) : null,
      dip_sold_liters: dipSold === null ? null : round2(dipSold),
      variance_liters: variance === null ? null : round2(variance),
      variance_pct: variancePct === null ? null : round2(variancePct),
      flagged: flags.length > 0,
      flags: flags.length > 0 ? flags.join("; ") : null,
      extraction_confidence: x.confidence ?? null,
      extraction_notes: x.notes ?? null,
      hose_detail: hoses,
      reported_by: ctx.reportedBy || null,
      telegram_message_id: ctx.messageId,
      telegram_file_id: ctx.fileId,
      telegram_photo_link: ctx.link || null,
    });
  }

  return rows;
}

async function insertRows(rows: Row[]) {
  const { error } = await adminClient.from("telegram_shift_reconciliation").insert(rows);
  if (error) throw new Error(`DB insert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Confirmation message
// ---------------------------------------------------------------------------

function buildReplyText(x: Extraction, rows: Row[]): string {
  const head = [x.station || "station?", x.report_date || "date?", x.shift || "shift?"]
    .join(" · ");
  const lines: string[] = [`✅ Logged — ${head}`];

  for (const r of rows) {
    const meter = r.meter_sold_liters === null ? "—" : `${r.meter_sold_liters}L`;
    const dip = r.dip_sold_liters === null ? "no dipstick" : `${r.dip_sold_liters}L`;
    const varPart =
      r.variance_liters === null
        ? ""
        : ` · var ${r.variance_liters > 0 ? "+" : ""}${r.variance_liters}L`;
    lines.push(`${r.flagged ? "⚠️" : "•"} ${r.product}: meter ${meter} vs dip ${dip}${varPart}`);
  }

  const flagged = rows.filter((r) => r.flagged);
  if (flagged.length) {
    lines.push("");
    lines.push("⚠️ check this one:");
    for (const r of flagged) lines.push(`• ${r.product} — ${r.flags}`);
  }
  if (x.notes) {
    lines.push("");
    lines.push(`Reader notes: ${x.notes}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function processPhoto(message: any) {
  const chat = message.chat;
  const messageId = message.message_id;
  const reportedBy =
    [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") ||
    message.from?.username ||
    "";

  try {
    const { base64, mediaType, fileId } = await downloadPhoto(message.photo);
    const extraction = await extractReport(base64, mediaType);
    const rows = buildRows(extraction, {
      fileId,
      link: messageLink(chat, messageId),
      messageId,
      reportedBy,
    });

    if (rows.length === 0) {
      await reply(
        chat.id,
        messageId,
        "⚠️ I read the photo but found no pump or dipstick figures on it. Nothing logged — please re-post a clearer shot of the full report.",
      );
      return;
    }

    await insertRows(rows);
    await reply(chat.id, messageId, buildReplyText(extraction, rows));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("processPhoto failed:", msg);
    await reply(
      chat.id,
      messageId,
      `⚠️ Could not log this report — nothing was saved. Please re-post it.\n\n(${msg.slice(0, 300)})`,
    );
  }
}

// Guards against Telegram re-delivering an update whose ack we were too slow to return.
const seenUpdates = new Set<number>();

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  // An unauthenticated endpoint by necessity (Telegram cannot send a Supabase JWT), so
  // the shared secret Telegram echoes back on every call is the first gate.
  if (WEBHOOK_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== WEBHOOK_SECRET) return new Response("forbidden", { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const message = update.message ?? update.channel_post ?? update.edited_message ?? null;
  const chatId = message?.chat?.id;

  // Setup aid, available ONLY until the allow-list is configured: this is how the group's
  // chat.id gets discovered without fishing through getUpdates. Once
  // TELEGRAM_ALLOWED_CHAT_ID is set, the bot never answers outside the allow-list.
  if (ALLOWED_CHAT_IDS.length === 0) {
    const text = String(message?.text ?? "");
    if (message && /^\/(id|start|chatid)/.test(text)) {
      await reply(
        chatId,
        message.message_id,
        `This chat's id is: ${chatId}\n\nSet it as the TELEGRAM_ALLOWED_CHAT_ID secret to start collecting shift reports here.`,
      );
    }
    return new Response("ok", { status: 200 });
  }

  // Allow-list: a photo from any other chat, or in a DM to the bot, is ignored outright —
  // no row, no reply.
  if (!message?.photo || !ALLOWED_CHAT_IDS.includes(String(chatId))) {
    return new Response("ok", { status: 200 });
  }

  const updateId = Number(update.update_id);
  if (Number.isFinite(updateId)) {
    if (seenUpdates.has(updateId)) return new Response("ok", { status: 200 });
    seenUpdates.add(updateId);
    if (seenUpdates.size > 500) seenUpdates.clear();
  }

  // Ack Telegram immediately and do the slow work (download + vision + DB insert) after.
  // Telegram retries any webhook call it doesn't get a prompt 200 for, and a retry here
  // would mean duplicate rows in the table.
  const work = processPhoto(message);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return new Response("ok", { status: 200 });
});
