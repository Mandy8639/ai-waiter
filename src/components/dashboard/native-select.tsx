import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A plain native <select>, styled to match Input — used instead of the
 * shadcn/Base UI Select for form fields that need to participate directly
 * in FormData (native selects always do; Base UI's composed Select needs
 * extra wiring for that and isn't worth it for a simple dropdown).
 */
export function NativeSelect({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
