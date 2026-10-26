import type { DatabaseSync } from "node:sqlite";

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * All money columns are INTEGER cents. Timestamps are ISO-8601 UTC strings
 * ("2026-09-30T18:00:00Z"); calendar dates are "YYYY-MM-DD".
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  city        TEXT    NOT NULL,
  region      TEXT    NOT NULL,
  country     TEXT    NOT NULL DEFAULT 'US',
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY,
  sku                TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  category           TEXT    NOT NULL,
  price_cents        INTEGER NOT NULL CHECK (price_cents >= 0),
  stock_qty          INTEGER NOT NULL CHECK (stock_qty >= 0),
  reorder_threshold  INTEGER NOT NULL CHECK (reorder_threshold >= 0),
  target_stock       INTEGER NOT NULL CHECK (target_stock >= reorder_threshold),
  case_pack          INTEGER NOT NULL CHECK (case_pack > 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id                      INTEGER PRIMARY KEY,
  customer_id             INTEGER NOT NULL REFERENCES customers(id),
  status                  TEXT    NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),
  placed_at               TEXT    NOT NULL,
  paid_at                 TEXT,
  shipped_at              TEXT,
  delivered_at            TEXT,
  cancelled_at            TEXT,
  promised_delivery_date  TEXT    NOT NULL,
  shipping_method         TEXT    NOT NULL CHECK (shipping_method IN ('standard','express')),
  subtotal_cents          INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents          INTEGER NOT NULL CHECK (shipping_cents >= 0),
  total_cents             INTEGER NOT NULL CHECK (total_cents = subtotal_cents + shipping_cents),
  updated_at              TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY,
  invoice_number  TEXT    NOT NULL UNIQUE,
  order_id        INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  issued_at       TEXT    NOT NULL,
  due_date        TEXT    NOT NULL,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS refunds (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  reason           TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  idempotency_key  TEXT    NOT NULL UNIQUE,
  created_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  details    TEXT NOT NULL
);
`;

export const ALL_TABLES = [
  "customers",
  "products",
  "orders",
  "order_items",
  "invoices",
  "refunds",
  "audit_log",
] as const;
export type TableName = (typeof ALL_TABLES)[number];

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
