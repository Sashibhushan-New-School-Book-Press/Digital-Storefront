/**
 * Which e-books customers have downloaded — what decides whether an e-book
 * can still be cancelled or returned (src/returns.ts). A download is counted
 * per (customer, file) in `LibraryDownload` by apps/web's library route.
 *
 * Takes the client (or a transaction) as an argument, like stock.ts, so a
 * cancellation can re-check inside its own transaction.
 */

import type { Prisma } from "@prisma/client";

type Reader = Pick<Prisma.TransactionClient, "libraryDownload">;

/** customer id → the products whose e-book file they've downloaded at least once. */
export async function downloadedEbooks(
  db: Reader,
  userIds: readonly string[],
  productIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>();
  if (!userIds.length || !productIds.length) return byUser;
  const rows = await db.libraryDownload.findMany({
    where: {
      userId: { in: [...new Set(userIds)] },
      count: { gt: 0 },
      fileAsset: { kind: "EBOOK_FILE", productId: { in: [...new Set(productIds)] } },
    },
    select: { userId: true, fileAsset: { select: { productId: true } } },
  });
  for (const row of rows) {
    if (!row.fileAsset.productId) continue;
    const products = byUser.get(row.userId) ?? new Set<string>();
    products.add(row.fileAsset.productId);
    byUser.set(row.userId, products);
  }
  return byUser;
}

/** One customer's downloaded e-books among `productIds`. */
export async function downloadedEbooksOf(db: Reader, userId: string, productIds: readonly string[]): Promise<Set<string>> {
  return (await downloadedEbooks(db, [userId], productIds)).get(userId) ?? new Set();
}
