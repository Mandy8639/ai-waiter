"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Signing out…" : "Log out"}
    </Button>
  );
}

export function LogoutButton() {
  return (
    <form action={signOut}>
      <SubmitButton />
    </form>
  );
}
