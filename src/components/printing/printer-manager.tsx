"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/dashboard/native-select";
import { isOnline } from "@/lib/printing/cloudprnt-core";
import {
  addPrinter,
  deletePrinter,
  replacePrinterUrl,
  requestPrint,
  updatePrinter,
} from "@/lib/printing/actions";

export interface PrinterView {
  id: string;
  name: string;
  role: "kitchen" | "receipt";
  station_id: string | null;
  auto_print: boolean;
  opens_drawer: boolean;
  is_active: boolean;
  client_type: string | null;
  last_seen_at: string | null;
  last_status: string | null;
  waiting: number;
  failed: number;
}

/**
 * Add a printer, get the URL to type into it, and look after the ones
 * already set up. The URL is shown once (it holds the printer's only
 * credential); "New URL" replaces it if it's lost.
 */
export function PrinterManager({
  restaurantId,
  printers,
  stations,
}: {
  restaurantId: string;
  printers: PrinterView[];
  stations: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shownUrl, setShownUrl] = useState<{
    name: string;
    url: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"kitchen" | "receipt">("kitchen");
  const [stationId, setStationId] = useState("");
  const [opensDrawer, setOpensDrawer] = useState(true);
  const now = new Date();

  function run(
    task: () => Promise<{ ok: boolean; error?: string } | { ok: true }>,
  ) {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await task();
      if (!result.ok && "error" in result)
        setError(result.error ?? "Something went wrong.");
    });
  }

  function add() {
    run(async () => {
      const result = await addPrinter({
        restaurantId,
        name,
        role,
        stationId: role === "kitchen" && stationId ? stationId : null,
        opensDrawer: role === "receipt" && opensDrawer,
      });
      if (result.ok) {
        setShownUrl({ name, url: result.url });
        setName("");
      }
      return result;
    });
  }

  function save(p: PrinterView, change: Partial<PrinterView>) {
    const next = { ...p, ...change };
    run(() =>
      updatePrinter({
        printerId: p.id,
        name: next.name,
        stationId: next.station_id,
        autoPrint: next.auto_print,
        opensDrawer: next.opens_drawer,
        isActive: next.is_active,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {shownUrl && (
        <Card className="border-primary">
          <CardContent className="flex flex-col gap-3 p-4 text-sm">
            <p className="font-medium">Server URL for {shownUrl.name}</p>
            <Input
              readOnly
              value={shownUrl.url}
              onFocus={(e) => e.target.select()}
            />
            <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
              <li>
                Print the printer&apos;s self-test page to find its IP address.
              </li>
              <li>
                Open that address in a browser on the same Wi-Fi and sign in.
              </li>
              <li>
                Under CloudPRNT: turn it on, paste this URL as the Server URL,
                set polling to 5 seconds, save and restart the printer.
              </li>
              <li>
                It shows as Online here within a minute. Then use Test print.
              </li>
            </ol>
            <p className="text-muted-foreground text-xs">
              Copy it now: it isn&apos;t shown again. Lost it? Use New URL.
            </p>
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => {
                void navigator.clipboard?.writeText(shownUrl.url);
                setNotice("URL copied.");
              }}
            >
              Copy URL
            </Button>
          </CardContent>
        </Card>
      )}

      {printers.map((p) => {
        const online = isOnline(p.last_seen_at, now);
        return (
          <Card key={p.id}>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {p.role === "kitchen"
                      ? "Kitchen tickets"
                      : "Bills & receipts"}
                    {p.station_id &&
                      ` · ${stations.find((s) => s.id === p.station_id)?.name ?? "Station"}`}
                    {p.client_type && ` · ${p.client_type}`}
                  </p>
                </div>
                <Badge variant={online ? "default" : "outline"}>
                  {online
                    ? "Online"
                    : p.last_seen_at
                      ? "Offline"
                      : "Not connected yet"}
                </Badge>
              </div>
              {(p.waiting > 0 || p.failed > 0) && (
                <p className="text-muted-foreground text-xs">
                  {p.waiting > 0 && `${p.waiting} waiting to print. `}
                  {p.failed > 0 &&
                    `${p.failed} couldn't print (check paper and cover).`}
                </p>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <Switch
                    checked={p.auto_print}
                    disabled={pending}
                    onCheckedChange={(v) => save(p, { auto_print: v })}
                  />
                  {p.role === "kitchen" ? "Print new orders" : "Print receipts"}
                </label>
                {p.role === "receipt" && (
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={p.opens_drawer}
                      disabled={pending}
                      onCheckedChange={(v) => save(p, { opens_drawer: v })}
                    />
                    Opens cash drawer
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <Switch
                    checked={p.is_active}
                    disabled={pending}
                    onCheckedChange={(v) => save(p, { is_active: v })}
                  />
                  On
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const r = await requestPrint({
                        restaurantId,
                        kind: "test",
                        printerId: p.id,
                      });
                      if (r.ok) setNotice(`Test page sent to ${p.name}.`);
                      return r;
                    })
                  }
                >
                  Test print
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const r = await replacePrinterUrl(p.id);
                      if (r.ok) setShownUrl({ name: p.name, url: r.url });
                      return r;
                    })
                  }
                >
                  New URL
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`Remove ${p.name}?`))
                      run(() => deletePrinter(p.id));
                  }}
                >
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <p className="font-medium">Add a printer</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="printer-name">Name</Label>
              <Input
                id="printer-name"
                value={name}
                maxLength={60}
                placeholder="Kitchen pass, Front counter…"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="printer-role">Prints</Label>
              <NativeSelect
                id="printer-role"
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as "kitchen" | "receipt")
                }
              >
                <option value="kitchen">Kitchen tickets</option>
                <option value="receipt">Bills &amp; receipts</option>
              </NativeSelect>
            </div>
            {role === "kitchen" && stations.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="printer-station">Station</Label>
                <NativeSelect
                  id="printer-station"
                  value={stationId}
                  onChange={(e) => setStationId(e.target.value)}
                >
                  <option value="">Every dish</option>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} only
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {role === "receipt" && (
              <label className="flex items-center gap-2 text-sm sm:pt-6">
                <Switch
                  checked={opensDrawer}
                  onCheckedChange={setOpensDrawer}
                />
                A cash drawer is plugged into it
              </label>
            )}
          </div>
          <Button
            type="button"
            className="self-start"
            disabled={pending || !name.trim()}
            onClick={add}
          >
            Add printer
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
