"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/client";
import {
  confirmLegacyPhotoAuthentic,
  finishMenuPhotoUpload,
  generateMenuPhoto,
  previewMenuPhoto,
  publishMenuPhoto,
  rejectMenuPhoto,
  removeMenuPhoto,
  startMenuPhotoUpload,
} from "@/lib/menu-images/actions";
import { PRIVATE_BUCKET } from "@/lib/menu-images/paths";
import type { OwnerPhotoState } from "@/lib/menu-images/owner-state";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Photo management for one dish, in the Menu workflow rather than a
 * separate media product.
 *
 * The states an owner can be in are deliberately few: there is a photo, a
 * photo is waiting to be accepted, or there is none. Everything else —
 * uploading, processing, superseded, rejected — is either a transient
 * message or something they never need to name.
 *
 * Nothing here can publish by accident. A processed photo always stops at
 * "waiting for you", and only "Use this photo" makes it visible to diners.
 */
type Phase =
  | { name: "idle" }
  | { name: "preparing" }
  | { name: "uploading" }
  | { name: "processing" }
  | { name: "generating" }
  | { name: "working" };

export function DishPhotoManager({
  restaurantId,
  menuItemId,
  dishName,
  initial,
  generation,
}: {
  restaurantId: string;
  menuItemId: string;
  dishName: string;
  initial: OwnerPhotoState;
  /**
   * Whether an image generator is configured, decided on the server so the
   * browser never learns which model or provider is in use. Today this is
   * always unavailable — see src/lib/menu-images/generation-provider.ts.
   */
  generation: { available: boolean; message?: string };
}) {
  const [state, setState] = useState(initial);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [declared, setDeclared] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<{
    imageId: string;
    url: string;
  } | null>(null);

  const busy = phase.name !== "idle";

  // A pending photo lives in the private bucket, so it cannot be linked to
  // directly; the server signs a short-lived read URL for review.
  //
  // The URL is keyed by image id rather than cleared in this effect: a bare
  // setState for the "no pending photo" case would fire on every render
  // that has none, which is both wasteful and what
  // react-hooks/set-state-in-effect warns about. Keying means a stale URL
  // simply never matches and is never shown.
  const pendingId = state.pending?.imageId ?? null;

  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    void previewMenuPhoto(restaurantId, pendingId).then((result) => {
      if (!cancelled) {
        setPendingPreview(
          result.ok && result.url
            ? { imageId: pendingId, url: result.url }
            : null,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [restaurantId, pendingId]);

  const previewUrl =
    pendingPreview && pendingPreview.imageId === pendingId
      ? pendingPreview.url
      : null;

  function choose(files: FileList | null) {
    setError(null);
    setNotice(null);
    const chosen = files?.[0] ?? null;
    if (!chosen) return;
    if (!ACCEPTED.includes(chosen.type)) {
      setError("Photos need to be a JPEG, PNG or WebP file.");
      return;
    }
    if (chosen.size > MAX_BYTES) {
      setError("That photo is larger than 15 MB.");
      return;
    }
    setFile(chosen);
  }

  async function upload() {
    if (!file || busy) return;
    setError(null);
    setNotice(null);

    setPhase({ name: "preparing" });
    const started = await startMenuPhotoUpload(
      restaurantId,
      menuItemId,
      file.type,
    );
    if (!started.ok || !started.imageId || !started.path || !started.token) {
      setPhase({ name: "idle" });
      setError(started.error ?? "Could not start the upload.");
      return;
    }

    setPhase({ name: "uploading" });
    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .uploadToSignedUrl(started.path, started.token, file, {
        contentType: file.type,
      });
    if (uploadError) {
      setPhase({ name: "idle" });
      setError("That photo couldn't be uploaded. Please try again.");
      return;
    }

    setPhase({ name: "processing" });
    const finished = await finishMenuPhotoUpload(restaurantId, started.imageId);
    setPhase({ name: "idle" });
    if (!finished.ok) {
      setError(finished.error ?? "That photo couldn't be processed.");
      return;
    }

    setFile(null);
    setDeclared(false);
    setState((current) => ({
      ...current,
      pending: { imageId: started.imageId! },
      failed: null,
    }));
    setNotice("Photo ready. Have a look before diners see it.");
  }

  /**
   * Ask for an AI illustration. Lands in exactly the same "waiting for
   * you" state an upload does — there is deliberately no separate review
   * flow for generated images, because the decision an owner makes is the
   * same one either way: is this good enough to show a diner?
   */
  async function generate() {
    if (busy) return;
    setError(null);
    setNotice(null);
    setPhase({ name: "generating" });
    const result = await generateMenuPhoto(restaurantId, menuItemId);
    setPhase({ name: "idle" });
    if (!result.ok || !result.imageId) {
      setError(result.error ?? "The image could not be generated.");
      return;
    }
    setState((current) => ({
      ...current,
      pending: { imageId: result.imageId! },
      failed: null,
    }));
    setNotice("Illustration ready. Have a look before diners see it.");
  }

  async function run(
    work: () => Promise<{ ok: boolean; error?: string }>,
    after: (current: OwnerPhotoState) => OwnerPhotoState,
    message: string,
  ) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setPhase({ name: "working" });
    const result = await work();
    setPhase({ name: "idle" });
    if (!result.ok) {
      setError(result.error ?? "That didn't work. Please try again.");
      return;
    }
    setState(after);
    setNotice(message);
  }

  const statusLabel =
    phase.name === "preparing"
      ? "Preparing…"
      : phase.name === "uploading"
        ? "Uploading…"
        : phase.name === "processing"
          ? "Processing photo…"
          : phase.name === "generating"
            ? "Generating an illustration…"
            : phase.name === "working"
              ? "Saving…"
              : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Live region: upload progress and outcomes are announced once each,
          rather than on every render. */}
      <p aria-live="polite" className="sr-only">
        {statusLabel ?? notice ?? error ?? ""}
      </p>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Figure
          label={state.pending ? "Diners see now" : "Current photo"}
          src={state.current?.src ?? null}
          alt={state.current ? dishName : "No photo yet"}
          badge={
            state.current?.aiGenerated
              ? "AI-generated"
              : state.current?.unverified
                ? "Not confirmed"
                : null
          }
        />

        {state.pending && (
          <Figure
            label="New photo"
            src={previewUrl}
            alt={`New photo for ${dishName}`}
            pendingText={previewUrl ? null : "Loading preview…"}
          />
        )}
      </div>

      {state.pending ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            {state.current
              ? "Using the new photo replaces the one diners see now. The old one is kept for 30 days."
              : "Using this photo makes it visible to diners."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () => publishMenuPhoto(restaurantId, state.pending!.imageId),
                  () => ({ ...state, pending: null }),
                  "That photo is live for diners.",
                )
              }
            >
              Use this photo
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => rejectMenuPhoto(restaurantId, state.pending!.imageId),
                  () => ({ ...state, pending: null }),
                  "Discarded. Nothing changed for diners.",
                )
              }
            >
              Choose another
            </Button>
          </div>
        </div>
      ) : (
        <>
          <UploadControls
            hasPhoto={Boolean(state.current)}
            file={file}
            declared={declared}
            busy={busy}
            statusLabel={statusLabel}
            onChoose={choose}
            onDeclare={setDeclared}
            onUpload={() => void upload()}
          />
          <GenerateControls
            available={generation.available}
            message={generation.message}
            busy={busy}
            generating={phase.name === "generating"}
            onGenerate={() => void generate()}
          />
        </>
      )}

      {state.current?.unverified && !state.pending && (
        <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Is this a photo of your food?</p>
          <p className="text-muted-foreground text-sm">
            This image was already on your menu. Confirming records that it
            shows the dish your restaurant serves.
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    confirmLegacyPhotoAuthentic(
                      restaurantId,
                      state.current!.imageId,
                    ),
                  (current) => ({
                    ...current,
                    current: current.current
                      ? { ...current.current, unverified: false }
                      : null,
                  }),
                  "Thanks — recorded as your own photo.",
                )
              }
            >
              Yes, it&apos;s our photo
            </Button>
          </div>
        </div>
      )}

      {state.current && !state.pending && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove the photo from ${dishName}? Diners will see the dish without a photo.`,
                )
              ) {
                return;
              }
              void run(
                () => removeMenuPhoto(restaurantId, menuItemId),
                (current) => ({ ...current, current: null }),
                "Photo removed. Diners now see this dish without one.",
              );
            }}
          >
            Remove photo
          </Button>
        </div>
      )}

      {state.failed && !state.pending && (
        <Alert variant="destructive">
          <AlertDescription>
            {state.failed.error ?? "The last photo couldn't be processed."}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <p className="text-muted-foreground text-sm">{notice}</p>
      )}
    </div>
  );
}

function Figure({
  label,
  src,
  alt,
  badge,
  pendingText,
}: {
  label: string;
  src: string | null;
  alt: string;
  badge?: string | null;
  pendingText?: string | null;
}) {
  // max-w-64 keeps an empty placeholder from dominating the card, and lets
  // current and new sit side by side without either becoming a thumbnail.
  return (
    <figure className="flex max-w-64 min-w-0 flex-1 flex-col gap-1.5">
      <figcaption className="text-muted-foreground text-xs font-medium">
        {label}
      </figcaption>
      <div className="bg-muted relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed private URL or Supabase public bucket
          <img src={src} alt={alt} className="size-full object-cover" />
        ) : (
          <span className="text-muted-foreground px-3 text-center text-xs">
            {pendingText ?? "No photo yet"}
          </span>
        )}
        {badge && (
          <span className="bg-background/85 text-muted-foreground absolute bottom-1 left-1 rounded px-1.5 py-0.5 text-[0.625rem] font-medium">
            {badge}
          </span>
        )}
      </div>
    </figure>
  );
}

function UploadControls({
  hasPhoto,
  file,
  declared,
  busy,
  statusLabel,
  onChoose,
  onDeclare,
  onUpload,
}: {
  hasPhoto: boolean;
  file: File | null;
  declared: boolean;
  busy: boolean;
  statusLabel: string | null;
  onChoose: (files: FileList | null) => void;
  onDeclare: (value: boolean) => void;
  onUpload: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="dish-photo" className="text-sm font-medium">
          {hasPhoto ? "Replace photo" : "Add a photo"}
        </label>
        <input
          id="dish-photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => onChoose(e.target.files)}
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Use a photo that represents the dish your restaurant serves. JPEG, PNG
          or WebP, up to 15 MB.
        </p>
      </div>

      {file && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={declared}
            disabled={busy}
            onChange={(e) => onDeclare(e.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>This is a photo of our food</span>
        </label>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={!file || !declared || busy} onClick={onUpload}>
          {statusLabel ?? (hasPhoto ? "Upload replacement" : "Upload photo")}
        </Button>
        {statusLabel && (
          <p className="text-muted-foreground text-sm">
            {statusLabel === "Processing photo…"
              ? "Making the sizes diners will see."
              : "Sending your photo."}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The AI illustration option.
 *
 * Shown even when it cannot be used, and disabled with the reason, rather
 * than hidden. An owner who has heard the feature exists and cannot find
 * it will assume the product is broken; an owner who sees it greyed out
 * with a sentence knows where they stand. `message` is deliberately the
 * same sentence for every operational cause — a restaurant cannot act on
 * the difference between "no model configured" and "the provider is down".
 *
 * The wording never says "photo". What this produces is an illustration,
 * it is labelled "AI-generated" everywhere a diner sees it, and calling it
 * anything else here would be the first step towards it being mistaken for
 * a picture of real food.
 */
function GenerateControls({
  available,
  message,
  busy,
  generating,
  onGenerate,
}: {
  available: boolean;
  message?: string;
  busy: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="text-sm font-medium">No photo to hand?</p>
      <p className="text-muted-foreground text-xs">
        We can generate an illustration of this dish. It is clearly drawn rather
        than photographic, and diners always see it labelled
        &ldquo;AI-generated&rdquo;. You review it before anyone else does.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!available || busy}
          onClick={onGenerate}
        >
          {generating
            ? "Generating an illustration…"
            : "Generate an illustration"}
        </Button>
        {!available && message && (
          <p className="text-muted-foreground text-sm">{message}</p>
        )}
      </div>
    </div>
  );
}
