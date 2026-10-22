/**
 * Turning a printable document into the bytes a Star printer runs. No
 * `server-only`, per the extract-the-core convention.
 *
 * Three formats, the ones Star CloudPRNT printers report (their
 * "Encodings"):
 *   line       application/vnd.star.line / linematrix: Star Line Mode, the
 *              thermal and impact (SP700) printers' native commands.
 *   starprnt   application/vnd.star.starprnt: the mC-Print / TSP100IV
 *              command set. The same text commands as Line Mode; only the
 *              drawer pulse differs.
 *   text       text/plain: words only, for anything else.
 *
 * The command bytes match Star's own CloudPRNT plugin for WooCommerce
 * (printer_star_line.inc.php / printer_star_prnt.inc.php), which is the
 * reference implementation this follows.
 */

export type StarFormat = "line" | "starprnt" | "text";

export type DocLine =
  | {
      kind: "text";
      text: string;
      align?: "left" | "center" | "right";
      bold?: boolean;
      /** 2: double width and height, for order numbers and headings. */
      size?: 1 | 2;
    }
  /** Left text and a right-aligned amount on the same line. */
  | { kind: "pair"; left: string; right: string; bold?: boolean }
  | { kind: "rule" }
  | { kind: "feed"; lines?: number };

export interface PrintDoc {
  lines: DocLine[];
  /** Pulse the cash drawer (on the printer's DK port) before printing. */
  openDrawer?: boolean;
  /** Feed and cut after the last line. Off for a drawer-only job. */
  cut?: boolean;
}

export interface RenderOptions {
  format: StarFormat;
  /** Characters per line at normal size: 48 (80mm thermal), 42 (impact), 32 (58mm). */
  columns: number;
  /** UTF-8 text (newer printers); otherwise code page 1252. */
  utf8: boolean;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const ALIGN: Record<"left" | "center" | "right", number> = {
  left: 0,
  center: 1,
  right: 2,
};

/**
 * Text a code-page-1252 printer can print: accents dropped where that
 * keeps the letter ("crème" -> "creme"), anything else outside Latin-1
 * becomes "?". Dish names in other scripts need a UTF-8 printer.
 */
export function toLatin1(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/₹/g, "Rs")
    .replace(/[^\x00-\xff]/g, "?");
}

/**
 * Wraps text to a width, breaking at spaces where it can. A leading indent
 * ("   + Family") is kept, on every line the text wraps onto.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const indent = (/^ */.exec(paragraph)?.[0] ?? "").slice(
      0,
      Math.max(0, width - 1),
    );
    const room = width - indent.length;
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > room) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(rest.slice(0, room));
        rest = rest.slice(room);
      }
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= room) line += ` ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
    out.push(...lines.map((l) => (l ? indent + l : l)));
  }
  return out;
}

/** "2 x Biryani ........ $32.00": the amount on the last line, whole. */
export function pairLines(
  left: string,
  right: string,
  width: number,
): string[] {
  const lefts = wrap(left, width);
  const last = lefts.pop() ?? "";
  if (last.length + 1 + right.length <= width) {
    return [...lefts, last.padEnd(width - right.length) + right];
  }
  return [...lefts, last, right.padStart(width)];
}

/** The document as plain lines of text, the way it will read on paper. */
export function docToText(doc: PrintDoc, columns: number): string[] {
  const out: string[] = [];
  for (const line of doc.lines) {
    if (line.kind === "rule") out.push("-".repeat(columns));
    else if (line.kind === "feed") {
      for (let i = 0; i < (line.lines ?? 1); i++) out.push("");
    } else if (line.kind === "pair") {
      out.push(...pairLines(line.left, line.right, columns));
    } else {
      const width = line.size === 2 ? Math.floor(columns / 2) : columns;
      for (const part of wrap(line.text, width)) {
        if (line.align === "center") {
          const pad = Math.max(0, Math.floor((width - part.length) / 2));
          out.push(" ".repeat(pad) + part);
        } else if (line.align === "right") out.push(part.padStart(width));
        else out.push(part);
      }
    }
  }
  return out;
}

class Bytes {
  private parts: number[] = [];
  constructor(private readonly utf8: boolean) {}
  raw(...bytes: number[]) {
    this.parts.push(...bytes);
  }
  text(text: string) {
    if (this.utf8) {
      this.parts.push(...new TextEncoder().encode(text));
    } else {
      for (const ch of toLatin1(text)) this.parts.push(ch.charCodeAt(0));
    }
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** The drawer pulse: 200ms on, 200ms off, on the first DK circuit. */
function drawerPulse(out: Bytes, format: StarFormat) {
  if (format === "starprnt") {
    out.raw(ESC, GS, 0x19, 0x11, 0x01, 0x0a, 0x0a);
    out.raw(ESC, GS, 0x19, 0x12, 0x01, 0x01, 0x00);
  } else {
    out.raw(ESC, GS, 0x07, 0x01, 0x0a, 0x0a);
  }
}

export function renderDoc(doc: PrintDoc, options: RenderOptions): Uint8Array {
  const { format, columns, utf8 } = options;
  const out = new Bytes(utf8 || format === "text");

  if (format === "text") {
    out.text(docToText(doc, columns).join("\n") + "\n");
    return out.done();
  }

  out.raw(ESC, 0x40); // initialise
  if (utf8) {
    out.raw(ESC, GS, 0x29, 0x55, 0x02, 0x00, 0x30, 0x01);
    out.raw(ESC, GS, 0x29, 0x55, 0x02, 0x00, 0x40, 0x00);
  } else {
    out.raw(ESC, GS, 0x74, 0x20); // code page 1252
  }
  if (doc.openDrawer) drawerPulse(out, format);

  for (const line of doc.lines) {
    if (line.kind === "rule") {
      out.raw(ESC, GS, 0x61, ALIGN.left);
      out.text("-".repeat(columns));
      out.raw(LF);
    } else if (line.kind === "feed") {
      for (let i = 0; i < (line.lines ?? 1); i++) out.raw(LF);
    } else if (line.kind === "pair") {
      out.raw(ESC, GS, 0x61, ALIGN.left);
      if (line.bold) out.raw(ESC, 0x45);
      for (const part of pairLines(line.left, line.right, columns)) {
        out.text(part);
        out.raw(LF);
      }
      if (line.bold) out.raw(ESC, 0x46);
    } else {
      const big = line.size === 2;
      const width = big ? Math.floor(columns / 2) : columns;
      out.raw(ESC, GS, 0x61, ALIGN[line.align ?? "left"]);
      if (line.bold) out.raw(ESC, 0x45);
      if (big) out.raw(ESC, 0x69, 0x01, 0x01);
      for (const part of wrap(line.text, width)) {
        out.text(part);
        out.raw(LF);
      }
      if (big) out.raw(ESC, 0x69, 0x00, 0x00);
      if (line.bold) out.raw(ESC, 0x46);
    }
  }

  if (doc.cut !== false) {
    out.raw(LF, LF);
    out.raw(ESC, 0x64, 0x03); // feed to the cutter, partial cut
  }
  return out.done();
}
