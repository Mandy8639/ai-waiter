"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/dashboard/native-select";
import {
  WIFI_SECURITY,
  WIFI_SECURITY_LABELS,
  type GuestWifi,
  type WifiSecurity,
} from "@/lib/wifi/core";
import type { WifiFormState } from "@/lib/wifi/actions";

const initialState: WifiFormState = {};

/**
 * The restaurant's guest Wi-Fi. Controlled fields, so a refused save keeps
 * what was typed (React resets uncontrolled fields after every submit).
 */
export function GuestWifiForm({
  action,
  defaultValue,
  disabled,
}: {
  action: (prev: WifiFormState, formData: FormData) => Promise<WifiFormState>;
  defaultValue: GuestWifi | null;
  disabled: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [ssid, setSsid] = useState(defaultValue?.ssid ?? "");
  const [password, setPassword] = useState(defaultValue?.password ?? "");
  const [security, setSecurity] = useState<WifiSecurity>(
    defaultValue?.security ?? "WPA",
  );
  const [hidden, setHidden] = useState(defaultValue?.hidden ?? false);
  const locked = disabled || isPending;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>
            Saved. Reprint your table cards to add the Wi-Fi code to them.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="wifi-ssid" className="text-sm font-medium">
          Network name
        </label>
        <Input
          id="wifi-ssid"
          name="ssid"
          value={ssid}
          onChange={(e) => setSsid(e.target.value)}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. LanternGuest"
          disabled={locked}
        />
        <p className="type-caption text-muted-foreground">
          Exactly as it appears on phones. Leave it blank to turn guest Wi-Fi
          off.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="wifi-security" className="text-sm font-medium">
          Security
        </label>
        <NativeSelect
          id="wifi-security"
          name="security"
          value={security}
          onChange={(e) => setSecurity(e.target.value as WifiSecurity)}
          disabled={locked}
        >
          {WIFI_SECURITY.map((s) => (
            <option key={s} value={s}>
              {WIFI_SECURITY_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {security !== "nopass" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wifi-password" className="text-sm font-medium">
            Password
          </label>
          <Input
            id="wifi-password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            disabled={locked}
          />
          <p className="type-caption text-muted-foreground">
            Shown to guests seated at your tables and printed on table cards.
            Use your guest network, not the one your till or card reader is on.
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="hidden"
          checked={hidden}
          onChange={(e) => setHidden(e.target.checked)}
          disabled={locked}
          className="size-4"
        />
        The network is hidden (it doesn&apos;t show in phones&apos; Wi-Fi lists)
      </label>

      {!disabled && (
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
