import "server-only";
import { bookFormatLabel, type BookFormat, type Prisma } from "@repo/database";

/**
 * What My Orders and its cancel/return actions read about an order's
 * cancellations and returns, on top of the order itself. The rules they're
 * checked against live in `@repo/database`'s returns.ts, shared with
 * apps/admin's Sales Orders page.
 */
export const ORDER_CHANGES_INCLUDE = {
  cancellations: { orderBy: { createdAt: "asc" }, include: { items: { select: { id: true } } } },
  returns: { orderBy: { createdAt: "asc" }, include: { items: { select: { orderItemId: true, quantity: true } } } },
} satisfies Prisma.OrderInclude;

/** "Title (Paperback) × 2", as the cancellation and return emails list a line. */
export function lineLabel(item: { quantity: number; bookFormat: BookFormat | null; product: { title: string } }, quantity = item.quantity): string {
  const title = item.bookFormat ? `${item.product.title} (${bookFormatLabel(item.bookFormat)})` : item.product.title;
  return quantity > 1 ? `${title} × ${quantity}` : title;
}
