import { Html, Head, Body, Container, Heading, Text, Button } from "@react-email/components";

interface OrderCancelledProps {
  orderRef: string;
  /** "Title (Paperback) × 2" — what was cancelled. */
  items: string[];
  /** True when something in the order is still coming (a downloaded e-book, a service). */
  partial: boolean;
  refundCents: number;
  ordersUrl?: string;
}

const rupees = (cents: number) => `₹${(cents / 100).toFixed(2)}`;

export function OrderCancelled({ orderRef, items, partial, refundCents, ordersUrl }: OrderCancelledProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f6f8" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "32px", borderRadius: "8px" }}>
          <Heading style={{ color: "#1b2a4a" }}>{partial ? "Part of your order is cancelled" : "Your order is cancelled"}</Heading>
          <Text>As you asked, we've cancelled {partial ? `these items from order ${orderRef}` : `order ${orderRef}`}:</Text>
          {items.map((item, i) => (
            <Text key={i} style={{ margin: "4px 0" }}>
              • {item}
            </Text>
          ))}
          <Text>
            {refundCents > 0
              ? `${rupees(refundCents)} will be refunded to your original payment method within 5–7 working days. Your bank may take a few more days to show it.`
              : "Nothing was charged for these items, so there's nothing to refund."}
          </Text>
          {partial && <Text>Everything else in the order stays as it was.</Text>}
          {ordersUrl && (
            <Button
              href={ordersUrl}
              style={{ backgroundColor: "#007acc", color: "#ffffff", padding: "12px 20px", borderRadius: "8px", fontWeight: "bold" }}
            >
              View your orders
            </Button>
          )}
        </Container>
      </Body>
    </Html>
  );
}
