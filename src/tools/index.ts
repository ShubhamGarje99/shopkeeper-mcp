import { createInvoice } from "./create-invoice.js";
import { getOrder } from "./get-order.js";
import { issueRefund } from "./issue-refund.js";
import { listOrders } from "./list-orders.js";
import { lowStockAlerts } from "./low-stock-alerts.js";
import { salesReport } from "./sales-report.js";
import { searchCustomers } from "./search-customers.js";
import type { ToolSpec } from "./types.js";
import { updateOrderStatus } from "./update-order-status.js";

export { createInvoice, getOrder, issueRefund, listOrders, lowStockAlerts, salesReport, searchCustomers, updateOrderStatus };

/** Registration order = the order hosts list them in. Reads first, then writes. */
export const ALL_TOOLS = [
  searchCustomers,
  getOrder,
  listOrders,
  salesReport,
  lowStockAlerts,
  updateOrderStatus,
  issueRefund,
  createInvoice,
] as unknown as readonly ToolSpec[];

export const WRITE_TOOL_NAMES: readonly string[] = ALL_TOOLS.filter((t) => t.kind === "write").map((t) => t.name);
export const READ_TOOL_NAMES: readonly string[] = ALL_TOOLS.filter((t) => t.kind === "read").map((t) => t.name);
