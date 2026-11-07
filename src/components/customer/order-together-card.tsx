"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { joinTableGroup, startTableGroup } from "@/lib/table-groups/actions";

/**
 * "Order together": start a shared order for the table, or join the one
 * someone at the table already started. The name is optional; without
 * one, friends see "Guest 2".
 */
export function OrderTogetherCard(
  props:
    { mode: "start" } | { mode: "join"; groupId: string; startedBy: string },
) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function go() {
    setError(null);
    startTransition(async () => {
      const result =
        props.mode === "join"
          ? await joinTableGroup(props.groupId, name)
          : await startTableGroup(name);
      if (!result.ok) {
        setError(result.error ?? null);
        return;
      }
      router.refresh();
    });
  }

  const joining = props.mode === "join";

  return (
    <section
      aria-labelledby="order-together-heading"
      className={
        "flex flex-col gap-3 rounded-xl border p-4 " +
        (joining ? "border-primary/40 bg-primary/5" : "bg-card")
      }
    >
      <div className="flex items-start gap-3">
        <Users className="text-primary mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <h2 id="order-together-heading" className="font-semibold">
            {joining
              ? `${props.startedBy} started a shared order for this table`
              : "Ordering with friends?"}
          </h2>
          <p className="type-body-sm text-muted-foreground">
            {joining
              ? "Join to add your dishes to the same order. Everyone sees what's in it, and one of you sends it to the kitchen."
              : "Start a shared order. Everyone at your table adds dishes from their own phone, and it goes to the kitchen as one order."}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="group-name" className="sr-only">
          Your first name (optional)
        </label>
        <Input
          id="group-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={30}
          autoComplete="given-name"
          placeholder="Your first name (optional)"
          disabled={isPending}
          className="h-11 text-base"
        />
        <Button
          type="button"
          size="lg"
          onClick={go}
          disabled={isPending}
          className="shrink-0"
        >
          {isPending
            ? joining
              ? "Joining…"
              : "Starting…"
            : joining
              ? "Join"
              : "Order together"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="type-body-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
