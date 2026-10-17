"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TwoFactorCodeField } from "@/components/auth/two-factor-code-field";
import { formatSetupKey } from "@/lib/auth/two-factor-core";
import {
  confirmTwoFactorSetup,
  removeTwoFactor,
  startTwoFactorSetup,
  type TwoFactorFormState,
  type TwoFactorSetup,
} from "@/lib/auth/two-factor-actions";

const initialState: TwoFactorFormState = {};

/**
 * Turning two-step verification on and off, on /account. Off: one button.
 * Setting up: scan the QR code (or type the key), then enter the first
 * code, which is what switches it on. On: a way to turn it off, behind a
 * second click.
 */
export function TwoFactorSettings({
  enabledFactorId,
}: {
  enabledFactorId: string | null;
}) {
  const router = useRouter();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();
  const [confirmingOff, setConfirmingOff] = useState(false);

  // On success, leave the setup screen and show the server's new state.
  const [confirmState, confirmAction, confirming] = useActionState(
    async (prev: TwoFactorFormState, formData: FormData) => {
      const result = await confirmTwoFactorSetup(prev, formData);
      if (result.done) {
        setSetup(null);
        router.refresh();
      }
      return result;
    },
    initialState,
  );
  const [removeState, removeAction, removing] = useActionState(
    async (prev: TwoFactorFormState, formData: FormData) => {
      const result = await removeTwoFactor(prev, formData);
      if (result.done) {
        setConfirmingOff(false);
        router.refresh();
      }
      return result;
    },
    initialState,
  );

  if (enabledFactorId && !setup) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="text-primary size-4" aria-hidden="true" />
          On. Signing in asks for a code from your authenticator app.
        </p>
        {removeState.error && (
          <Alert variant="destructive">
            <AlertDescription>{removeState.error}</AlertDescription>
          </Alert>
        )}
        {confirmingOff ? (
          <form action={removeAction} className="flex flex-col gap-3">
            <input type="hidden" name="factorId" value={enabledFactorId} />
            <p>
              Turn it off? Anyone with your password could then sign in to your
              restaurant.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="destructive" disabled={removing}>
                {removing ? "Turning off…" : "Yes, turn it off"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmingOff(false)}
                disabled={removing}
              >
                Keep it on
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setConfirmingOff(true)}>
              Turn off
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        {startError && (
          <Alert variant="destructive">
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            disabled={starting}
            onClick={() =>
              startTransition(async () => {
                setStartError(null);
                const result = await startTwoFactorSetup();
                if ("error" in result) setStartError(result.error);
                else setSetup(result.setup);
              })
            }
          >
            {starting ? "Starting…" : "Turn on two-step verification"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 text-sm">
      <ol className="flex list-decimal flex-col gap-4 pl-5">
        <li>
          Install an authenticator app on your phone if you don&apos;t have one:
          Google Authenticator, Microsoft Authenticator, or your password
          manager&apos;s.
        </li>
        <li className="flex flex-col gap-3">
          <span>In the app, add an account and scan this code.</span>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from Supabase, not an optimizable remote image */}
          <img
            src={setup.qrCode}
            alt="QR code to add Tableside to your authenticator app"
            width={176}
            height={176}
            className="rounded-lg border bg-white p-2"
          />
          <span className="text-muted-foreground">
            Can&apos;t scan it? Type this setup key into the app instead. Keep a
            copy somewhere safe: it lets you add Tableside to a new phone if you
            lose this one.
          </span>
          <code className="bg-muted w-fit rounded-md px-3 py-2 font-mono text-sm tracking-wider break-all select-all">
            {formatSetupKey(setup.secret)}
          </code>
        </li>
        <li>
          <form action={confirmAction} className="flex flex-col gap-3">
            <input type="hidden" name="factorId" value={setup.factorId} />
            <span>Enter the 6-digit code the app shows to finish.</span>
            <TwoFactorCodeField
              error={confirmState.error}
              disabled={confirming}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={confirming}>
                {confirming ? "Checking…" : "Turn on"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSetup(null)}
                disabled={confirming}
              >
                Cancel
              </Button>
            </div>
          </form>
        </li>
      </ol>
    </div>
  );
}
