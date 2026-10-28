"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MenuImportState } from "@/lib/menu-import/actions";

/**
 * Import from the link to the restaurant's own menu or online ordering
 * page (importMenuFromLink). On success the action goes straight to the
 * review page, like a photo import.
 */
export function MenuImportLink({
  action,
}: {
  action: (
    state: MenuImportState,
    formData: FormData,
  ) => Promise<MenuImportState>;
}) {
  const [state, submit, reading] = useActionState(action, {});

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="menu-link">Link to your menu</Label>
        <Input
          id="menu-link"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://yourrestaurant.com/menu"
          required
          disabled={reading}
        />
        <p className="text-muted-foreground text-xs">
          Your website&apos;s menu page, or your online ordering page.
        </p>
      </div>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={reading}>
          {reading ? "Reading the page…" : "Read menu from link"}
        </Button>
        {reading && (
          <p className="text-muted-foreground text-sm" role="status">
            This can take up to a minute.
          </p>
        )}
      </div>
    </form>
  );
}
