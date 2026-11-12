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

/**
 * Minimal Shopify Admin GraphQL client. Retries throttled calls a few times,
 * and turns every failure into an UpstreamError that never contains the token.
 */
export class ShopifyClient {
  constructor(
    private readonly settings: Pick<ShopifySettings, "shop" | "adminToken" | "apiVersion">,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${this.settings.shop}/admin/api/${this.settings.apiVersion}/graphql.json`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.settings.adminToken },
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
