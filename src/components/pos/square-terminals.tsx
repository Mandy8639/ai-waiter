"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SquareActionState } from "@/lib/pos/square/actions";

type Action = (
  prev: SquareActionState,
  formData: FormData,
) => Promise<SquareActionState>;

export interface TerminalRow {
  id: string;
  name: string;
  status: "pairing" | "paired";
  pairingCode: string | null;
  pairBy: string | null;
}

function Result({ state }: { state: SquareActionState }) {
  if (!state.error && !state.success) return null;
  return (
    <Alert variant={state.error ? "destructive" : "default"}>
      <AlertDescription>{state.error ?? state.success}</AlertDescription>
    </Alert>
  );
}

/**
 * Square Terminals on Settings → Point of sale (phase 3). Pairing: Square
 * gives a code, the owner signs in on the Terminal with it, then checks.
 * In Square's test mode, its fake Terminals can be added instead, so the
 * whole flow can be tried without hardware.
 */
export function SquareTerminals({
  terminals,
  canPair,
  testTerminals,
  pairAction,
  checkAction,
  removeAction,
  addTestAction,
}: {
  terminals: TerminalRow[];
  /** The connection includes Square's device permission (connected after phase 3). */
  canPair: boolean;
  /** Square's sandbox Terminals; empty outside test mode. */
  testTerminals: { deviceId: string; name: string }[];
  pairAction: Action;
  checkAction: Action;
  removeAction: Action;
  addTestAction: Action;
}) {
  const [pairState, pair, pairing] = useActionState(pairAction, {});
  const [checkState, check, checking] = useActionState(checkAction, {});
  const [removeState, remove, removing] = useActionState(removeAction, {});
  const [testState, addTest, addingTest] = useActionState(addTestAction, {});

  return (
    <div className="flex flex-col gap-5">
      <Result state={checkState} />
      <Result state={removeState} />

      {terminals.length === 0 ? (
        <p className="text-muted-foreground text-sm">No Terminals yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {terminals.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 font-medium">
                  {t.name}
                  <Badge variant="outline">
                    {t.status === "paired" ? "Paired" : "Waiting to pair"}
                  </Badge>
                </span>
                {t.status === "pairing" && t.pairingCode && (
                  <span className="text-muted-foreground">
                    On the Terminal, sign in with a device code and enter{" "}
                    <span className="text-foreground font-mono text-base font-semibold">
                      {t.pairingCode}
                    </span>
                    {t.pairBy
                      ? ` before ${new Date(t.pairBy).toLocaleTimeString()}`
                      : ""}
                    .
                  </span>
                )}
              </span>
              <span className="flex gap-2">
                {t.status === "pairing" && (
                  <form action={check}>
                    <input type="hidden" name="deviceRowId" value={t.id} />
                    <Button type="submit" size="sm" disabled={checking}>
                      {checking ? "Checking…" : "Check pairing"}
                    </Button>
                  </form>
                )}
                <form action={remove}>
                  <input type="hidden" name="deviceRowId" value={t.id} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="ghost"
                    disabled={removing}
                  >
                    Remove
                  </Button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}

      {canPair ? (
        <form action={pair} className="flex flex-col gap-2">
          <Result state={pairState} />
          <label htmlFor="terminal-name" className="text-sm font-medium">
            Pair a Square Terminal
          </label>
          <div className="flex gap-2">
            <Input
              id="terminal-name"
              name="name"
              placeholder="Front counter"
              maxLength={60}
              disabled={pairing}
            />
            <Button type="submit" variant="outline" disabled={pairing}>
              {pairing ? "Getting a code…" : "Get pairing code"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">
          To pair a Terminal, disconnect and connect Square again: this
          connection was made before Terminal support.
        </p>
      )}

      {testTerminals.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <Result state={testState} />
          <p className="text-sm font-medium">Square test mode</p>
          <p className="text-muted-foreground text-sm">
            Add one of Square&apos;s simulated Terminals to try payments without
            hardware. They complete payments up to $25.
          </p>
          <div className="flex flex-wrap gap-2">
            {testTerminals.map((t) => (
              <form key={t.deviceId} action={addTest}>
                <input type="hidden" name="deviceId" value={t.deviceId} />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={addingTest}
                >
                  Add {t.name}
                </Button>
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
