import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export function FormField({
  id,
  label,
  errors,
  children,
  hint,
}: {
  id: string;
  label: string;
  errors?: string[];
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !errors?.[0] && (
        <p className="text-muted-foreground text-sm">{hint}</p>
      )}
      {errors?.[0] && (
        <p id={`${id}-error`} className="text-destructive text-sm">
          {errors[0]}
        </p>
      )}
    </div>
  );
}
