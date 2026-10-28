"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/client";
import {
  extractUploadedImport,
  startMenuImport,
} from "@/lib/menu-import/actions";
import { MENU_IMPORTS_BUCKET } from "@/lib/menu-import/upload-core";
import {
  PdfPagesError,
  isPdf,
  pdfToPageImages,
} from "@/lib/menu-import/pdf-pages";

const MAX_PAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

/**
 * Uploads the chosen photographs straight to private Storage, then asks the
 * server to read them.
 *
 * Previously these were read with FileReader.readAsDataURL and posted as
 * hidden fields, so every byte crossed a server action — which is capped at
 * 1 MB by default while base64 adds about a third. Eight files of up to
 * 10 MB were offered against a ceiling of roughly one 750 KB photo, so
 * normal phone photos failed before extraction ran.
 *
 * Now the only things that cross the action are a list of content types
 * (out) and an import id (back), then the bytes go browser → Storage, and
 * finally an import id goes out again to start extraction.
 *
 * The status text is deliberately literal. Saying "Reading your menu…"
 * while bytes are still uploading is the kind of small lie that makes a
 * stalled upload look like a slow model.
 */
type Phase =
  | { name: "idle" }
  | { name: "converting" }
  | { name: "preparing" }
  | { name: "uploading"; done: number; total: number }
  | { name: "extracting" };

export function MenuImportUpload({ restaurantId }: { restaurantId: string }) {
  const [pages, setPages] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);

  const busy = phase.name !== "idle";

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setError(null);

    // A PDF becomes one photo per page, here in the browser
    // (src/lib/menu-import/pdf-pages.ts), so it counts as that many pages.
    const chosen: File[] = [];
    for (const file of Array.from(files)) {
      if (!isPdf(file)) {
        chosen.push(file);
        continue;
      }
      setPhase({ name: "converting" });
      try {
        chosen.push(...(await pdfToPageImages(file, MAX_PAGES - pages.length)));
      } catch (pdfError) {
        setPhase({ name: "idle" });
        setError(
          pdfError instanceof PdfPagesError
            ? pdfError.message
            : `"${file.name}" couldn't be read as a PDF.`,
        );
        return;
      }
      setPhase({ name: "idle" });
    }

    if (chosen.length + pages.length > MAX_PAGES) {
      setError(`Up to ${MAX_PAGES} pages at a time.`);
      return;
    }
    for (const file of chosen) {
      if (file.size > MAX_BYTES) {
        setError(`"${file.name}" is larger than 10 MB.`);
        return;
      }
      if (!ACCEPTED.includes(file.type)) {
        setError(`"${file.name}" must be a JPEG, PNG or WebP photo, or a PDF.`);
        return;
      }
    }
    setPages((current) => [...current, ...chosen]);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pages.length === 0 || busy) return;

    setError(null);
    setPhase({ name: "preparing" });

    const started = await startMenuImport(
      restaurantId,
      pages.map((file) => file.type),
    );
    if (!started.ok || !started.importId || !started.pages) {
      setPhase({ name: "idle" });
      setError(started.error ?? "Could not start the import.");
      return;
    }

    const supabase = createClient();
    for (const [index, file] of pages.entries()) {
      setPhase({ name: "uploading", done: index, total: pages.length });
      const target = started.pages[index];
      const { error: uploadError } = await supabase.storage
        .from(MENU_IMPORTS_BUCKET)
        .uploadToSignedUrl(target.path, target.token, file, {
          contentType: file.type,
        });

      if (uploadError) {
        // Extraction is never started with a missing page: a partial menu
        // would import as a partial price list, which is worse than a
        // clear failure the user can retry.
        setPhase({ name: "idle" });
        setError(
          `"${file.name}" (page ${index + 1}) could not be uploaded. Please try again.`,
        );
        return;
      }
    }

    setPhase({ name: "extracting" });
    const result = await extractUploadedImport(restaurantId, started.importId);
    // On success the action redirects, so reaching here means it failed.
    setPhase({ name: "idle" });
    setError(result?.error ?? "Could not read your menu.");
  }

  const label =
    phase.name === "converting"
      ? "Opening your PDF…"
      : phase.name === "preparing"
        ? "Preparing…"
        : phase.name === "uploading"
          ? `Uploading ${phase.done + 1} of ${phase.total}…`
          : phase.name === "extracting"
            ? "Reading your menu…"
            : "Read menu";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FileDropZone
        id="menu-pages"
        label="Photos or a PDF of your menu"
        buttonText={
          pages.length > 0 ? "Add more pages" : "Choose photos or a PDF"
        }
        accept="image/jpeg,image/png,image/webp,application/pdf"
        multiple
        disabled={busy}
        onFiles={onFiles}
        hint={
          <>
            One photo per section of your menu works best. A PDF counts one page
            per page. Up to {MAX_PAGES} pages, 10 MB each.
          </>
        }
      />

      {pages.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {pages.map((page, i) => (
            <li
              key={`${page.name}-${page.lastModified}-${i}`}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <span className="truncate">{page.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setPages((current) => current.filter((_, j) => j !== i))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || pages.length === 0}>
          {label}
        </Button>
        {phase.name === "extracting" && (
          <p className="text-muted-foreground text-sm" role="status">
            This can take up to a minute. You&apos;ll review everything before
            it&apos;s added.
          </p>
        )}
        {phase.name === "uploading" && (
          <p className="text-muted-foreground text-sm" role="status">
            Sending your photos.
          </p>
        )}
      </div>
    </form>
  );
}
