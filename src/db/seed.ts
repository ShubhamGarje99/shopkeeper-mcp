/**
 * Deterministic seed for "Kettle & Crema", a FAKE specialty coffee & tea gear
 * shop. Every name, email (example.com) and address below is invented.
 *
 * The bulk of the data comes from a fixed-seed PRNG; a handful of orders are
 * then pinned (FIXTURES) so the eval scenarios and tests can rely on exact
 * situations: a late delivery, an already-refunded order, look-alike customer
 * names, stock below its reorder threshold, and so on. Re-running the seed
 * always produces byte-identical data.
 */
import type { DatabaseSync } from "node:sqlite";
import { isoDate, isoTimestamp } from "../clock.js";

/** The seed's "today". Evals and tests pin SHOPKEEPER_NOW to this value. */
export const SEED_REFERENCE_NOW = "2026-09-30T18:00:00Z";
const NOW_MS = Date.parse(SEED_REFERENCE_NOW);
const DAY = 86_400_000;
const MIN = 60_000;

/** Order IDs / customer IDs with a guaranteed situation. Tests assert every one. */
export const FIXTURES = {
  smallDeliveredOrder: 1010, // total $58.95, delivered, no refunds ("refund $500" must be refused)
  invoicedOrder: 1020, // delivered and already invoiced (duplicate invoice must be refused)
  lateDelivery: 1042, // delivered 3 days after the promised date, no refunds yet
  onTimeDelivery: 1043, // delivered 3 days early
  fullyRefunded: 1077, // status "refunded", refund total == order total
  standardShippingOrder: 1088, // delivered, $7.95 shipping charge, no refunds
  goodwillRefund: { orderId: 1095, idempotencyKey: "goodwill-1095-a", amountCents: 1000 },
  awaitingShipment: 1107, // paid, not shipped
  paidNotShipped: 1131, // paid, not shipped
  paidUninvoiced: 1150, // paid, no invoice yet
  pendingUnpaid: 1180, // pending (unpaid) - cannot jump to delivered
  augustLateDeliveries: [1158, 1169],
  ambiguousName: "Morgan Ellis", // two different customers share this exact name
  ambiguousCustomers: { portland: 35, brooklyn: 36 },
  ambiguousPendingOrders: { 35: 1190, 36: 1193 },
  priyaDenver: { customerId: 37, email: "priya.shah@example.com", orderCount: 7 },
  priyaSeattle: { customerId: 38, email: "priya.s.shah@example.com", orderCount: 4 },
  lookAlikeNames: ["John Bennett", "Jon Bennet"],
  atThresholdProductSku: "KC-KTL-002", // stock == threshold: NOT below it
} as const;

// ---------------------------------------------------------------------------
// PRNG (mulberry32) - tiny, fast, and identical on every platform.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("pick() from empty list");
    return item;
  }
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
type CustomerSeed = [name: string, email: string, city: string, region: string];

