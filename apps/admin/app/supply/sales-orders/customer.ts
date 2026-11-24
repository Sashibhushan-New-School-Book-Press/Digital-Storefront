import type { Prisma } from "@repo/database";

/** The customer's My Orders page on the storefront, for the buttons in order emails. */
export function storefrontOrdersUrl(): string | null {
  const storefrontUrl = process.env.NEXT_PUBLIC_STOREFRONT_URL?.trim();
  if (!storefrontUrl) return null;
  try {
    return new URL("/account/orders", storefrontUrl).toString();
  } catch {
    return null;
  }
}

/** The email typed at checkout, from the `shippingAddress` snapshot. */
export function shippingEmail(address: Prisma.JsonValue): string | null {
  if (address && typeof address === "object" && !Array.isArray(address) && typeof address.email === "string") {
    return address.email;
  }
  return null;
}
