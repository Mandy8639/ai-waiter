"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password field with an eye button that shows what was typed, so people
 * can check it before submitting. The button's label names the field
 * ("Show password", "Show confirm password") so each one is distinct to a
 * screen reader.
 */
export function PasswordInput({
  className,
  fieldLabel,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { fieldLabel: string }) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOffIcon : EyeIcon;
  const name = fieldLabel.toLowerCase();

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        disabled={disabled}
        // Browsers must not autocorrect or capitalise a visible password.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("pr-10", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? `Hide ${name}` : `Show ${name}`}
        aria-pressed={visible}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
