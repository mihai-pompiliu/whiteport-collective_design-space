-- 033: movem_orders — orders from movem.dance (WooCommerce), written by the
-- movem-orders edge function when WooCommerce fires its order webhooks.
--
-- Mårten's morning email triage (email-triage Step 1a) reads this table first
-- instead of hunting for "[Movem Live]: New order" mails in Gmail.
--
-- The rows hold customer addresses, phone numbers and emails. RLS is on with
-- no policies, so the anon key cannot read the table through PostgREST. Reads
-- go through the movem-orders function (action "list"), which uses the
-- service role.

CREATE TABLE IF NOT EXISTS movem_orders (
  order_id        bigint      PRIMARY KEY,      -- WooCommerce order id
  order_number    text        NOT NULL,         -- what the customer sees (#29007)

  status          text        NOT NULL,         -- pending, processing, on-hold, completed, cancelled …
  paid            boolean     NOT NULL DEFAULT false,
  date_created    timestamptz,
  date_paid       timestamptz,

  customer_name   text,
  email           text,
  phone           text,
  city            text,
  country         text,
  shipping        jsonb,                        -- full shipping address from WooCommerce
  billing         jsonb,                        -- full billing address from WooCommerce

  -- [{name, variant, quantity, total, sku}]
  items           jsonb       NOT NULL DEFAULT '[]',
  total           numeric(12,2),
  currency        text,
  payment_method  text,                         -- payment_method_title, e.g. "Pay by invoice"
  shipping_method text,
  customer_note   text,

  -- Set by the triage when the order has been written into Movem/orders.md
  logged_at       timestamptz,

  raw             jsonb,                        -- the last webhook payload as received
  received_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS movem_orders_unlogged_idx
  ON movem_orders (date_created DESC) WHERE logged_at IS NULL;

ALTER TABLE movem_orders ENABLE ROW LEVEL SECURITY;
