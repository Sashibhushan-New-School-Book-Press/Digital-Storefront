import type { Metadata } from "next";
import Link from "next/link";
import { ContactLinks, PolicyPage, PolicySection } from "@/components/legal/policy-page";
import { getPolicyDetails } from "@/lib/policies";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy",
  description: "How to cancel an order, return a printed item, and when e-books and publishing services can be refunded.",
};

// The return window is admin-editable (Homepage text → Policies) and should
// match the "Easy returns" promise on catalogue pages (homepage.trust.item2).
// The cancel/return rules described here are enforced by My Orders'
// "Cancel order" / "Return order" (`@repo/database`'s returns.ts) — change
// both together.

export default async function RefundPolicyPage() {
  const d = await getPolicyDetails();
  const days = `${d.returnWindowDays} ${d.returnWindowDays === 1 ? "day" : "days"}`;

  return (
    <PolicyPage
      href="/refund-policy"
      title="Refund & Cancellation Policy"
      standfirst={`Cancel from your Orders page until your parcel is dispatched, and return printed items in unopened packaging within ${days} of delivery.`}
      lastUpdated={d.lastUpdated}
    >
      <PolicySection title="Cancelling an order">
        <ul>
          <li>
            <strong>Printed items</strong> — you can cancel any time before the order is dispatched, for a full refund
            including delivery. Once it has been dispatched, use the return process below instead.
          </li>
          <li>
            <strong>E-books</strong> — you can cancel for a full refund as long as the e-book has not been downloaded.
            An e-book you&apos;ve downloaded can&apos;t be cancelled, and nor can a printed copy sold together with it
            in one item.
          </li>
          <li>
            <strong>Publishing services</strong> — you can cancel for a full refund before work begins. After that, we
            refund the fee less the work already done, as set out in your package or quote.
          </li>
        </ul>
        <p>
          To cancel, open the order on your <Link href="/account/orders">Orders</Link> page and choose{" "}
          <strong>Cancel order</strong> — it takes effect straight away. For a publishing service, email{" "}
          <ContactLinks email={d.contactEmail} phone={d.contactPhone} /> with your order number.
        </p>
      </PolicySection>

      <PolicySection title="Returning printed items">
        <p>
          Within {days} of delivery you can return printed items whose packaging is still unopened: open the order on
          your <Link href="/account/orders">Orders</Link> page and choose <strong>Return order</strong>. We email you
          how to send them back, and check the packaging when they reach us — an item whose packaging has been
          opened can&apos;t be accepted.
        </p>
        <ul>
          <li>
            <strong>Damaged or wrong items</strong> — we refund the item price and the delivery charge. If you find a
            fault only once you&apos;ve opened it, send your order number and a photo of the problem to{" "}
            <ContactLinks email={d.contactEmail} phone={d.contactPhone} /> instead and we&apos;ll put it right.
          </li>
          <li>
            <strong>Any other reason</strong> — we refund the item price; the original delivery charge and the cost of
            sending it back are not refunded.
          </li>
          <li>
            Bulk and class-set orders, and items printed to your specification, can only be returned if damaged,
            defective or wrong.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="E-books">
        <p>
          Because a downloaded file cannot be returned, e-books are not refundable once downloaded — unless the file
          is faulty and we cannot give you a working copy, in which case we refund it in full. When an e-book is
          refunded, it is removed from your <Link href="/account/library">digital library</Link>.
        </p>
      </PolicySection>

      <PolicySection title="How refunds are paid">
        <ul>
          <li>We confirm by email when you cancel, and at each step of a return.</li>
          <li>
            Approved refunds are issued within 5–7 working days to the original payment method (UPI, card or bank
            account). Your bank may take a few more days to show it.
          </li>
          <li>Cash on Delivery orders are refunded by bank transfer or UPI to an account you give us.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Need help?">
        <p>
          Contact us at <ContactLinks email={d.contactEmail} phone={d.contactPhone} />, or see our{" "}
          <Link href="/contact">Contact us</Link> page for the Grievance Officer’s details.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
