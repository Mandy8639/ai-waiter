"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Nfc } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  canWriteNfc,
  needsBiggerTag,
  nfcErrorMessage,
  tableTagMessage,
} from "@/lib/nfc/core";

/** The slice of Web NFC this uses (Chrome on Android); not in TypeScript's DOM types. */
interface NdefWriter {
  write(
    message: ReturnType<typeof tableTagMessage>,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  makeReadOnly(options?: { signal?: AbortSignal }): Promise<void>;
}

type Step = "idle" | "writing" | "locking" | "done" | "error";

/**
 * Writes this table's link onto an NFC sticker. Locked by default: an
 * unlocked tag can be rewritten by anyone with a phone, to point guests at
 * a fake page they'd trust because it's on the table. Locking is
 * permanent, so a changed link means a new sticker.
 */
export function NfcTagWriter({
  url,
  tableLabel,
  nextTableHref,
}: {
  url: string;
  tableLabel: string;
  /** The next table's QR page, to write a whole room in one go. */
  nextTableHref: string | null;
}) {
  // Decided after mount: the server can't know which phone this is.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [lock, setLock] = useState(true);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only capability check
    setSupported(canWriteNfc(window));
    return () => abortRef.current?.abort();
  }, []);

  async function write() {
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const Reader = (window as unknown as { NDEFReader: new () => NdefWriter })
      .NDEFReader;
    const reader = new Reader();
    try {
      setStep("writing");
      await reader.write(tableTagMessage(url), {
        overwrite: true,
        signal: controller.signal,
      });
      if (lock) {
        setStep("locking");
        await reader.makeReadOnly({ signal: controller.signal });
      }
      setStep("done");
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "AbortError") {
        setStep("idle");
        return;
      }
      setError(nfcErrorMessage(name));
      setStep("error");
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setStep("idle");
  }

  const tooLong = needsBiggerTag(url);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Guests can tap their phone on an NFC sticker instead of scanning. It
        opens this table&apos;s menu, the same as the QR code.
      </p>

      {tooLong && (
        <p className="text-sm">
          This table&apos;s link is long, so use NTAG215 or NTAG216 stickers
          rather than NTAG213.
        </p>
      )}

      {supported === null ? null : supported ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={lock}
              onChange={(e) => setLock(e.target.checked)}
              disabled={step === "writing" || step === "locking"}
              className="mt-0.5 size-4"
            />
            <span>
              Lock the tag after writing{" "}
              <span className="text-muted-foreground">
                (recommended: nobody can change it later, including you)
              </span>
            </span>
          </label>

          {step === "writing" || step === "locking" ? (
            <div
              role="status"
              className="bg-muted flex flex-col items-center gap-2 rounded-lg p-4 text-center"
            >
              <Nfc className="size-8 animate-pulse" aria-hidden="true" />
              <p className="font-medium">
                {step === "writing"
                  ? "Hold the sticker against the back of the phone"
                  : "Keep holding: locking the tag"}
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button type="button" onClick={() => void write()}>
              <Nfc className="size-4" aria-hidden="true" />
              {step === "done" ? "Write another tag" : "Write to tag"}
            </Button>
          )}

          {step === "done" && (
            <div
              role="status"
              className="border-success/40 bg-success/5 flex flex-col gap-2 rounded-lg border p-3 text-sm"
            >
              <p className="font-medium">
                Tag written for {tableLabel}
                {lock ? " and locked." : "."}
              </p>
              <p className="text-muted-foreground">
                Tap it with your phone to check it opens the menu.
              </p>
              {nextTableHref && (
                <Link
                  href={nextTableHref}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Next table
                </Link>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Writing tags from the browser works in Chrome on Android. On an
            iPhone or a computer, use the free <strong>NFC Tools</strong> app:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Copy this table&apos;s link (Copy URL, above).</li>
            <li>
              In NFC Tools: Write → Add a record → URL, and paste the link.
            </li>
            <li>
              Tap Write and hold the sticker to the phone. Then use Other → Lock
              tag, so nobody can change it.
            </li>
          </ol>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Stickers: NTAG213, about 25mm, a few dozen cents each. On metal tables
        or stands, use &ldquo;anti-metal&rdquo; NFC tags; ordinary ones
        don&apos;t work on metal.
      </p>
    </div>
  );
}
