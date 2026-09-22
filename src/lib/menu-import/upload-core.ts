/**
 * Transport for menu-import pages: the browser uploads photographs straight
 * to private Storage, and the server action carries only references.
 *
 * WHY THIS EXISTS
 *
 * Pages used to be read with FileReader.readAsDataURL and posted as hidden
 * form fields, so every byte travelled inside one server-action request.
 * A Next.js action body is capped at 1 MB by default
 * (node_modules/next/dist/docs, serverActions) and next.config.ts does not
 * raise it, while base64 inflates bytes by about a third. The practical
 * ceiling was a single ~750 KB photo; a 3 MB phone photo became ~4.1 MB
 * against a 1 MB cap, and the uploader offered eight files of up to 10 MB.
 * Normal phone photos failed before extraction ever ran.
 *
 * The fix is transport only. Extraction still receives data URLs and is
 * completely unchanged — they are simply built on the server, after
 * fetching the objects, instead of in the browser. The invariant that
 * matters is that large base64 payloads never travel browser → server
 * action.
 *
 * `menu_imports.source_paths` already existed for exactly this ("Storage
 * object paths for the uploaded pages, in the order the user added them"),
 * so no schema change is needed; the column was simply never used.
 *
 * NOT THE PHASE 2 LIFECYCLE. Import pages are working material, not dish
 * photos: no menu_item_images row, no variants, no review/publish states,
 * nothing public, never shown to diners. Only the genuinely generic pieces
 * are shared — the StorageGateway interface and isValidObjectPath.
 */
import { isValidObjectPath } from "@/lib/menu-images/paths";
import type { StorageGateway } from "@/lib/menu-images/upload-core";

/** The existing private bucket from 20260904120000_menu_imports.sql. */
export const MENU_IMPORTS_BUCKET = "menu-imports";

/** Unchanged from the previous uploader, so nothing a user could do before now fails. */
export const MAX_PAGES = 8;
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;

/**
 * What the bucket itself allows. PDFs are in the bucket's own
 * allowed_mime_types but the uploader has only ever offered images, and
 * extraction sends image parts, so this stays images.
 */
const EXTENSION_BY_TYPE: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ImportUploadRejected extends Error {
  constructor(
    readonly code:
      | "TOO_MANY_PAGES"
      | "NO_PAGES"
      | "UNSUPPORTED_FORMAT"
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "MISSING_OBJECT"
      | "INVALID_PATH",
    message: string,
  ) {
    super(message);
    this.name = "ImportUploadRejected";
  }
}

/** The folder one import's pages live in. */
export function importPrefix(restaurantId: string, importId: string): string {
  for (const [name, value] of Object.entries({ restaurantId, importId })) {
    if (!UUID.test(value)) {
      throw new ImportUploadRejected(
        "INVALID_PATH",
        `menu import path: ${name} is not a uuid`,
      );
    }
  }
  return `${restaurantId}/${importId}/`;
}

/**
 * `{restaurant_id}/{import_id}/page-{n}.{ext}` — the restaurant-first shape
 * the existing menu-imports storage policies scope on
 * ((storage.foldername(name))[1]), with the import id beneath it so one
 * import's pages are a single folder.
 *
 * The index is part of the key so ordering survives in Storage as well as
 * in source_paths; a menu's categories routinely continue across a page
 * break, and extraction reads the pages as one document.
 */
export function importPagePath(
  restaurantId: string,
  importId: string,
  index: number,
  extension: "jpg" | "png" | "webp",
): string {
  return `${importPrefix(restaurantId, importId)}page-${index + 1}.${extension}`;
}

/** True when `path` is a plain file directly inside this import's own folder. */
export function isValidImportPagePath(
  path: string,
  restaurantId: string,
  importId: string,
): boolean {
  return isValidObjectPath(path, importPrefix(restaurantId, importId));
}

export interface ImportRecords {
  /** Inserts the menu_imports row with a server-chosen id and its page paths. */
  create(input: {
    importId: string;
    restaurantId: string;
    sourcePaths: string[];
  }): Promise<void>;
  /** The row, read through RLS — another restaurant's import is simply absent. */
  load(importId: string): Promise<{
    restaurantId: string;
    status: string;
    sourcePaths: string[];
  } | null>;
}

export interface AuthorizedPage {
  index: number;
  path: string;
  signedUrl: string;
  token: string;
}

