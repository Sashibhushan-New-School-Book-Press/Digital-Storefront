"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@repo/ui/utils";
import {
  CANCEL_REASONS,
  LINE_BLOCK_MESSAGE,
  RETURN_REASONS,
  returnRefundCents,
  returnsPrintedCopies,
  type CancelReason,
  type ReturnReason,
  type ReturnSelection,
} from "@repo/database/returns";
import { cancelOrder, requestReturn } from "@/app/(account)/account/orders/actions";
import { Callout, buttonClass } from "@/components/primitives";
import { formatINRWhole } from "@/lib/format";
import {
  cancellationRefundText,
  formatOrderDate,
  returnRefundText,
  type OrderDetail,
  type OrderDetailItem,
  type OrderReturnDetail,
} from "@/lib/order-tracking";

/**
 * The "Cancel order" and "Return order" forms inside the My Orders pop-up,
 * and the record of past cancellations and returns. What each order allows
 * was worked out on the server (`OrderDetail.canCancel` / `canReturn` and
 * each line's `cancelBlock` / `returnBlock`); the actions check it all again.
 */

const FIELD_CLASS =
  "w-full rounded-btn border-2 border-line-strong bg-ground px-3.5 py-2.5 text-[15px] focus:border-ink focus:outline-none";

type DoneHandler = (message: string) => void;