const CUSTOMERS: CustomerSeed[] = [
  ["Maya Thompson", "maya.thompson@example.com", "Portland", "OR"],
  ["Diego Alvarez", "diego.alvarez@example.com", "Austin", "TX"],
  ["Hannah Okafor", "hannah.okafor@example.com", "Chicago", "IL"],
  ["Liam O'Connor", "liam.oconnor@example.com", "Boston", "MA"],
  ["Mei Lin Chen", "meilin.chen@example.com", "San Francisco", "CA"],
  ["Arjun Mehta", "arjun.mehta@example.com", "Jersey City", "NJ"],
  ["Sofia Rossi", "sofia.rossi@example.com", "Philadelphia", "PA"],
  ["Noah Fischer", "noah.fischer@example.com", "Minneapolis", "MN"],
  ["Aisha Bello", "aisha.bello@example.com", "Atlanta", "GA"],
  ["Ethan Walker", "ethan.walker@example.com", "Denver", "CO"],
  ["Chloe Dubois", "chloe.dubois@example.com", "New Orleans", "LA"],
  ["Kenji Watanabe", "kenji.watanabe@example.com", "San Jose", "CA"],
  ["Fatima Haddad", "fatima.haddad@example.com", "Dearborn", "MI"],
  ["Lucas Silva", "lucas.silva@example.com", "Miami", "FL"],
  ["Grace Kim", "grace.kim@example.com", "Seattle", "WA"],
  ["Omar Farouk", "omar.farouk@example.com", "Houston", "TX"],
  ["Isabella Moreno", "isabella.moreno@example.com", "Phoenix", "AZ"],
  ["Ryan Patel", "ryan.patel@example.com", "Raleigh", "NC"],
  ["Zoe Anderson", "zoe.anderson@example.com", "Madison", "WI"],
  ["Mateo Garcia", "mateo.garcia@example.com", "San Diego", "CA"],
  ["Nadia Petrova", "nadia.petrova@example.com", "Brooklyn", "NY"],
  ["Ben Carter", "ben.carter@example.com", "Nashville", "TN"],
  ["Leila Nasser", "leila.nasser@example.com", "Columbus", "OH"],
  ["Tomás Herrera", "tomas.herrera@example.com", "Albuquerque", "NM"],
  ["Emily Nguyen", "emily.nguyen@example.com", "Sacramento", "CA"],
  ["Daniel Cohen", "daniel.cohen@example.com", "Pittsburgh", "PA"],
  ["Ava Martinez", "ava.martinez@example.com", "Tucson", "AZ"],
  ["Samuel Osei", "samuel.osei@example.com", "Baltimore", "MD"],
  ["Julia Novak", "julia.novak@example.com", "Cleveland", "OH"],
  ["Kai Nakamura", "kai.nakamura@example.com", "Honolulu", "HI"],
  ["Rosa Delgado", "rosa.delgado@example.com", "El Paso", "TX"],
  ["Victor Hughes", "victor.hughes@example.com", "Richmond", "VA"],
  ["Ingrid Larsen", "ingrid.larsen@example.com", "Salt Lake City", "UT"],
  ["Marcus Reid", "marcus.reid@example.com", "Kansas City", "MO"],
  ["Morgan Ellis", "morgan.ellis@example.com", "Portland", "OR"], // 35: ambiguous #1
  ["Morgan Ellis", "mellis.studio@example.com", "Brooklyn", "NY"], // 36: ambiguous #2
  ["Priya Shah", "priya.shah@example.com", "Denver", "CO"], // 37
  ["Priya Shah", "priya.s.shah@example.com", "Seattle", "WA"], // 38
  ["John Bennett", "john.bennett@example.com", "Providence", "RI"], // 39: look-alike
  ["Jon Bennet", "jon.bennet@example.com", "Hartford", "CT"], // 40: look-alike
];

type ProductSeed = [
  sku: string,
  name: string,
  category: string,
  priceCents: number,
  stock: number,
  threshold: number,
  target: number,
  casePack: number,
];

const PRODUCTS: ProductSeed[] = [
  ["KC-BRW-001", "Pour-Over Dripper (Ceramic, Size 02)", "brewers", 2800, 42, 15, 60, 6],
  ["KC-BRW-002", "Glass Carafe Brewer 6-Cup", "brewers", 4500, 18, 10, 30, 6],
  ["KC-BRW-003", "French Press 1L (Stainless)", "brewers", 3950, 7, 12, 36, 6], // LOW
  ["KC-BRW-004", "Travel Immersion Brewer", "brewers", 3400, 25, 10, 40, 10],
  ["KC-BRW-005", "Cold Brew Tower 8-Cup", "brewers", 12900, 3, 4, 10, 2], // LOW
  ["KC-BRW-006", "Stovetop Moka Pot 6-Cup", "brewers", 3200, 22, 10, 36, 6],
  ["KC-GRD-001", "Hand Grinder (Steel Burr)", "grinders", 8900, 14, 8, 24, 4],
  ["KC-GRD-002", "Electric Burr Grinder Pro", "grinders", 24900, 6, 5, 12, 2],
  ["KC-GRD-003", "Grinder Brush & Cleaning Kit", "grinders", 1400, 0, 10, 40, 10], // OUT OF STOCK
  ["KC-KTL-001", "Gooseneck Kettle 1L (Stovetop)", "kettles", 4200, 20, 8, 30, 6],
  ["KC-KTL-002", "Electric Gooseneck Kettle (Temp Control)", "kettles", 11900, 9, 9, 24, 4], // AT threshold
  ["KC-KTL-003", "Enamel Tea Kettle 1.5L", "kettles", 5500, 12, 6, 20, 4],
  ["KC-FLT-001", "Paper Filters Size 02 (100ct)", "filters", 750, 140, 60, 300, 50],
  ["KC-FLT-002", "Paper Filters Flat-Bottom (100ct)", "filters", 800, 35, 50, 250, 50], // LOW
  ["KC-FLT-003", "Reusable Metal Mesh Filter", "filters", 1800, 30, 10, 40, 10],
  ["KC-FLT-004", "Cloth Filters (3-pack)", "filters", 1200, 26, 12, 48, 12],
  ["KC-TEA-001", "Sencha Green Tea 100g", "tea", 1600, 48, 20, 80, 10],
  ["KC-TEA-002", "First Flush Darjeeling 100g", "tea", 2400, 11, 15, 50, 10], // LOW
  ["KC-TEA-003", "Hojicha Roasted Green Tea 100g", "tea", 1500, 33, 15, 60, 10],
  ["KC-TEA-004", "Ceremonial Matcha 30g", "tea", 3200, 21, 12, 48, 12],
  ["KC-TEA-005", "Chamomile Blossoms 50g", "tea", 1100, 40, 15, 60, 10],
  ["KC-TEA-006", "Masala Chai Blend 200g", "tea", 1450, 27, 15, 60, 10],
  ["KC-ACC-001", "Digital Coffee Scale (0.1g)", "accessories", 3600, 19, 8, 30, 6],
  ["KC-ACC-002", "Double-Wall Glass Mug 350ml", "accessories", 1900, 64, 24, 96, 12],
  ["KC-ACC-003", "Ceramic Tasting Cups (Set of 4)", "accessories", 2600, 15, 8, 30, 6],
  ["KC-ACC-004", "Milk Frothing Pitcher 600ml", "accessories", 2100, 17, 8, 30, 6],
  ["KC-ACC-005", "Bamboo Tea Whisk (Chasen)", "accessories", 1700, 23, 10, 40, 10],
  ["KC-ACC-006", "Cast Iron Teapot 800ml", "accessories", 6400, 10, 6, 18, 3],
  ["KC-BNS-001", "House Espresso Blend 1kg", "beans", 3800, 45, 20, 80, 10],
  ["KC-BNS-002", "Single Origin Ethiopia 250g", "beans", 1850, 9, 20, 60, 12], // LOW
];

