// movem-orders: WooCommerce order webhooks from movem.dance → movem_orders + Telegram + Ivonne
//
// Ingest (WooCommerce, deploy with --no-verify-jwt):
//   POST <order JSON>  headers X-WC-Webhook-Topic (order.created | order.updated),
//                      X-WC-Webhook-Signature = base64(HMAC-SHA256(raw body, secret))
//   POST webhook_id=<n> (form-encoded, unsigned): WooCommerce's ping when a webhook is saved
//
// Read (agents, Authorization: Bearer <anon key>):
//   POST { action: "list", unlogged_only?: boolean, since?: ISO date, limit?: number }
//   POST { action: "mark_logged", order_ids: number[] }  — the order is in Movem/orders.md
//
// Env: MOVEM_WC_WEBHOOK_SECRET (the secret typed into the WooCommerce webhook)
//
// Always answers 2xx to a correctly signed delivery, even if a later step fails:
// WooCommerce disables a webhook after five failed deliveries in a row.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHOP_ADMIN = "https://movem.dance/wp-admin/post.php?action=edit&post=";
const TELEGRAM_ORG = "whiteport";
const TELEGRAM_USER = "marten-angner";

const STATUS_SV: Record<string, string> = {
  "pending": "Väntar på betalning",
  "processing": "Betald, att skicka",
  "on-hold": "Väntar (on-hold)",
  "completed": "Slutförd",
  "cancelled": "Avbruten",
  "refunded": "Återbetald",
  "failed": "Betalning misslyckades",
};

const SKIP_STATUSES = new Set(["checkout-draft", "auto-draft", "trash"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Signature ---

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...sig));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// --- WooCommerce order → row ---

interface Item {
  name: string;
  variant: string | null;
  quantity: number;
  total: number;
  sku: string | null;
}

// deno-lint-ignore no-explicit-any
function toItems(order: any): Item[] {
  // deno-lint-ignore no-explicit-any
  return (order.line_items ?? []).map((li: any) => {
    const variant = (li.meta_data ?? [])
      // deno-lint-ignore no-explicit-any
      .filter((m: any) => m.display_key && !String(m.key ?? "").startsWith("_"))
      // deno-lint-ignore no-explicit-any
      .map((m: any) => String(m.display_value ?? m.value).replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(", ");
    return {
      name: li.name,
      variant: variant || null,
      quantity: Number(li.quantity ?? 0),
      total: Number(li.total ?? 0) + Number(li.total_tax ?? 0),
      sku: li.sku || null,
    };
  });
}

// deno-lint-ignore no-explicit-any
function isPaid(order: any): boolean {
  return Boolean(order.date_paid) || order.status === "processing" || order.status === "completed";
}

// deno-lint-ignore no-explicit-any
function toRow(order: any) {
  const ship = order.shipping ?? {};
  const bill = order.billing ?? {};
  const addr = ship.address_1 || ship.city ? ship : bill;
  const name = [addr.first_name || bill.first_name, addr.last_name || bill.last_name]
    .filter(Boolean).join(" ") || addr.company || bill.company || null;
  return {
    order_id: order.id,
    order_number: String(order.number ?? order.id),
    status: order.status,
    paid: isPaid(order),
    date_created: order.date_created_gmt ? `${order.date_created_gmt}Z` : order.date_created ?? null,
    date_paid: order.date_paid_gmt ? `${order.date_paid_gmt}Z` : order.date_paid ?? null,
    customer_name: name,
    email: bill.email || null,
    phone: ship.phone || bill.phone || null,
    city: addr.city || null,
    country: addr.country || null,
    shipping: ship,
    billing: bill,
    items: toItems(order),
    total: order.total != null ? Number(order.total) : null,
    currency: order.currency ?? null,
    payment_method: order.payment_method_title || order.payment_method || null,
    // deno-lint-ignore no-explicit-any
    shipping_method: (order.shipping_lines ?? []).map((s: any) => s.method_title).filter(Boolean).join(", ") || null,
    customer_note: order.customer_note || null,
    raw: order,
    updated_at: new Date().toISOString(),
  };
}

// --- Messages ---

function money(amount: number | null, currency: string | null): string {
  if (amount == null) return "?";
  const n = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2 }).format(amount);
  return currency === "SEK" || !currency ? `${n} kr` : `${n} ${currency}`;
}

function statusLine(row: ReturnType<typeof toRow>): string {
  return `${STATUS_SV[row.status] ?? row.status} (${row.status})`;
}

function orderText(headline: string, row: ReturnType<typeof toRow>): string {
  const place = [row.city, row.country].filter(Boolean).join(", ");
  const items = row.items
    .map((i) => `• ${i.quantity} × ${i.name}${i.variant && !i.name.includes(i.variant) ? ` — ${i.variant}` : ""}`)
    .join("\n");
  return [
    headline,
    `${row.customer_name ?? "Okänd kund"}${place ? `, ${place}` : ""}`,
    items,
    `Summa: ${money(row.total, row.currency)} · ${row.payment_method ?? "okänt betalsätt"}`,
    row.shipping_method ? `Frakt: ${row.shipping_method}` : null,
    `Status: ${statusLine(row)}`,
    row.customer_note ? `Notering: ${row.customer_note}` : null,
    `${SHOP_ADMIN}${row.order_id}`,
  ].filter(Boolean).join("\n");
}

