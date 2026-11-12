/**
 * Validate every Shopify operation against Shopify's published Admin GraphQL
 * schema (public docs endpoint; no store or token needed), plus the shapes of
 * the input objects the mutations send.
 *   npm run shopify:validate [-- --version 2026-04] [--schema <introspection.json>]
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { buildClientSchema, getIntrospectionQuery, isInputObjectType, parse, validate, type GraphQLSchema } from "graphql";
import { DEFAULT_API_VERSION } from "../src/shopify/config.js";
import { ALL_OPERATIONS } from "../src/shopify/operations.js";

/** Input-object fields the code actually sets, checked against the schema. */
const INPUT_FIELDS: Record<string, string[]> = {
  OrderMarkAsPaidInput: ["id"],
  RefundInput: ["orderId", "notify", "note", "transactions", "allowOverRefunding"],
  OrderTransactionInput: ["orderId", "parentId", "amount", "kind", "gateway"],
  FulfillmentInput: ["notifyCustomer", "lineItemsByFulfillmentOrder"],
  FulfillmentOrderLineItemsInput: ["fulfillmentOrderId"],
  FulfillmentEventInput: ["fulfillmentId", "status"],
};
const ENUM_VALUES: Record<string, string[]> = {
  OrderTransactionKind: ["REFUND", "SALE", "CAPTURE"],
  FulfillmentEventStatus: ["DELIVERED"],
  OrderDisplayFinancialStatus: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED", "PENDING", "AUTHORIZED"],
  FulfillmentStatus: ["SUCCESS", "CANCELLED", "ERROR", "FAILURE"],
  FulfillmentDisplayStatus: ["DELIVERED", "FULFILLED"],
  FulfillmentOrderStatus: ["OPEN", "IN_PROGRESS"],
  OrderTransactionStatus: ["SUCCESS"],
};

async function loadSchema(version: string, file: string | undefined): Promise<GraphQLSchema> {
  let text: string;
  if (file) text = fs.readFileSync(file, "utf8");
  else {
    const res = await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${version}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    if (!res.ok) throw new Error(`Schema endpoint returned HTTP ${res.status} for version ${version}`);
    text = await res.text();
  }
  // assumeValid: Shopify's own schema trips strict SDL lint rules that do not affect query validation.
  return buildClientSchema((JSON.parse(text) as { data: never }).data, { assumeValid: true });
}

const { values } = parseArgs({ options: { version: { type: "string" }, schema: { type: "string" } } });
const version = values.version ?? DEFAULT_API_VERSION;
const schema = await loadSchema(version, values.schema);
let problems = 0;
const warn: string[] = [];

for (const [name, doc] of Object.entries(ALL_OPERATIONS)) {
  const errors = validate(schema, parse(doc));
  if (errors.length === 0) console.log(`ok    ${name}`);
  for (const e of errors) {
    problems++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
for (const [typeName, fields] of Object.entries(INPUT_FIELDS)) {
  const t = schema.getType(typeName);
  if (!isInputObjectType(t)) {
    problems++;
    console.log(`FAIL  input type ${typeName} does not exist`);
    continue;
  }
  const defined = t.getFields();
  const missing = fields.filter((f) => !defined[f]);
  const requiredUnset = Object.values(defined).filter((f) => String(f.type).endsWith("!") && f.defaultValue === undefined && !fields.includes(f.name)).map((f) => f.name);
  for (const f of fields) if (defined[f]?.deprecationReason) warn.push(`${typeName}.${f} is deprecated: ${defined[f].deprecationReason}`);
  if (missing.length || requiredUnset.length) {
    problems++;
    console.log(`FAIL  ${typeName}: unknown fields [${missing}] required-but-unset [${requiredUnset}]`);
  } else console.log(`ok    input ${typeName}`);
}
for (const [typeName, vals] of Object.entries(ENUM_VALUES)) {
  const t = schema.getType(typeName) as { getValues?: () => { name: string }[] } | undefined;
  const have = new Set(t?.getValues?.().map((v) => v.name));
  const missing = vals.filter((v) => !have.has(v));
  if (!t?.getValues || missing.length) {
    problems++;
    console.log(`FAIL  enum ${typeName}: missing [${missing}]${t ? "" : " (type not found)"}`);
  } else console.log(`ok    enum ${typeName}`);
}
for (const w of warn) console.log(`warn  ${w}`);
console.log(problems === 0 ? `\nAll operations are valid against Admin API ${version}.` : `\n${problems} problem(s) against Admin API ${version}.`);
process.exit(problems === 0 ? 0 : 1);