const FULL_REFUND_REASONS = ["Returned unopened - customer changed mind", "Arrived damaged - full refund"];
const PARTIAL_REFUND_REASONS = [
  "Missing item in package",
  "Price adjustment - promo code not applied",
  "Shipping fee refunded as goodwill",
  "Minor cosmetic damage - partial refund",
];

// ---------------------------------------------------------------------------
// Order drafts
// ---------------------------------------------------------------------------
type Plan = "auto" | "pending" | "paid" | "delivered" | "refund_full" | "refund_partial" | "cancelled";

interface ItemDraft {
  productIndex: number; // 0-based index into PRODUCTS
  quantity: number;
}

interface OrderDraft {
  id: number;
  customerId: number;
  placedMs: number;
  paidDelayMin: number;
  express: boolean;
  items: ItemDraft[];
  shipLagDays: number;
  transitDays: number;
  delayDays: number;
  plan: Plan;
  refundRollPct: number;
  refundReasonIdx: number;
}

interface OrderRow {
  id: number;
  customer_id: number;
  status: string;
  placed_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  promised_delivery_date: string;
  shipping_method: "standard" | "express";
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  updated_at: string;
}

interface RefundRow {
  order_id: number;
  amount_cents: number;
  reason: string;
  idempotency_key: string;
  created_at: string;
}

const FIRST_ORDER_ID = 1001;
const ORDER_COUNT = 200;
const START_UTC = Date.UTC(2026, 1, 2); // 2026-02-02
const SPAN_DAYS = 239; // last order placed 2026-09-29

const SPECIAL_CUSTOMER_ORDERS: Record<number, number> = {
  1056: 35,
  1190: 35,
  1121: 36,
  1193: 36,
  1015: 37,
  1048: 37,
  1083: 37,
  1112: 37,
  1139: 37,
  1166: 37,
  1185: 37,
  1031: 38,
  1099: 38,
  1144: 38,
  1172: 38,
};
const RANDOM_CUSTOMER_POOL = [...Array.from({ length: 34 }, (_, i) => i + 1), 39, 40];

const PINNED_ORDER_IDS = new Set<number>([
  FIXTURES.smallDeliveredOrder,
  FIXTURES.invoicedOrder,
  FIXTURES.lateDelivery,
  FIXTURES.onTimeDelivery,
  FIXTURES.fullyRefunded,
  FIXTURES.standardShippingOrder,
  FIXTURES.goodwillRefund.orderId,
  FIXTURES.awaitingShipment,
  FIXTURES.paidNotShipped,
  FIXTURES.paidUninvoiced,
  FIXTURES.pendingUnpaid,
  ...FIXTURES.augustLateDeliveries,
  1190,
  1193,
]);

