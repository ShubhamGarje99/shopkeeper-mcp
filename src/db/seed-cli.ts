/**
 * `npm run seed` - (re)create the SQLite database with deterministic demo data.
 * Honors SHOPKEEPER_DB; defaults to <repo>/data/shop.db.
 */
import { resolveDbPath } from "../config.js";
import { createSeededDatabase } from "./connection.js";
import { SEED_REFERENCE_NOW } from "./seed.js";

const file = resolveDbPath();
const db = createSeededDatabase(file);

const count = (table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
};

const summary = ["customers", "products", "orders", "order_items", "invoices", "refunds"]
  .map((t) => `${count(t)} ${t}`)
  .join(", ");
db.close();

console.log(`Seeded ${file}`);
console.log(`  ${summary}`);
console.log(`  Data runs through 2026-09-29; pin SHOPKEEPER_NOW=${SEED_REFERENCE_NOW} for reproducible "late/overdue" math.`);