async function callFunction(name: string, payload: Record<string, unknown>): Promise<void> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${name}`;
  const key = Deno.env.get("SUPABASE_ANON_KEY")!;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function notify(text: string, ivonneText: string | null): Promise<string[]> {
  const errors: string[] = [];
  try {
    await callFunction("tool-telegram", {
      action: "send_message", org_id: TELEGRAM_ORG, user_id: TELEGRAM_USER, text,
    });
  } catch (e) {
    errors.push(`telegram: ${e instanceof Error ? e.message : e}`);
  }
  if (ivonneText) {
    try {
      await callFunction("agent-messages", {
        action: "send", org_id: TELEGRAM_ORG, user_id: TELEGRAM_USER,
        from_agent: "movem-orders", from_platform: "webhook", to_agent: "ivonne",
        project: "martens-documents", message_type: "notification", priority: "high",
        title: "Ny Movem-order", topics: ["movem", "order"], content: ivonneText,
      });
    } catch (e) {
      errors.push(`agent-messages: ${e instanceof Error ? e.message : e}`);
    }
  }
  return errors;
}

// --- Handler ---

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, service: "movem-orders" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const raw = await req.text();
  const signature = req.headers.get("x-wc-webhook-signature");
  const topic = req.headers.get("x-wc-webhook-topic") ?? "";

  // WooCommerce ping when the webhook is saved: unsigned, body "webhook_id=<n>".
  if (!signature && /^webhook_id=\d+$/.test(raw.trim())) {
    console.log(`ping: ${raw.trim()}`);
    const errors = await notify(`Movem-webhooken är ansluten (${raw.trim()}). Nya ordrar kommer hit.`, null);
    return json({ ok: true, ping: true, errors });
  }

  // --- Agent reads (anon key) ---
  if (!signature) {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const allowed = [Deno.env.get("SUPABASE_ANON_KEY"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")];
    if (!bearer || !allowed.includes(bearer)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    if (body.action === "list") {
      let q = supabase.from("movem_orders")
        .select("order_id, order_number, status, paid, date_created, date_paid, customer_name, email, phone, city, country, shipping, items, total, currency, payment_method, shipping_method, customer_note, logged_at, received_at")
        .order("date_created", { ascending: false })
        .limit(Math.min(Number(body.limit ?? 50), 200));
      if (body.unlogged_only) q = q.is("logged_at", null);
      if (body.since) q = q.gte("date_created", String(body.since));
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ orders: data });
    }

    if (body.action === "mark_logged") {
      const ids = (body.order_ids as number[] | undefined) ?? [];
      if (!ids.length) return json({ error: "order_ids required" }, 400);
      const { data, error } = await supabase.from("movem_orders")
        .update({ logged_at: new Date().toISOString() }).in("order_id", ids).select("order_id");
      if (error) return json({ error: error.message }, 500);
      return json({ marked: data?.map((r) => r.order_id) ?? [] });
    }

    return json({ error: "unknown action (list | mark_logged)" }, 400);
  }

  // --- WooCommerce delivery ---
  const secret = Deno.env.get("MOVEM_WC_WEBHOOK_SECRET");
  if (!secret) {
    console.error("MOVEM_WC_WEBHOOK_SECRET is not set");
    return json({ error: "not configured" }, 500);
  }
  if (!(await verifySignature(raw, signature, secret))) {
    console.error(`bad signature, topic=${topic}`);
    return json({ error: "bad signature" }, 401);
  }

  // deno-lint-ignore no-explicit-any
  let order: any;
  try {
    order = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid json" });
  }
  if (!order?.id || SKIP_STATUSES.has(order.status)) {
    return json({ ok: true, skipped: order?.status ?? "no id" });
  }

  const row = toRow(order);
  const errors: string[] = [];

  const { data: before } = await supabase.from("movem_orders")
    .select("status, paid, modified:raw->>date_modified_gmt").eq("order_id", row.order_id).maybeSingle();

  // A retried or late delivery must not roll a newer status back.
  const stale = before?.modified && order.date_modified_gmt && order.date_modified_gmt < before.modified;
  if (stale) return json({ ok: true, order_id: row.order_id, stale: true });

  const { error: upsertError } = await supabase.from("movem_orders").upsert(row, { onConflict: "order_id" });
  if (upsertError) errors.push(`db: ${upsertError.message}`);

  const paidTag = row.paid ? "BETALD" : "OBETALD";
  const ivonneBase = `Movem #${row.order_number}, ${row.customer_name ?? "okänd kund"}, ` +
    row.items.map((i) => `${i.quantity} × ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(" + ") +
    `, ${money(row.total, row.currency)}, ${statusLine(row)}. Raden finns i movem_orders; för in den i Movem/orders.md och sätt logged_at (mark_logged).`;

  if (!before) {
    // First time we see this order: order.created, or order.updated when created was missed.
    errors.push(...await notify(orderText(`🛒 Ny Movem-order #${row.order_number} — ${paidTag}`, row), ivonneBase));
  } else if (!before.paid && row.paid) {
    errors.push(...await notify(orderText(`💰 Movem #${row.order_number} är nu betald`, row), `Nu betald: ${ivonneBase}`));
  } else if (before.status !== row.status && ["cancelled", "failed", "refunded"].includes(row.status)) {
    errors.push(...await notify(`Movem #${row.order_number}: ${statusLine(row)}\n${SHOP_ADMIN}${row.order_id}`, null));
  }

  if (errors.length) console.error(`order ${row.order_id}: ${errors.join(" | ")}`);
  return json({ ok: true, order_id: row.order_id, topic, new: !before, errors });
});
