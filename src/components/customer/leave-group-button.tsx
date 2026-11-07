"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { leaveTableGroup } from "@/lib/table-groups/actions";

/** Leave the shared order. Your own dishes stay in your own cart. */
export function LeaveGroupButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await leaveTableGroup();
          router.refresh();
        })
      }
    >
      {isPending ? "Leaving…" : "Order on my own"}
    </Button>
  );
}
