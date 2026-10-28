"use client";

/**
 * Turns a PDF menu into one JPEG per page, in the browser, so it can go
 * through the same upload and photo reader as a photographed menu
 * (upload-core.ts, vision.ts). Nothing on the server changes: a PDF page
 * becomes exactly what a phone photo already is.
 *
 * Why the browser and not the server: the reader's models take images,
 * and rendering a PDF needs a canvas. The browser has one; a serverless
 * function would need a native canvas build. pdf.js is large, so it's
 * loaded only when someone actually picks a PDF.
 */

/** Long side of a rendered page: small print stays readable, files stay small. */
const TARGET_LONG_SIDE = 2200;
const JPEG_QUALITY = 0.85;

export class PdfPagesError extends Error {}

export function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

/**
 * Renders every page of `file` to a JPEG File, in order. Refuses a PDF with
 * more than `maxPages` pages rather than reading only some of them: half a
 * menu would import as half a price list.
 */
export async function pdfToPageImages(
  file: File,
  maxPages: number,
): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const loading = pdfjs.getDocument({ data: await file.arrayBuffer() });
  let pdf: Awaited<typeof loading.promise>;
  try {
    pdf = await loading.promise;
  } catch {
    await loading.destroy();
    throw new PdfPagesError(
      `"${file.name}" couldn't be opened. If it has a password, save a copy without one.`,
    );
  }

  try {
    if (pdf.numPages > maxPages) {
      throw new PdfPagesError(
        `"${file.name}" has ${pdf.numPages} pages. Up to ${maxPages} pages can be read at a time: save the menu pages as a smaller PDF, or upload photos.`,
      );
    }

    const base = file.name.replace(/\.pdf$/i, "");
    const pages: File[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const unscaled = page.getViewport({ scale: 1 });
      const scale =
        TARGET_LONG_SIDE / Math.max(unscaled.width, unscaled.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context)
        throw new PdfPagesError("Your browser couldn't draw the PDF.");
      // A white page underneath: PDFs are often transparent, and a
      // transparent area turns black in a JPEG.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
      );
      if (!blob) throw new PdfPagesError("Your browser couldn't draw the PDF.");
      pages.push(
        new File([blob], `${base} — page ${number}.jpg`, {
          type: "image/jpeg",
        }),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}
