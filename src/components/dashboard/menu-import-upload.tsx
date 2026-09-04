"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  createAndExtractImport,
  type MenuImportState,
} from "@/lib/menu-import/actions";

const MAX_PAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Reads the chosen photographs in the browser and posts them as data URLs.
 *
 * Deliberately not uploading to storage first. The extraction call needs
 * the image bytes anyway, and going via a bucket would mean a round trip,
 * a signed URL, and an orphaned object every time an import is abandoned —
 * for a file the restaurant already has on their phone. The bucket in the
 * migration exists for keeping a copy of what was read, which is a
 * separate, later concern from making the import work.
 */
export function MenuImportUpload({ restaurantId }: { restaurantId: string }) {
  const [state, action, pending] = useActionState<MenuImportState, FormData>(
    createAndExtractImport.bind(null, restaurantId),
    {},
  );
  const [pages, setPages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setLocalError(null);

    const chosen = Array.from(files);
    if (chosen.length + pages.length > MAX_PAGES) {
      setLocalError(`Up to ${MAX_PAGES} pages at a time.`);
      return;
    }

    const read: { name: string; dataUrl: string }[] = [];
    for (const file of chosen) {
      if (file.size > MAX_BYTES) {
        setLocalError(`"${file.name}" is larger than 10 MB.`);
        return;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      read.push({ name: file.name, dataUrl });
    }
    setPages((current) => [...current, ...read]);
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      {pages.map((page) => (
        <input
          key={page.dataUrl.slice(-32)}
          type="hidden"
          name="page"
          value={page.dataUrl}
        />
      ))}

      <div className="flex flex-col gap-2">
        <label htmlFor="menu-pages" className="text-sm font-medium">
          Photos of your menu
        </label>
        <input
          id="menu-pages"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={pending}
          onChange={(e) => void onFiles(e.target.files)}
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          One photo per section of your menu works best. Up to {MAX_PAGES}{" "}
          pages, 10 MB each.
        </p>
      </div>

      {pages.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {pages.map((page, i) => (
            <li
              key={page.dataUrl.slice(-32)}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <span className="truncate">{page.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
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

      {(localError || state.error) && (
        <Alert variant="destructive">
          <AlertDescription>{localError ?? state.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || pages.length === 0}>
          {pending ? "Reading your menu…" : "Read menu"}
        </Button>
        {pending && (
          <p className="text-muted-foreground text-sm" role="status">
            This can take up to a minute. You&apos;ll review everything before
            it&apos;s added.
          </p>
        )}
      </div>
    </form>
  );
}
