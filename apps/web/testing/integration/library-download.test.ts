import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@repo/database";
import { resetTestDatabase, testDatabaseUrl } from "@repo/database/testing";
import { createBook, createCustomer } from "./support/fixtures";

// The e-book download (app/api/library/[assetId]/route.ts) against a real
// database: who gets the file, the per-customer download limit, and that a
// download can't slip past a cancellation or return being made at the same
// moment (the customer would keep the PDF and be refunded). The session, the
// rate limiter and Storage's URL signing are stubbed.

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@repo/auth/server", () => ({ getCurrentUser: async () => session.user }));
vi.mock("@repo/security/rate-limit", () => ({ RATE_LIMITS: { libraryDownload: {} }, rateLimit: async () => ({ ok: true }) }));
vi.mock("@repo/storage", () => ({ createEbookDownloadUrl: async () => "https://storage.example.test/signed" }));

const { GET } = await import("@/app/api/library/[assetId]/route");

const download = (assetId: string) =>
  GET(new Request(`http://localhost/api/library/${assetId}`), { params: Promise.resolve({ assetId }) });

/** A paid online order for the e-book of `book`, and its uploaded file. */
async function boughtEbook(customer: { id: string }, book: { id: string }, maxDownloads: number | null = 5) {
  const order = await prisma.order.create({
    data: {
      userId: customer.id,
      status: "PAID",
      subtotalCents: 19_900,
      totalCents: 19_900,
      items: {
        create: [
          { productId: book.id, quantity: 1, unitPriceCents: 19_900, fulfillmentType: "DIGITAL", bookFormat: "EBOOK", includesEbook: true },
        ],
      },
      payment: { create: { amountCents: 19_900, method: "UPI", status: "CAPTURED" } },
    },
  });
  const file = await prisma.fileAsset.create({
    data: {
      kind: "EBOOK_FILE",
      blobPath: "ebooks/book.pdf",
      fileName: "book.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      malwareScanStatus: "CLEAN",
      productId: book.id,
      maxDownloads,
    },
  });
  return { order, file };
}

const downloads = async (userId: string) =>
  (await prisma.libraryDownload.findFirst({ where: { userId } }))?.count ?? 0;

describe.skipIf(!testDatabaseUrl())("e-book downloads", () => {
  let customer: { id: string; email: string };
  let book: { id: string };

  beforeEach(async () => {
    await resetTestDatabase(prisma);
    customer = await createCustomer();
    book = await createBook();
    session.user = { id: customer.id, email: customer.email };
  });
  afterAll(() => prisma.$disconnect());

  it("hands an owner a short-lived link and counts the download", async () => {
    const { file } = await boughtEbook(customer, book);

    const response = await download(file.id);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://storage.example.test/signed");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await downloads(customer.id)).toBe(1);
  });

  it("gives anyone else the same answer as a file that doesn't exist", async () => {
    const { file } = await boughtEbook(customer, book);
    const stranger = await createCustomer();
    session.user = { id: stranger.id, email: stranger.email };

    expect((await download(file.id)).status).toBe(404);
    expect((await download("no_such_file")).status).toBe(404);
    expect(await prisma.libraryDownload.count()).toBe(0);
  });

  it("stops at the download limit", async () => {
    const { file } = await boughtEbook(customer, book, 1);
    expect((await download(file.id)).status).toBe(307);
    expect((await download(file.id)).status).toBe(403);
    expect(await downloads(customer.id)).toBe(1);
  });

  it("won't hand over an e-book that's being cancelled at that moment", async () => {
    const { order, file } = await boughtEbook(customer, book);
    let lockHeld!: () => void;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));

    // What cancelOrder's transaction does — take the order's row, call the
    // line off — held open while the download is asked for.
    const cancelling = prisma.$transaction(
      async (tx) => {
        await tx.order.updateMany({ where: { id: order.id }, data: { status: "CANCELLED" } });
        const cancellation = await tx.orderCancellation.create({ data: { orderId: order.id, reason: "CHANGED_MIND" } });
        await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { cancellationId: cancellation.id } });
        lockHeld();
        await finished;
      },
      { timeout: 20_000 }
    );
    await held;

    const asked = download(file.id);
    // Long enough for an unguarded download to finish before the cancellation commits.
    await new Promise((resolve) => setTimeout(resolve, 750));
    finish();
    await cancelling;

    expect((await asked).status).toBe(404);
    expect(await downloads(customer.id)).toBe(0);
  });
});
