/**
 * Every GraphQL operation the Shopify backend sends, in one place so that
 * `npm run shopify:validate` can check each one against Shopify's published
 * Admin API schema.
 */

const MONEY = "{ shopMoney { amount currencyCode } }";

const ORDER_CORE = `
  id
  name
  createdAt
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet ${MONEY}
  subtotalPriceSet ${MONEY}
  totalShippingPriceSet ${MONEY}
  totalRefundedSet ${MONEY}
  netPaymentSet ${MONEY}
  customer { id displayName defaultEmailAddress { emailAddress } defaultAddress { city province } }
  refunds { id createdAt note totalRefundedSet ${MONEY} }
  fulfillments(first: 10) { id status displayStatus createdAt deliveredAt trackingInfo { number company } }
`;

const ORDER_DETAIL = `
  ${ORDER_CORE}
  lineItems(first: 50) { nodes { name sku quantity originalUnitPriceSet ${MONEY} } }
  transactions(first: 20) { id kind status gateway amountSet ${MONEY} }
  fulfillmentOrders(first: 10) { nodes { id status } }
`;

export const PAGE_SIZE = 50;

export const ORDER_BY_NAME = `query OrderByName($q: String!) { orders(first: 5, query: $q) { nodes { ${ORDER_DETAIL} } } }`;

export const ORDERS_PAGE = `query Orders($q: String, $after: String) {
  orders(first: ${PAGE_SIZE}, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes { ${ORDER_CORE} } pageInfo { hasNextPage endCursor }
  }
}`;

export const CUSTOMERS = `query Customers($q: String!, $n: Int!) {
  customers(first: $n, query: $q) {
    nodes { id displayName defaultEmailAddress { emailAddress } numberOfOrders amountSpent { amount currencyCode } defaultAddress { city province } lastOrder { createdAt } }
  }
}`;

export const SHOP_INFO = `query ShopInfo { shop { name myshopifyDomain currencyCode } }`;

export const MARK_PAID = `mutation MarkPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id } userErrors { field message } } }`;

export const CANCEL = `mutation Cancel($id: ID!) { orderCancel(orderId: $id, reason: OTHER, refundMethod: { originalPaymentMethodsRefund: false }, restock: true, notifyCustomer: false) { job { id } userErrors { field message } } }`;

export const FULFIL = `mutation Fulfil($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`;

export const DELIVERED = `mutation Delivered($e: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $e) { fulfillmentEvent { id status } userErrors { field message } } }`;

/**
 * Shopify requires an idempotency key on refundCreate from API 2026-04. The
 * directive sits on the mutation field; the key must be UUID-shaped.
 */
export const REFUND = `mutation Refund($input: RefundInput!, $key: String!) {
  refundCreate(input: $input) @idempotent(key: $key) { refund { id createdAt } userErrors { field message } }
}`;

export const ALL_OPERATIONS: Readonly<Record<string, string>> = {
  ORDER_BY_NAME,
  ORDERS_PAGE,
  CUSTOMERS,
  SHOP_INFO,
  MARK_PAID,
  CANCEL,
  FULFIL,
  DELIVERED,
  REFUND,
};
