# Books listing: scaling to a large catalogue

The storefront's product listings are built so that response time doesn't
grow with the size of the catalogue. They are `/educational-material/books`
and the three other Educational Materials lines, which share the same
machinery. This note records how, and what's still needed at around a
million rows.

## How it stays flat

| Concern | How it's handled |
|---|---|
| Rows per request | At most `BOOKS_PAGE_SIZE` (20) titles. One `Product` per title, with its `BookEdition`s included, so `LIMIT` counts titles. |
| Paging deeper | Keyset (cursor) pagination, not `OFFSET`. `nextCursor` is the last row's `(sortValue, id)`, so page 50,000 costs the same as page 1. |
| Sorting | In the database, `ORDER BY <col>, id`. Price sorts on `Product.priceCents`, the cheapest edition. Rating sorts on `ratingAvg`/`reviewCount`, which default to `0` so the keyset never meets nulls. |
| Indexes | One `(productLine, <col>, id)` index per sort column. The keyset adds a plain `<col> >= cursor` bound (`<=` when descending) next to its `OR`, because Postgres can't seek on an `OR`. That makes every page a range seek. `isPublished` and `type` are filtered from the rows, since nearly every row in a line passes. |
| Total count | `countBookListings()`: one aggregate, run only on the first render. |
| Client | `BooksGrid` keeps only the rows it has shown plus the cursor. An `IntersectionObserver` fetches the next page about 600 px early (TanStack Query). |
| Caching | Each page is cached through `lib/products-cache.ts`, tagged `catalogue:<line>`, and expired by admin saves and stock moves (`docs/adr/0001-caching-strategy.md`). `/api/books` is also HTTP-cacheable for 60 s. |

The code:
- `lib/books-page.ts`: cursor encode/decode and `SORT_KEYS`.
- `lib/books-data.ts`: `fetchBookPage()` / `countBookListings()` /
  `buildBookWhere()`, with the `withFallback()` sample catalogue for when
  the database can't be reached.
- `app/api/books/route.ts`: `GET /api/books?…&cursor=…` returns
  `{ items, nextCursor }`.

## Still open for very large catalogues

1. **Text search.** `q` uses `contains … insensitive` (`ILIKE %term%`),
   which can't use a b-tree index. Move to Postgres full-text (GIN) or
   `pg_trgm`.
2. **Count cost.** A filtered `COUNT(*)` scans the matching range. If it
   shows up in traces, switch to an estimate or drop the exact number.
3. **Ratings aren't aggregated.** Nothing writes `ratingAvg`/`reviewCount`
   from `Review` rows yet. Reviews are cut from launch; when moderation is
   built, approving a review should recompute both and call
   `revalidateStorefront(productChangedTags(…))`.
4. **`availableGenres`** is still the full `BOOK_GENRES` list rather than a
   `SELECT DISTINCT genre`.
