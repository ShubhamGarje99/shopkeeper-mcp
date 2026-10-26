import { z } from "zod";
import { defineTool, readOnlyAnnotations } from "./types.js";

export const PRODUCT_CATEGORIES = ["brewers", "grinders", "kettles", "filters", "tea", "accessories", "beans"] as const;
const SEVERITIES = ["out_of_stock", "critical", "low"] as const;

const input = z.strictObject({
  category: z.enum(PRODUCT_CATEGORIES).optional().describe("Only this product category."),
});

const output = z.object({
  alerts: z.array(
    z.object({
      product_id: z.number().int(),
      sku: z.string(),
      name: z.string(),
      category: z.string(),
      stock_qty: z.number().int(),
      reorder_threshold: z.number().int(),
      target_stock: z.number().int(),
      case_pack: z.number().int(),
      shortfall: z.number().int().describe("reorder_threshold - stock_qty"),
      suggested_reorder_qty: z
        .number()
        .int()
        .describe("Units to order to get back to target_stock, rounded up to whole case packs."),
      severity: z.enum(SEVERITIES),
    }),
  ),
  count: z.number().int(),
});

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category: string;
  stock_qty: number;
  reorder_threshold: number;
  target_stock: number;
  case_pack: number;
}

export function suggestedReorderQty(p: Pick<ProductRow, "stock_qty" | "target_stock" | "case_pack">): number {
  const needed = Math.max(0, p.target_stock - p.stock_qty);
  return Math.ceil(needed / p.case_pack) * p.case_pack;
}

function severityOf(p: ProductRow): (typeof SEVERITIES)[number] {
  if (p.stock_qty === 0) return "out_of_stock";
  if (p.stock_qty * 2 < p.reorder_threshold) return "critical";
  return "low";
}

export const lowStockAlerts = defineTool({
  name: "low_stock_alerts",
  title: "Low stock alerts",
  kind: "read",
  description:
    "Products whose stock is strictly below their reorder threshold, most urgent first, each with a suggested reorder quantity (refill to target stock, rounded up to the supplier case pack).",
  input,
  output,
  annotations: readOnlyAnnotations("Low stock alerts"),
  handler: ({ db }, { category }) => {
    const rows = (
      category
        ? db.prepare("SELECT * FROM products WHERE stock_qty < reorder_threshold AND category = ?").all(category)
        : db.prepare("SELECT * FROM products WHERE stock_qty < reorder_threshold").all()
    ) as unknown as ProductRow[];

    const rank = { out_of_stock: 0, critical: 1, low: 2 } as const;
    const alerts = rows
      .map((p) => ({
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        category: p.category,
        stock_qty: p.stock_qty,
        reorder_threshold: p.reorder_threshold,
        target_stock: p.target_stock,
        case_pack: p.case_pack,
        shortfall: p.reorder_threshold - p.stock_qty,
        suggested_reorder_qty: suggestedReorderQty(p),
        severity: severityOf(p),
      }))
      .sort(
        (a, b) =>
          rank[a.severity] - rank[b.severity] ||
          a.stock_qty / a.reorder_threshold - b.stock_qty / b.reorder_threshold ||
          a.sku.localeCompare(b.sku),
      );

    const lines = alerts.map(
      (a) =>
        `- ${a.sku} ${a.name}: ${a.stock_qty} in stock (threshold ${a.reorder_threshold}) [${a.severity}] -> reorder ${a.suggested_reorder_qty}`,
    );
    const summary =
      alerts.length === 0
        ? "No products are below their reorder threshold."
        : [`${alerts.length} product(s) below reorder threshold:`, ...lines].join("\n");
    return { data: { alerts, count: alerts.length }, summary };
  },
});