export interface AuthorizedImport {
  importId: string;
  pages: AuthorizedPage[];
}

/**
 * Creates the import row and one upload credential per page.
 *
 * Every key is computed here from the restaurant id the caller was already
 * authorized for and an import id minted on the server. A client supplies
 * only how many pages it has and what type each one is; it can neither
 * choose a key nor reach another restaurant's folder, and the signed token
 * is bound by Supabase to a single object path.
 */
export async function authorizeImportUpload(
  {
    restaurantId,
    contentTypes,
  }: { restaurantId: string; contentTypes: string[] },
  deps: { records: ImportRecords; storage: StorageGateway },
): Promise<AuthorizedImport> {
  if (contentTypes.length === 0) {
    throw new ImportUploadRejected(
      "NO_PAGES",
      "Add at least one photo of your menu.",
    );
  }
  if (contentTypes.length > MAX_PAGES) {
    throw new ImportUploadRejected(
      "TOO_MANY_PAGES",
      `Please import up to ${MAX_PAGES} pages at a time.`,
    );
  }

  const importId = crypto.randomUUID();
  const extensions = contentTypes.map((type) => {
    const extension = EXTENSION_BY_TYPE[type];
    if (!extension) {
      throw new ImportUploadRejected(
        "UNSUPPORTED_FORMAT",
        "Menu photos must be JPEG, PNG or WebP.",
      );
    }
    return extension;
  });

  const paths = extensions.map((extension, index) =>
    importPagePath(restaurantId, importId, index, extension),
  );

  // The row is written before any bytes exist, so an abandoned import is a
  // visible 'uploaded' row with known paths rather than untracked objects.
  await deps.records.create({ importId, restaurantId, sourcePaths: paths });

  const pages: AuthorizedPage[] = [];
  for (const [index, path] of paths.entries()) {
    const { signedUrl, token } = await deps.storage.createSignedUploadUrl(
      MENU_IMPORTS_BUCKET,
      path,
    );
    pages.push({ index, path, signedUrl, token });
  }

  return { importId, pages };
}

/**
 * Fetches this import's pages and returns them as data URLs, in order.
 *
 * The paths come from the import row the server itself wrote — never from
 * the request — so a caller cannot point extraction at another
 * restaurant's object by submitting its path. They are re-checked against
 * the import's own folder anyway, and the row is read through RLS, so
 * another restaurant's import is not visible in the first place.
 *
 * Building the data URL here is the deliberate half of the fix: extraction
 * still receives exactly what it always did, but the bytes travel
 * Storage → server rather than browser → server action.
 */
export async function loadImportPageDataUrls(
  importId: string,
  restaurantId: string,
  deps: { records: ImportRecords; storage: StorageGateway },
): Promise<string[]> {
  const record = await deps.records.load(importId);
  if (!record) {
    throw new ImportUploadRejected(
      "NOT_FOUND",
      "That menu import could not be found.",
    );
  }
  if (record.restaurantId !== restaurantId) {
    // Belt and braces: RLS already hides another restaurant's import.
    throw new ImportUploadRejected(
      "FORBIDDEN",
      "That menu import belongs to another restaurant.",
    );
  }
  if (record.sourcePaths.length === 0) {
    throw new ImportUploadRejected(
      "NO_PAGES",
      "That import has no uploaded pages.",
    );
  }

  const dataUrls: string[] = [];
  for (const [index, path] of record.sourcePaths.entries()) {
    if (!isValidImportPagePath(path, restaurantId, importId)) {
      throw new ImportUploadRejected(
        "INVALID_PATH",
        "That menu import refers to an unexpected file.",
      );
    }

    let body: Buffer;
    try {
      body = await deps.storage.download(MENU_IMPORTS_BUCKET, path);
    } catch {
      // A page that never finished uploading must stop the whole import:
      // extracting from a menu with a missing page silently produces a
      // partial price list, which is worse than a clear failure.
      throw new ImportUploadRejected(
        "MISSING_OBJECT",
        `Page ${index + 1} was not uploaded. Please try again.`,
      );
    }

    const extension = path.split(".").pop() ?? "";
    const contentType = CONTENT_TYPE_BY_EXTENSION[extension] ?? "image/jpeg";
    dataUrls.push(`data:${contentType};base64,${body.toString("base64")}`);
  }

  return dataUrls;
}
