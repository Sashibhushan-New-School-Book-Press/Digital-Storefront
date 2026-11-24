/**
 * The Sales Orders list's "Show orders" choices. Shared by the page (which
 * takes one from `?filter=`, so the dashboard's "needs attention" links open
 * the list already filtered) and the list itself.
 */
export const FILTERS = [
  { value: "all", label: "All orders" },
  { value: "approval", label: "Waiting for approval" },
  { value: "in_progress", label: "Being delivered" },
  { value: "complete", label: "Complete" },
  { value: "cancelled", label: "Cancelled" },
  { value: "returns", label: "Return requests" },
  { value: "refunds", label: "Refunds to send" },
] as const;

export type SalesOrderFilter = (typeof FILTERS)[number]["value"];

export function isSalesOrderFilter(value: string): value is SalesOrderFilter {
  return FILTERS.some((option) => option.value === value);
}
