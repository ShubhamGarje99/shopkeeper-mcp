/** Environment-driven settings for the Shopify backend. Credentials are only ever read from the environment. */

export const DEFAULT_API_VERSION = "2026-04";
export const DEFAULT_MAX_REFUND_MINOR = 100_000;

export interface ShopifySettings {
  /** e.g. "my-shop.myshopify.com" */
  shop: string;
  /** Static Admin API token (legacy custom apps, `shpat_...`). Takes precedence when set. */
  adminToken?: string;
  /** Dev Dashboard apps: exchanged for a 24-hour token via the client credentials grant. */
  clientId?: string;
  clientSecret?: string;
  apiVersion: string;
  /** When false (default), write tools refuse with WRITES_DISABLED. */
  writesEnabled: boolean;
  /** Per-refund cap in minor currency units (default 100000 = 1,000.00 in a 2-decimal currency). */
  maxRefundMinor: number;
  /** JSONL audit file for writes; stderr only when undefined. */
  auditFile: string | undefined;
}

export function resolveShopifySettings(env: NodeJS.ProcessEnv = process.env): ShopifySettings {
  const shop = env.SHOPIFY_STORE?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const adminToken = env.SHOPIFY_ADMIN_TOKEN?.trim() || undefined;
  const clientId = env.SHOPIFY_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim() || undefined;
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw new Error("SHOPIFY_STORE must be set to your <name>.myshopify.com domain.");
  }
  if (!adminToken) {
    if (!clientId && !clientSecret) {
      throw new Error("Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_ADMIN_TOKEN (legacy custom app).");
    }
    if (!clientId || !clientSecret) throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must both be set.");
  }
  const cap = env.SHOPKEEPER_MAX_REFUND_MINOR?.trim();
  const maxRefundMinor = cap ? Number(cap) : DEFAULT_MAX_REFUND_MINOR;
  if (!Number.isSafeInteger(maxRefundMinor) || maxRefundMinor <= 0) {
    throw new Error("SHOPKEEPER_MAX_REFUND_MINOR must be a positive integer.");
  }
  return {
    shop,
    adminToken,
    clientId: adminToken ? undefined : clientId,
    clientSecret: adminToken ? undefined : clientSecret,
    apiVersion: env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION,
    writesEnabled: env.SHOPKEEPER_SHOPIFY_WRITES?.trim() === "1",
    maxRefundMinor,
    auditFile: env.SHOPKEEPER_AUDIT_FILE?.trim() || undefined,
  };
}
