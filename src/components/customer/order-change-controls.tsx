"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cancelMyOrder, changeMyOrder } from "@/lib/orders/customer-cancel";

/**
 * "Placed it by mistake?": Change or Cancel while the order still says
 * "Order received", i.e. the kitchen hasn't accepted it. The order page
 * re-renders live (OrderStatusSync), so the moment the kitchen accepts,
 * this turns into a note to ask staff instead.
 */
export function OrderChangeControls({
  orderId,
  orderNumber,
  restaurantSlug,
  status,
  paid,
}: {
  orderId: string;
  orderNumber: number;
  restaurantSlug: string;
  status: string;
  paid: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notAdded, setNotAdded] = useState<string | null>(null);

  if (status === "cancelled" || status === "served" || status === "ready") {
    // After Change order, when something couldn't go back in the cart.
    return notAdded ? (
      <Alert>
        <AlertDescription className="flex flex-col gap-2">
          <span>{notAdded}</span>
          <Link
            href={`/r/${restaurantSlug}/cart`}
            className={buttonVariants({ size: "sm", className: "self-start" })}
          >
            Go to your cart
          </Link>
        </AlertDescription>
      </Alert>
    ) : null;
  }

  if (status !== "pending") {
    return (
      <p className="text-muted-foreground text-center text-sm">
        The kitchen has started your order. To change or cancel it, please ask a
        member of staff.
      </p>
    );
  }

  if (paid) {
    return (
      <p className="text-muted-foreground text-center text-sm">
        Need to change this order? It&apos;s paid, so please ask a member of
        staff.
      </p>
    );
  }

  function change() {
    setError(null);
    start(async () => {
      const r = await changeMyOrder(orderId);
      if (!r.ok) {
        setError(r.error ?? "Couldn't change the order. Please try again.");
        return;
      }
      if (r.notAdded) {
        // Say what was left out before moving on.
        setNotAdded(r.notAdded);
        router.refresh();
        return;
      }
      router.push(`/r/${restaurantSlug}/cart`);
    });
  }

  function cancel() {
    setError(null);
    start(async () => {
      const r = await cancelMyOrder(orderId);
      setConfirming(false);
      if (!r.ok) {
        setError(r.error ?? "Couldn't cancel the order. Please try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div>
        <h2 className="font-medium">Placed it by mistake?</h2>
        <p className="text-muted-foreground text-sm">
          You can change or cancel until the kitchen accepts it.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={change}
        >
          <Pencil className="size-4" aria-hidden="true" />
          {pending ? "One moment…" : "Change order"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() => setConfirming(true)}
        >
          <X className="size-4" aria-hidden="true" />
          Cancel order
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel order #{orderNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              The kitchen won&apos;t make it. To swap or add dishes instead, use
              Change order.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my order</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={cancel}
            >
              {pending ? "Cancelling…" : "Yes, cancel it"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
