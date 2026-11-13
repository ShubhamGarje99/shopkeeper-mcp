import { UpstreamError } from "../errors.js";
import type { ShopifySettings } from "./config.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/** Refresh a client-credentials token this long before Shopify says it expires. */
const TOKEN_SAFETY_MS = 60_000;

/**
 * Minimal Shopify Admin GraphQL client. Retries throttled calls a few times,
 * and turns every failure into an UpstreamError that never contains a credential.
 *
 * Auth: a static `adminToken`, or a Dev Dashboard app's client ID + secret,
 * exchanged for a 24-hour token (client credentials grant), cached, and
 * refreshed shortly before expiry or once after a 401.
 */
export class ShopifyClient {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly settings: Pick<ShopifySettings, "shop" | "adminToken" | "clientId" | "clientSecret" | "apiVersion">,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(forceRefresh = false): Promise<string> {
    if (this.settings.adminToken) return this.settings.adminToken;
    if (!forceRefresh && this.cached && this.now() < this.cached.expiresAt) return this.cached.token;
    const { clientId, clientSecret } = this.settings;
    if (!clientId || !clientSecret) {
      throw new UpstreamError("SHOPIFY_AUTH_NOT_CONFIGURED", "No Shopify credentials are configured.", {});
    }
    let res;
    try {
      res = await this.fetchImpl(`https://${this.settings.shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
      });
    } catch {
      throw new UpstreamError("SHOPIFY_NETWORK_ERROR", "Could not reach Shopify to get an access token.", { shop: this.settings.shop });
    }
    const text = await res.text();
    let body: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // non-JSON error page; handled below
    }
    if (!res.ok || !body.access_token) {
      const hint =
        body.error === "shop_not_permitted"
          ? " The app and the store must belong to the same Shopify organization (Dev Dashboard)."
          : res.status === 400 || res.status === 401
            ? " Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, and that the app is installed on this store."
            : "";
      throw new UpstreamError("SHOPIFY_TOKEN_EXCHANGE_FAILED", `Shopify did not issue an access token (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}).${hint}`, {
        status: res.status,
        error: body.error ?? null,
      });
    }
    const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : 86_399) * 1000;
    this.cached = { token: body.access_token, expiresAt: this.now() + Math.max(0, lifetimeMs - TOKEN_SAFETY_MS) };
    return body.access_token;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${this.settings.shop}/admin/api/${this.settings.apiVersion}/graphql.json`;
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.accessToken();
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        throw new UpstreamError("SHOPIFY_NETWORK_ERROR", "Could not reach the Shopify Admin API.", { shop: this.settings.shop });
      }
      if (res.status === 429 && attempt < 3) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (res.status === 401 && !this.settings.adminToken && !refreshed) {
        // Cached client-credentials token was revoked or expired early: get a fresh one once.
        refreshed = true;
        await this.accessToken(true);
        attempt--;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new UpstreamError("SHOPIFY_AUTH_FAILED", "Shopify rejected the access token or the app lacks permission (check the token and its scopes).", { status: res.status });
      }
      if (!res.ok) {
        throw new UpstreamError("SHOPIFY_HTTP_ERROR", `Shopify returned HTTP ${res.status}.`, { status: res.status });
      }
      let body: GraphQlResponse<T>;
      try {
        body = JSON.parse(text) as GraphQlResponse<T>;
      } catch {
        throw new UpstreamError("SHOPIFY_BAD_RESPONSE", "Shopify returned a response that is not JSON.", {});
      }
      if (body.errors?.length) {
        const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < 3) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new UpstreamError("SHOPIFY_GRAPHQL_ERROR", `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`, {});
      }
      if (!body.data) throw new UpstreamError("SHOPIFY_BAD_RESPONSE", "Shopify returned no data.", {});
      return body.data;
    }
    throw new UpstreamError("SHOPIFY_THROTTLED", "Shopify kept throttling the request. Try again shortly.", {});
  }
}