export function CancelPanel({ order, onBack, onDone }: { order: OrderDetail; onBack: () => void; onDone: DoneHandler }) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState<CancelReason | "">("");
  const [note, setNote] = useState("");

  const going = order.items.filter((item) => item.cancelBlock === null);
  const staying = order.items.filter((item) => item.cancelBlock !== null && item.cancelBlock !== "CANCELLED");
  const cashOnDelivery = order.payment?.method === "COD";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason) return setError("Choose why you're cancelling.");
    setError(undefined);
    startTransition(async () => {
      const result = await cancelOrder({ orderId: order.id, reason, note: note.trim() || undefined });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onDone(
        order.cancelsWholeOrder
          ? `Order ${order.ref} is cancelled. We've emailed you a confirmation.`
          : `Those items are cancelled from order ${order.ref}. We've emailed you a confirmation.`
      );
    });
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-title`} className="grid gap-6 px-6 py-6">
      <div>
        <h3 id={`${id}-title`} className="font-display text-lg font-bold tracking-[-0.01em]">
          {order.cancelsWholeOrder ? `Cancel order ${order.ref}?` : `Cancel items from order ${order.ref}?`}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          It happens straight away. Printed items can be cancelled until we send the parcel, e-books until you
          download them.
        </p>
      </div>

      <ItemGroup title="Will be cancelled" items={going} />
      {staying.length > 0 && (
        <ItemGroup
          title="Stays in your order"
          items={staying}
          detail={(item) => (item.cancelBlock ? LINE_BLOCK_MESSAGE[item.cancelBlock] : null)}
        />
      )}

      <p className="rounded-tile bg-tile px-4 py-3 text-sm inset-ring inset-ring-card-edge">
        {order.cancelRefundCents > 0
          ? `${formatINRWhole(order.cancelRefundCents)} will be refunded to your original payment method. Banks usually take 5–7 working days to show it.`
          : cashOnDelivery
            ? "You haven't paid anything yet — cash on delivery is only collected when the parcel arrives — so there's nothing to refund."
            : "Nothing has been charged for these items, so there's nothing to refund."}
      </p>

      <ReasonPicker
        name={`${id}-reason`}
        legend="Why are you cancelling?"
        reasons={CANCEL_REASONS}
        value={reason}
        onChange={(value) => setReason(value as CancelReason)}
      />
      <NoteField id={`${id}-note`} label="Anything else we should know? (optional)" value={note} onChange={setNote} />

      {error && (
        <p role="alert" className="text-sm font-bold text-sale">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onBack} disabled={pending} className={buttonClass("ghost", "sm")}>
          Keep my order
        </button>
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending ? "Cancelling…" : order.cancelsWholeOrder ? "Cancel order" : "Cancel these items"}
        </button>
      </div>
    </form>
  );
}

export function ReturnPanel({ order, onBack, onDone }: { order: OrderDetail; onBack: () => void; onDone: DoneHandler }) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const returnable = order.items.filter((item) => item.returnBlock === null);
  const notReturnable = order.items.filter((item) => item.returnBlock !== null && item.returnBlock !== "CANCELLED");
  // A single item is what the customer means to return; with more, they pick.
  const [picked, setPicked] = useState<Record<string, number>>(() =>
    returnable.length === 1 ? { [returnable[0]!.id]: returnable[0]!.returnableQuantity } : {}
  );
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [note, setNote] = useState("");
  const [unopened, setUnopened] = useState(false);

  const selection: ReturnSelection[] = Object.entries(picked)
    .filter(([, quantity]) => quantity > 0)
    .map(([lineId, quantity]) => ({ lineId, quantity }));
  const printed = returnsPrintedCopies(order.facts, selection);
  const ebookPicked = selection.some((choice) => order.items.find((item) => item.id === choice.lineId)?.includesEbook);
  const refundCents = selection.length ? returnRefundCents(order.facts, selection, reason || "NOT_NEEDED") : 0;
  const cashOnDelivery = order.payment?.method === "COD";

  function toggle(item: OrderDetailItem, on: boolean) {
    setPicked((current) => ({ ...current, [item.id]: on ? item.returnableQuantity : 0 }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selection.length) return setError("Choose at least one item to return.");
    if (!reason) return setError("Choose why you're returning it.");
    if (reason === "OTHER" && !note.trim()) return setError("Tell us a little about why you're returning it.");
    if (printed && !unopened) return setError("Printed items can only be returned in their unopened packaging.");
    setError(undefined);
    startTransition(async () => {
      const result = await requestReturn({
        orderId: order.id,
        reason,
        note: note.trim() || undefined,
        packagingUnopened: printed && unopened,
        items: selection,
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onDone("Return requested. We'll email you how to send the items back.");
    });
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-title`} className="grid gap-6 px-6 py-6">
      <div>
        <h3 id={`${id}-title`} className="font-display text-lg font-bold tracking-[-0.01em]">
          Return items from order {order.ref}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {order.returnWindowEndsAt && `Returns for this order close on ${formatOrderDate(order.returnWindowEndsAt)}. `}
          Printed items must be in their unopened packaging; e-books only if you haven&apos;t downloaded them.
        </p>
      </div>

      <fieldset>
        <legend className="caps text-ink-muted">What are you returning?</legend>
        <ul className="mt-3 divide-y divide-line rounded-tile bg-tile inset-ring inset-ring-card-edge">
          {returnable.map((item) => {
            const quantity = picked[item.id] ?? 0;
            const checkboxId = `${id}-item-${item.id}`;
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={quantity > 0}
                  onChange={(event) => toggle(item, event.target.checked)}
                  className="h-[18px] w-[18px] shrink-0 accent-brand"
                />
                <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block font-bold leading-snug">{item.title}</span>
                  <span className="block text-[13px] text-ink-muted">
                    {[item.formatLabel, item.includesEbook && item.fulfillmentType === "SHIP" ? "returned whole, with its e-book" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </label>
                {item.returnableQuantity > 1 && !item.includesEbook ? (
                  <label className="flex items-center gap-2 text-sm text-ink-muted">
                    Copies
                    <select
                      value={quantity || item.returnableQuantity}
                      disabled={quantity === 0}
                      onChange={(event) => setPicked((current) => ({ ...current, [item.id]: Number(event.target.value) }))}
                      className="h-10 rounded-btn border-2 border-line-strong bg-ground px-2 text-[15px] tabular-nums focus:border-ink focus:outline-none disabled:opacity-50"
                    >
                      {Array.from({ length: item.returnableQuantity }, (_, index) => index + 1).map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  item.quantity > 1 && <span className="text-sm text-ink-muted tabular-nums">× {item.quantity}</span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {notReturnable.length > 0 && (
        <ItemGroup
          title="Can't be returned"
          items={notReturnable}
          detail={(item) => (item.returnBlock ? LINE_BLOCK_MESSAGE[item.returnBlock] : null)}
        />
      )}

      <ReasonPicker
        name={`${id}-reason`}
        legend="Why are you returning it?"
        reasons={RETURN_REASONS}
        value={reason}
        onChange={(value) => setReason(value as ReturnReason)}
      />
      <NoteField
        id={`${id}-note`}
        label={reason === "OTHER" ? "Tell us why" : "Anything else we should know? (optional)"}
        value={note}
        onChange={setNote}
        required={reason === "OTHER"}
      />

      {printed && (
        <div className="rounded-tile bg-tile px-4 py-3.5 inset-ring inset-ring-card-edge">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={unopened}
              onChange={(event) => setUnopened(event.target.checked)}
              required
              className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-brand"
            />
            <span className="text-sm">
              <span className="font-bold">The printed items are still in their original, unopened packaging.</span>
              <span className="mt-0.5 block text-ink-muted">
                We can only take printed items back unopened, and we check them when they reach us. An opened item
                can&apos;t be accepted.
              </span>
            </span>
          </label>
        </div>
      )}
      {ebookPicked && (
        <p className="text-sm text-ink-muted">The e-book stops downloading as soon as you ask to return it.</p>
      )}

      {selection.length > 0 && (
        <p className="rounded-tile bg-tile px-4 py-3 text-sm inset-ring inset-ring-card-edge">
          <span className="font-bold">Refund once we&apos;ve received it: {formatINRWhole(refundCents)}</span>
          <span className="mt-0.5 block text-ink-muted">
            {cashOnDelivery
              ? "You paid in cash, so we refund by bank transfer or UPI and will contact you for the account."
              : "Refunded to your original payment method."}{" "}
            {reason === "DAMAGED" || reason === "WRONG_ITEM"
              ? "Includes the delivery charge, as the mistake was ours."
              : "The original delivery charge isn't refunded."}
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm font-bold text-sale">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onBack} disabled={pending} className={buttonClass("ghost", "sm")}>
          Back
        </button>
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending ? "Sending…" : "Request return"}
        </button>
      </div>
    </form>
  );
}

/** Past and current cancellations and returns, for the details view. */
export function OrderChangesHistory({ order }: { order: OrderDetail }) {
  if (!order.cancellations.length && !order.returns.length) return null;
  const byId = new Map(order.items.map((item) => [item.id, item]));
  const cashOnDelivery = order.payment?.method === "COD";

  return (
    <section aria-labelledby="order-changes-heading">
      <h3 id="order-changes-heading" className="caps text-ink-muted">
        Cancellations and returns
      </h3>
      <ul className="mt-3 grid gap-3">
        {order.cancellations.map((cancellation) => (
          <li key={cancellation.id} className="rounded-tile bg-tile px-4 py-3.5 text-sm inset-ring inset-ring-card-edge">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold">You cancelled {cancellation.itemIds.length === 1 ? "1 item" : `${cancellation.itemIds.length} items`}</p>
              <time dateTime={cancellation.createdAt} className="text-[13px] text-ink-muted">
                {formatOrderDate(cancellation.createdAt)}
              </time>
            </div>
            <p className="mt-1 text-ink-muted">
              {cancellation.itemIds.map((itemId) => byId.get(itemId)?.title).filter(Boolean).join(", ")}
            </p>
            <p className="mt-1 text-ink-muted">Reason: {cancellation.reasonLabel}</p>
            <p className="mt-1">{cancellationRefundText(cancellation.refundCents, cancellation.refundedAt)}</p>
          </li>
        ))}
        {order.returns.map((orderReturn) => (
          <li key={orderReturn.id} className="rounded-tile bg-tile px-4 py-3.5 text-sm inset-ring inset-ring-card-edge">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Callout tone={orderReturn.status === "APPROVED" ? "brand" : orderReturn.status === "COMPLETED" ? "ok" : "tile"}>
                {RETURN_LABEL[orderReturn.status]}
              </Callout>
              <time dateTime={orderReturn.createdAt} className="text-[13px] text-ink-muted">
                Requested {formatOrderDate(orderReturn.createdAt)}
              </time>
            </div>
            <p className="mt-2 text-ink-muted">
              {orderReturn.items
                .map(({ orderItemId, quantity }) => {
                  const title = byId.get(orderItemId)?.title;
                  return title ? (quantity > 1 ? `${title} × ${quantity}` : title) : null;
                })
                .filter(Boolean)
                .join(", ")}
            </p>
            <p className="mt-1 text-ink-muted">Reason: {orderReturn.reasonLabel}</p>
            {orderReturn.staffNote && (
              <p className="mt-2 rounded-btn bg-ground px-3 py-2">
                <span className="font-bold">From our team:</span> {orderReturn.staffNote}
              </p>
            )}
            <p className="mt-2">{returnProgressText(orderReturn, cashOnDelivery)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const RETURN_LABEL: Record<OrderReturnDetail["status"], string> = {
  REQUESTED: "Return requested",
  APPROVED: "Return approved",
  COMPLETED: "Returned",
  REJECTED: "Not accepted",
};

function returnProgressText(orderReturn: OrderReturnDetail, cashOnDelivery: boolean): string {
  switch (orderReturn.status) {
    case "REQUESTED":
      return "We're looking at your request and will email you how to send the items back.";
    case "APPROVED":
      return `Send the items back in their unopened packaging. Once they reach us and we've checked them, we refund ${formatINRWhole(orderReturn.refundCents)}.`;
    case "COMPLETED":
      return returnRefundText(orderReturn, cashOnDelivery);
    case "REJECTED":
      return "The items stay yours, and nothing is refunded.";
  }
}

function ItemGroup({
  title,
  items,
  detail,
}: {
  title: string;
  items: OrderDetailItem[];
  detail?: (item: OrderDetailItem) => string | null;
}) {
  return (
    <div>
      <p className="caps text-ink-muted">{title}</p>
      <ul className="mt-3 divide-y divide-line rounded-tile bg-tile inset-ring inset-ring-card-edge">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="font-bold leading-snug">{item.title}</p>
              <p className="text-[13px] text-ink-muted">
                {[item.formatLabel, item.quantity > 1 ? `× ${item.quantity}` : null].filter(Boolean).join(" · ")}
              </p>
              {detail?.(item) && <p className="mt-0.5 text-[13px] text-ink-muted">{detail(item)}</p>}
            </div>
            <p className="shrink-0 tabular-nums">{formatINRWhole(item.quantity * item.unitPriceCents)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReasonPicker({
  name,
  legend,
  reasons,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  reasons: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend className="caps text-ink-muted">{legend}</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {Object.entries(reasons).map(([key, label]) => (
          <label
            key={key}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-btn border-2 px-3.5 py-2.5 text-sm",
              value === key ? "border-ink bg-tile" : "border-line-strong"
            )}
          >
            <input
              type="radio"
              name={name}
              value={key}
              checked={value === key}
              onChange={() => onChange(key)}
              required
              className="h-4 w-4 shrink-0 accent-brand"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NoteField({
  id,
  label,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <label htmlFor={id} className="caps text-ink-muted">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={500}
        rows={3}
        required={required}
        className={FIELD_CLASS}
      />
    </div>
  );
}
