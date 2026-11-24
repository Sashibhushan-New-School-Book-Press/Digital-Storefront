import { afterEach, describe, expect, it, vi } from "vitest";
import { shippingEmail, storefrontOrdersUrl } from "@/app/supply/sales-orders/customer";
import { FILTERS, isSalesOrderFilter } from "@/app/supply/sales-orders/filters";

// The Sales Orders page's small pure pieces: where order emails send the
// customer, which address they go to for a guest, and the `?filter=` the
// dashboard's "needs attention" links open the list with.

describe("storefrontOrdersUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("points at My Orders on the storefront", () => {
    vi.stubEnv("NEXT_PUBLIC_STOREFRONT_URL", " https://shop.example.test/ ");
    expect(storefrontOrdersUrl()).toBe("https://shop.example.test/account/orders");
  });

  it("drops any path already on the storefront address", () => {
    vi.stubEnv("NEXT_PUBLIC_STOREFRONT_URL", "https://shop.example.test/some/page?x=1");
    expect(storefrontOrdersUrl()).toBe("https://shop.example.test/account/orders");
  });

  it.each(["", "   ", "not a url"])("leaves the button out when the storefront address is %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_STOREFRONT_URL", value);
    expect(storefrontOrdersUrl()).toBeNull();
  });
});

describe("shippingEmail", () => {
  it("reads the email typed at checkout from the address snapshot", () => {
    expect(shippingEmail({ name: "A Reader", email: "reader@example.test" })).toBe("reader@example.test");
  });

  it.each([null, "reader@example.test", 42, ["reader@example.test"], { email: 42 }, { name: "No email" }])(
    "finds none in %j",
    (snapshot) => expect(shippingEmail(snapshot)).toBeNull()
  );
});

describe("isSalesOrderFilter", () => {
  it("accepts every choice the list offers", () => {
    for (const { value } of FILTERS) expect(isSalesOrderFilter(value)).toBe(true);
  });

  it.each(["", "Returns", "refund", "all ", "__proto__", "toString"])("refuses %j", (value) => {
    expect(isSalesOrderFilter(value)).toBe(false);
  });
});