function productIndexBySku(sku: string): number {
  const idx = PRODUCTS.findIndex((p) => p[0] === sku);
  if (idx < 0) throw new Error(`Unknown SKU in seed: ${sku}`);
  return idx;
}

function draftOrders(rng: Rng): OrderDraft[] {
  const drafts: OrderDraft[] = [];
  for (let i = 0; i < ORDER_COUNT; i++) {
    const id = FIRST_ORDER_ID + i;
    const dayOffset = Math.floor((i * SPAN_DAYS) / (ORDER_COUNT - 1));
    const placedMs = START_UTC + dayOffset * DAY + rng.int(7, 21) * 3_600_000 + rng.int(0, 59) * MIN + rng.int(0, 59) * 1000;
    const customerFromPool = rng.pick(RANDOM_CUSTOMER_POOL);

    const itemCountRoll = rng.float();
    const itemCount = itemCountRoll < 0.4 ? 1 : itemCountRoll < 0.75 ? 2 : itemCountRoll < 0.93 ? 3 : 4;
    const items: ItemDraft[] = [];
    const used = new Set<number>();
    while (items.length < itemCount) {
      const productIndex = rng.int(0, PRODUCTS.length - 1);
      const qtyRoll = rng.float();
      if (used.has(productIndex)) continue;
      used.add(productIndex);
      items.push({ productIndex, quantity: qtyRoll < 0.7 ? 1 : qtyRoll < 0.92 ? 2 : 3 });
    }

    const express = rng.float() < 0.15;
    const shipLagDays = express ? 1 : rng.int(1, 2);
    const transitDays = express ? rng.int(1, 2) : rng.int(2, 4);
    const delayDays = rng.float() < 0.15 ? rng.int(1, 4) : 0;
    const outcomeRoll = rng.float();
    const pendingRoll = rng.float();
    const refundRollPct = rng.int(10, 35);
    const refundReasonIdx = rng.int(0, 3);
    const paidDelayMin = rng.int(2, 90);

    const ageMs = NOW_MS - placedMs;
    let plan: Plan = "auto";
    if (outcomeRoll < 0.04 && ageMs > 2 * DAY) plan = "cancelled";
    else if (ageMs < 2.5 * DAY && pendingRoll < 0.3) plan = "pending";
    else if (outcomeRoll >= 0.04 && outcomeRoll < 0.07) plan = "refund_full";
    else if (outcomeRoll >= 0.07 && outcomeRoll < 0.11) plan = "refund_partial";

    drafts.push({
      id,
      customerId: SPECIAL_CUSTOMER_ORDERS[id] ?? customerFromPool,
      placedMs,
      paidDelayMin,
      express,
      items,
      shipLagDays,
      transitDays,
      delayDays,
      plan,
      refundRollPct,
      refundReasonIdx,
    });
  }
  return drafts;
}

