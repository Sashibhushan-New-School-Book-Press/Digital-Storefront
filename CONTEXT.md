# CONTEXT — glossary

The words this project uses for its business. Use them in code, UI copy,
issues and tests. Where a term has a code name, it's in `code`. Admin copy
never shows code names; it uses the plain label.

## People

- **Owner**: the Publisher (Shashibhushan). Role `OWNER`, the only role
  that can invite staff, change roles or touch royalty rates.
- **Staff**: someone the Owner invited into `apps/admin`. Roles are
  `SUPPORT` (orders and customers), `EDITOR` (catalogue and website) and
  `OWNER`. All three are `ADMIN_ROLES`. Staff exist only in the
  admin-auth Supabase project.
- **Customer**: anyone with a storefront account. Role `READER`, or
  `SELF_PUB_AUTHOR` once they publish with the Press. A *Guest* is a
  visitor who isn't signed in.
- **Staff invite** (`StaffInvite`): a one-hour, single-use `/join/<token>`
  link the Owner sends. It's the only way a staff account is created.

## What the Press sells

- **Department**: one of the five top-level groups shown in the storefront
  bar and the admin sidebar: Educational Materials, Professional Materials,
  Digital & Tech Solutions, Lifestyle, and Publishing.
- **Product line** (`ProductLine`): one of the eight kinds of product inside
  the first four departments: Books, Educational Charts, Worksheets and
  Activity Puzzles, Teaching and Learning Materials, Advocate's Diary,
  Naya Bandhu (Application), Digital Tracking System, and Indoor Plants.
  The canonical list is `packages/database/src/taxonomy.ts`.
- **Publishing services**: Self Publishing and Bulk Publishing, the
  Publishing department. They're services, not product lines, and they're
  never `Product` rows. See *Self-publishing project* and *Service request*.
- **Menu category** (`MenuCategory`): an extra category the Owner adds from
  admin's Menu section, on top of the fixed departments.
- **Product** (`Product`): one sellable title or item. `type` only
  describes fulfilment (`PHYSICAL_BOOK`, `EBOOK`, `SERVICE_PACKAGE`), and
  `productLine` says what it is.
- **Edition** (`BookEdition`): one format of a book: Paperback, Hardcover or
  E-book. Each edition has its own price, and the printed ones have their
  own stock. A book has one to three editions, and other products have
  none.
- **Service package**: a `SERVICE_PACKAGE` product sold from `/services`,
  for example e-book conversion. It has no product line.
- **Class set**: buying many copies for a classroom. The tiers
  (`ClassSetTier`) give a quantity discount.
- **Bundle**: a printed edition plus its e-book, at a set uplift.
- **Discount code / coupon** (`DiscountCode`): a checkout code. It's checked
  only on the server and never sent to the browser.

## Orders

- **Order** (`Order`): one checkout. `status` tracks payment and the order
  as a whole: `PENDING` → `PAID` → …, or `CANCELLED`/`REFUNDED`.
- **Sales order**: what staff call an order on admin's Sales Orders page.
  It's the same row as an Order, listed once it's paid or placed as COD.
- **COD**: cash on delivery. The order is placed unpaid, and staff mark the
  cash collected once the parcel has gone out.
- **Online / offline part**: the online part is delivered digitally the
  moment it's paid (e-books, services). The offline part is the printed
  parcel. A *mixed* order has both.
- **Shipment status** (`Order.shipmentStatus`): where the parcel is, kept
  separate from `status`. The steps are Awaiting approval → Processing →
  Shipping → Out for delivery → Delivered, or Cancelled. Staff move it, and
  it's null when nothing ships.
- **Accept / Deny**: staff's decision on an order awaiting approval. A
  *denial* sets the shipment to Cancelled, returns the copies to stock and
  creates no cancellation record.
- **Cancellation** (`OrderCancellation`): the customer calls off what's
  left of an order from My Orders, before the parcel ships. It covers the
  printed lines and any undownloaded e-books, and it's instant: staff
  don't approve it. Admin shows it as "Cancelled by customer".
- **Return** (`OrderReturn`): the customer sends back delivered items within
  the **return window**: `policies.returnWindowDays`, counted from
  `Order.deliveredAt`. Printed copies must be in unopened packaging, and an
  e-book only qualifies if it was never downloaded. Staff decide it:
  Requested → Approved → Completed, or Rejected. Only one return can be
  open per order.
- **Refund**: the money a cancellation or return owes back (`refundCents`).
  There's no refund integration: staff refund by hand from the Razorpay
  dashboard, or by bank transfer/UPI for COD, then record it as sent
  (`refundedAt`).

## Digital delivery

- **Library**: My Library, where a customer downloads the e-books they're
  entitled to.
- **Entitlement**: the right to download an e-book. It comes from a paid
  (or later) order line with `includesEbook` that hasn't been cancelled or
  put in an open return. Buying only the print edition gives no
  entitlement.
- **Download allowance**: `FileAsset.maxDownloads` per customer per file.
  Downloads are counted in `LibraryDownload`. A downloaded e-book can't be
  cancelled or returned.

## Publishing

- **Self-publishing project** (`SelfPublishingProject`): an author's book
  moving through Submitted → In review → In production → Proof ready →
  Published (or Rejected).
- **Service request** (`ServiceRequest`): a customer's request for a
  service package or bulk publishing.
- **Royalty** (`Royalty`): what the Press owes an author for sales of their
  published book.

## Supply

- **Vendor** (`Vendor`): a supplier the Press orders reprints from.
- **Purchase order** (`PurchaseOrder`): stock ordered from a vendor.
  Receiving it adds copies to the product, or to the named edition for a
  book.

## Website content (CMS)

- **Site settings, navigation, banners, homepage text, FAQs, testimonials,
  pricing**: storefront content that staff edit in admin and the storefront
  reads from the shared database.
- **Homepage text** is a registry (`packages/database/src/content.ts`). The
  database stores only overrides, so clearing a box restores the default
  wording.
