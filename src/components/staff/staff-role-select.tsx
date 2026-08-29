"use client";

import { useState, useTransition } from "react";
import { NativeSelect } from "@/components/dashboard/native-select";

const ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "manager", label: "Manager" },
  { value: "kitchen", label: "Kitchen" },
  { value: "staff", label: "Staff" },
];

/**
 * Changes take effect immediately on selection (like toggleTableActive's
 * form) rather than needing a separate "save" step — a role change is a
 * single, low-friction action. Reverts the visible value if the server
 * rejects it (e.g. the last-owner guard), so the UI never shows a role
 * that didn't actually get applied.
 */
export function StaffRoleSelect({
  memberId,
  currentRole,
  onChange,
}: {
  memberId: string;
  currentRole: string;
  onChange: (memberId: string, role: string) => Promise<{ error?: string }>;
}) {
  const [value, setValue] = useState(currentRole);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextRole = event.target.value;
    setValue(nextRole);
    setError(null);
    startTransition(async () => {
      const result = await onChange(memberId, nextRole);
      if (result.error) {
        setError(result.error);
        setValue(currentRole);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        value={value}
        onChange={handleChange}
        disabled={isPending}
        className="w-32"
        aria-label="Role"
      >
        {ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