/** Pin the fixture orders. Runs after random drafting so PRNG output is unaffected. */
function applyFixtures(drafts: OrderDraft[]): void {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const pin = (id: number, patch: Partial<OrderDraft>) => {
    const d = byId.get(id);
    if (!d) throw new Error(`Fixture order ${id} missing`);
    Object.assign(d, patch);
  };
  const items = (...spec: Array<[string, number]>): ItemDraft[] =>
    spec.map(([sku, quantity]) => ({ productIndex: productIndexBySku(sku), quantity }));
  const onTime = { express: false, shipLagDays: 1, transitDays: 3, delayDays: 0 };

  // All non-pinned plans are "auto" (lifecycle by age) or random refunds/cancellations;
  // pinned orders never get random outcomes.
  for (const id of PINNED_ORDER_IDS) pin(id, { plan: "auto" });

  pin(FIXTURES.smallDeliveredOrder, { ...onTime, plan: "delivered", items: items(["KC-ACC-001", 1], ["KC-FLT-001", 2]) });
  pin(FIXTURES.invoicedOrder, { ...onTime, plan: "delivered" });
  // Promised placed+7; delivered placed+2+4+4 = placed+10 -> 3 days late.
  pin(FIXTURES.lateDelivery, {
    express: false,
    shipLagDays: 2,
    transitDays: 4,
    delayDays: 4,
    plan: "delivered",
    items: items(["KC-GRD-001", 1], ["KC-TEA-001", 1]),
  });
  pin(FIXTURES.onTimeDelivery, { ...onTime, plan: "delivered" });
  pin(FIXTURES.fullyRefunded, {
    ...onTime,
    plan: "refund_full",
    refundReasonIdx: 1,
    items: items(["KC-ACC-002", 2], ["KC-ACC-003", 1]),
  });
  pin(FIXTURES.standardShippingOrder, {
    ...onTime,
    plan: "delivered",
    items: items(["KC-FLT-004", 1], ["KC-TEA-005", 2]),
  });
  pin(FIXTURES.goodwillRefund.orderId, { ...onTime, plan: "delivered" });
  pin(FIXTURES.awaitingShipment, { plan: "paid" });
  pin(FIXTURES.paidNotShipped, { plan: "paid" });
  pin(FIXTURES.paidUninvoiced, { plan: "paid" });
  pin(FIXTURES.pendingUnpaid, { plan: "pending" });
  pin(1190, { plan: "pending" });
  pin(1193, { plan: "pending" });
  // Promised placed+7; delivered placed+2+3+4 = placed+9 -> 2 days late.
  pin(1158, { express: false, shipLagDays: 2, transitDays: 3, delayDays: 4, plan: "delivered" });
  // Promised placed+7; delivered placed+1+4+4 = placed+9 -> 2 days late.
  pin(1169, { express: false, shipLagDays: 1, transitDays: 4, delayDays: 4, plan: "delivered" });
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

function materialize(d: OrderDraft): { order: OrderRow; items: ItemDraft[]; refunds: RefundRow[] } {
  const subtotal = d.items.reduce((sum, it) => sum + (PRODUCTS[it.productIndex]?.[3] ?? 0) * it.quantity, 0);
  const shipping = d.express ? 1495 : subtotal >= 7500 ? 0 : 795;
  const total = subtotal + shipping;
  const placedDay = startOfUtcDay(d.placedMs);
  const promised = isoDate(new Date(placedDay + (d.express ? 3 : 7) * DAY));

  // Deterministic intra-day times derived from the order id.
  const paidMs = d.placedMs + d.paidDelayMin * MIN;
  const shippedMs = placedDay + d.shipLagDays * DAY + (9 + (d.id % 8)) * 3_600_000 + (d.id % 47) * MIN;
  const deliveredMs =
    placedDay + (d.shipLagDays + d.transitDays + d.delayDays) * DAY + (10 + (d.id % 9)) * 3_600_000 + (d.id % 53) * MIN;

  const order: OrderRow = {
    id: d.id,
    customer_id: d.customerId,
    status: "pending",
    placed_at: isoTimestamp(new Date(d.placedMs)),
    paid_at: null,
    shipped_at: null,
    delivered_at: null,
    cancelled_at: null,
    promised_delivery_date: promised,
    shipping_method: d.express ? "express" : "standard",
    subtotal_cents: subtotal,
    shipping_cents: shipping,
    total_cents: total,
    updated_at: isoTimestamp(new Date(d.placedMs)),
  };
  const refunds: RefundRow[] = [];

  if (d.plan === "pending") {
    return { order, items: d.items, refunds };
  }
  if (d.plan === "cancelled") {
    const cancelledMs = d.placedMs + 26 * 3_600_000;
    order.status = "cancelled";
    order.cancelled_at = isoTimestamp(new Date(cancelledMs));
    order.updated_at = order.cancelled_at;
    return { order, items: d.items, refunds };
  }

  order.status = "paid";
  order.paid_at = isoTimestamp(new Date(paidMs));
  order.updated_at = order.paid_at;
  if (d.plan === "paid") return { order, items: d.items, refunds };

  if (shippedMs <= NOW_MS) {
    order.status = "shipped";
    order.shipped_at = isoTimestamp(new Date(shippedMs));
    order.updated_at = order.shipped_at;
  }
  if (deliveredMs <= NOW_MS) {
    order.status = "delivered";
    order.delivered_at = isoTimestamp(new Date(deliveredMs));
    order.updated_at = order.delivered_at;
  }
  if (order.status !== "delivered") return { order, items: d.items, refunds };

  if (d.plan === "refund_full") {
    const refundMs = deliveredMs + (2 + (d.id % 4)) * DAY;
    if (refundMs <= NOW_MS) {
      const reason =
        d.id === FIXTURES.fullyRefunded
          ? "Arrived damaged - mug cracked in transit"
          : (FULL_REFUND_REASONS[d.refundReasonIdx % FULL_REFUND_REASONS.length] ?? "Full refund");
      refunds.push({
        order_id: d.id,
        amount_cents: total,
        reason,
        idempotency_key: `seed-rf-${d.id}-1`,
        created_at: isoTimestamp(new Date(refundMs)),
      });
      order.status = "refunded";
      order.updated_at = isoTimestamp(new Date(refundMs));
    }
  } else if (d.plan === "refund_partial") {
    const refundMs = deliveredMs + (1 + (d.id % 3)) * DAY;
    if (refundMs <= NOW_MS) {
      const reason = PARTIAL_REFUND_REASONS[d.refundReasonIdx % PARTIAL_REFUND_REASONS.length] ?? "Partial refund";
      const amount =
        reason.startsWith("Shipping") && shipping > 0 ? shipping : Math.max(100, Math.floor((total * d.refundRollPct) / 100));
      refunds.push({
        order_id: d.id,
        amount_cents: Math.min(amount, total - 1),
        reason,
        idempotency_key: `seed-rf-${d.id}-1`,
        created_at: isoTimestamp(new Date(refundMs)),
      });
    }
  }

  if (d.id === FIXTURES.goodwillRefund.orderId) {
    refunds.push({
      order_id: d.id,
      amount_cents: FIXTURES.goodwillRefund.amountCents,
      reason: "Goodwill credit for slow support reply",
      idempotency_key: FIXTURES.goodwillRefund.idempotencyKey,
      created_at: isoTimestamp(new Date(deliveredMs + 2 * DAY)),
    });
  }

  return { order, items: d.items, refunds };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export const SEED_PRNG_SEED = 20260930;

export function seedDatabase(db: DatabaseSync): void {
  const rng = new Rng(SEED_PRNG_SEED);
  db.exec("BEGIN");
  try {
    const insertCustomer = db.prepare(
      "INSERT INTO customers (id, name, email, city, region, country, created_at) VALUES (?, ?, ?, ?, ?, 'US', ?)",
    );
    CUSTOMERS.forEach(([name, email, city, region], i) => {
      const created = isoTimestamp(new Date(Date.UTC(2025, 0, 6) + i * 6 * DAY + (i % 7) * 3_600_000));
      insertCustomer.run(i + 1, name, email, city, region, created);
    });

    const insertProduct = db.prepare(
      `INSERT INTO products (id, sku, name, category, price_cents, stock_qty, reorder_threshold, target_stock, case_pack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    PRODUCTS.forEach(([sku, name, category, price, stock, threshold, target, casePack], i) => {
      insertProduct.run(i + 1, sku, name, category, price, stock, threshold, target, casePack);
    });

    const drafts = draftOrders(rng);
    applyFixtures(drafts);

    const insertOrder = db.prepare(
      `INSERT INTO orders (id, customer_id, status, placed_at, paid_at, shipped_at, delivered_at, cancelled_at,
         promised_delivery_date, shipping_method, subtotal_cents, shipping_cents, total_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = db.prepare(
      "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)",
    );
    const insertRefund = db.prepare(
      "INSERT INTO refunds (order_id, amount_cents, reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertInvoice = db.prepare(
      "INSERT INTO invoices (invoice_number, order_id, amount_cents, issued_at, due_date, notes) VALUES (?, ?, ?, ?, ?, NULL)",
    );

    const invoiceCutoffMs = NOW_MS - 5 * DAY; // the nightly invoice batch lags a few days
    for (const draft of drafts) {
      const { order, items, refunds } = materialize(draft);
      insertOrder.run(
        order.id,
        order.customer_id,
        order.status,
        order.placed_at,
        order.paid_at,
        order.shipped_at,
        order.delivered_at,
        order.cancelled_at,
        order.promised_delivery_date,
        order.shipping_method,
        order.subtotal_cents,
        order.shipping_cents,
        order.total_cents,
        order.updated_at,
      );
      for (const it of items) {
        const product = PRODUCTS[it.productIndex];
        if (!product) throw new Error("bad product index");
        insertItem.run(order.id, it.productIndex + 1, it.quantity, product[3]);
      }
      for (const r of refunds) insertRefund.run(r.order_id, r.amount_cents, r.reason, r.idempotency_key, r.created_at);

      const invoiceable =
        order.paid_at !== null && order.id !== FIXTURES.paidUninvoiced && Date.parse(order.placed_at) < invoiceCutoffMs;
      if (invoiceable && order.paid_at) {
        insertInvoice.run(
          `INV-2026-${order.id}`,
          order.id,
          order.total_cents,
          order.paid_at,
          order.paid_at.slice(0, 10),
        );
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
