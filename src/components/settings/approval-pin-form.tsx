"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearApprovalPin, setApprovalPin } from "@/lib/settings/pin-actions";

/**
 * Setting, changing or removing the signed-in manager's own approval PIN.
 * The PIN itself is never shown again once saved.
 */
export function ApprovalPinForm({
  restaurantId,
  hasPin,
}: {
  restaurantId: string;
  hasPin: boolean;
}) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await setApprovalPin(restaurantId, pin);
      if (result.ok) {
        setPin("");
        setMessage({
          ok: true,
          text: "Saved. Use it to approve at the table.",
        });
      } else setMessage({ ok: false, text: result.error });
    });
  }

  function remove() {
    setMessage(null);
    startTransition(async () => {
      const result = await clearApprovalPin(restaurantId);
      setMessage(
        result.ok
          ? { ok: true, text: "PIN removed." }
          : { ok: false, text: result.error },
      );
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm">
        {hasPin ? "Your PIN is set." : "You haven't set a PIN yet."}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="approval-pin">
            {hasPin ? "New PIN" : "PIN"} (4 to 6 digits)
          </Label>
          <Input
            id="approval-pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            className="w-32"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </div>
        <Button
          type="button"
          onClick={save}
          disabled={pending || pin.length < 4}
        >
          {hasPin ? "Change PIN" : "Save PIN"}
        </Button>
        {hasPin && (
          <Button
            type="button"
            variant="ghost"
            onClick={remove}
            disabled={pending}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
