-- Indexes shaped to the queries that actually run, so they stay fast as the
-- catalogue and order book grow. Schema-only: no column or table changes,
-- and the code running before this migration works the same after it
-- (dropping an index changes no query's result).
--
-- Created first, then the indexes they make redundant are dropped:
--   products_slug_idx          duplicates the unique index on slug
--   products_productLine_idx   every new products index leads with productLine
--   products_ratingAvg_idx,    the rating/review sorts now use
--   products_reviewCount_idx   (productLine, <col>, id)
--   orders_userId_idx          prefix of (userId, createdAt)
--   wishlists_userId_idx       prefix of the (userId, productId) unique index

-- Books / Educational Materials listing: one per sort column, so
-- `WHERE productLine = ? AND <col> >= <cursor> ORDER BY <col>, id LIMIT 21`
-- (apps/web/lib/books-data.ts) is an index range seek at any scroll depth.
CREATE INDEX "products_productLine_priceCents_id_idx" ON "products"("productLine", "priceCents", "id");
CREATE INDEX "products_productLine_title_id_idx" ON "products"("productLine", "title", "id");
CREATE INDEX "products_productLine_publishedAt_id_idx" ON "products"("productLine", "publishedAt", "id");
CREATE INDEX "products_productLine_createdAt_id_idx" ON "products"("productLine", "createdAt", "id");
CREATE INDEX "products_productLine_ratingAvg_id_idx" ON "products"("productLine", "ratingAvg", "id");
CREATE INDEX "products_productLine_reviewCount_id_idx" ON "products"("productLine", "reviewCount", "id");

-- My Orders: one customer's orders, newest first.
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt");

-- Sales Orders and the dashboard (newest first with a LIMIT), and the
-- period / week revenue aggregates (a createdAt range).
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- The wishlist page: one customer's saves, newest first.
CREATE INDEX "wishlists_userId_createdAt_idx" ON "wishlists"("userId", "createdAt");

-- Now redundant.
DROP INDEX "products_slug_idx";
DROP INDEX "products_productLine_idx";
DROP INDEX "products_ratingAvg_idx";
DROP INDEX "products_reviewCount_idx";
DROP INDEX "orders_userId_idx";
DROP INDEX "wishlists_userId_idx";
