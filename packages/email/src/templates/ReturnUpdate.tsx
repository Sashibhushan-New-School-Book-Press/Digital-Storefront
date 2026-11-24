import { Html, Head, Body, Container, Heading, Text, Button } from "@react-email/components";

export type ReturnUpdateStage = "requested" | "approved" | "rejected" | "completed";

interface ReturnUpdateProps {
  stage: ReturnUpdateStage;
  orderRef: string;
  /** "Title (Paperback) × 2" — what's going back. */
  items: string[];
  refundCents: number;
  /** Paid in cash: the refund goes by bank transfer or UPI to an account the customer gives us. */
  cashOnDelivery: boolean;
  /** What staff wrote: how the parcel comes back, or why the return was refused. */
  staffNote?: string | null;
  ordersUrl?: string;
}

const rupees = (cents: number) => `₹${(cents / 100).toFixed(2)}`;

const HEADING: Record<ReturnUpdateStage, string> = {
  requested: "We've got your return request",
  approved: "Your return is approved",
  rejected: "We couldn't accept your return",
  completed: "Your return is complete",
};

export function ReturnUpdate({ stage, orderRef, items, refundCents, cashOnDelivery, staffNote, ordersUrl }: ReturnUpdateProps) {
  const refundRoute = cashOnDelivery
    ? "by bank transfer or UPI — we'll contact you for the account to send it to"
    : "to your original payment method";
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f6f8" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "32px", borderRadius: "8px" }}>
          <Heading style={{ color: "#1b2a4a" }}>{HEADING[stage]}</Heading>
          <Text>Order {orderRef}:</Text>
          {items.map((item, i) => (
            <Text key={i} style={{ margin: "4px 0" }}>
              • {item}
            </Text>
          ))}
          {stage === "requested" && (
            <Text>
              Our team will look at it and email you how to send it back. Please keep printed items in their unopened
              packaging — we can only accept them that way.
            </Text>
          )}
          {stage === "approved" && (
            <Text>
              Please send the items back in their unopened packaging. Once they reach us and we've checked them, we'll
              refund {rupees(refundCents)} {refundRoute}.
            </Text>
          )}
          {stage === "rejected" && <Text>The items stay yours, and nothing will be refunded.</Text>}
          {stage === "completed" && (
            <Text>
              {refundCents > 0
                ? `We've received your return. ${rupees(refundCents)} will be refunded ${refundRoute} within 5–7 working days.`
                : "We've received your return."}
            </Text>
          )}
          {staffNote && (
            <Text style={{ backgroundColor: "#f4f6f8", padding: "12px 16px", borderRadius: "8px" }}>{staffNote}</Text>
          )}
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
