/**
 * The AI waiter's replies, parsed into a small, safe document tree.
 *
 * Models write markdown whether asked to or not, and the chat used to show
 * it verbatim — a diner saw `**Masala Dosa**` and a pipe-drawn table. This
 * turns the handful of constructs the waiter actually uses (bold, italic,
 * inline code, bullet and numbered lists, headings, tables) into a tree the
 * UI renders as ordinary React elements.
 *
 * What this deliberately does NOT do:
 * - No HTML. The output is data, rendered through React's escaping; there is
 *   no path by which model output becomes markup (spec section 37).
 * - No links. `[text](url)` keeps its text and drops the URL: the waiter
 *   has no reason to send a diner off-site, and a clickable URL chosen by a
 *   model is exactly what a prompt injection would want.
 * - No images, blockquotes, code blocks or nesting beyond one level.
 *   Anything unrecognised stays readable text.
 *
 * Pure and free of `server-only` so it is unit-tested directly.
 */

export type ChatInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: ChatInline[] }
  | { type: "em"; children: ChatInline[] }
  | { type: "code"; text: string };

export type ChatBlock =
  | { type: "paragraph"; lines: ChatInline[][] }
  | { type: "heading"; content: ChatInline[] }
  | { type: "list"; ordered: boolean; items: ChatInline[][] }
  | { type: "table"; header: ChatInline[][]; rows: ChatInline[][][] };

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    (TABLE_ROW.test(line) && next !== undefined && TABLE_SEPARATOR.test(next))
  );
}

export function parseChatMarkdown(source: string): ChatBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || HORIZONTAL_RULE.test(line)) {
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", content: parseInline(heading[1]) });
      i += 1;
      continue;
    }

    if (
      TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1])
    ) {
      const header = splitRow(line).map(parseInline);
      const rows: ChatInline[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const bullet = BULLET.test(line);
    const numbered = NUMBERED.test(line);
    if (bullet || numbered) {
      const pattern = numbered ? NUMBERED : BULLET;
      const items: ChatInline[][] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(parseInline(lines[i].match(pattern)![1]));
        i += 1;
        // A wrapped continuation line ("  that one is mild") belongs to
        // the item above it, not to a new paragraph.
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !pattern.test(lines[i])
        ) {
          items[items.length - 1].push(
            { type: "text", text: " " },
            ...parseInline(lines[i].trim()),
          );
          i += 1;
        }
      }
      blocks.push({ type: "list", ordered: numbered, items });
      continue;
    }

    const paragraph: ChatInline[][] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HORIZONTAL_RULE.test(lines[i]) &&
      !isBlockStart(lines[i], lines[i + 1])
    ) {
      paragraph.push(parseInline(lines[i].trim()));
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraph });
    } else {
      // A line that looked like a block start but was not one (e.g. a
      // lone "|" row with no separator) — keep it as text, never drop it.
      blocks.push({ type: "paragraph", lines: [parseInline(line.trim())] });
      i += 1;
    }
  }

  return blocks;
}

/**
 * Inline emphasis, one level deep. Unmatched markers are left as the
 * characters they are — a lone asterisk in "5* rating" is text, not the
 * start of italics that swallows the rest of the reply.
 */
export function parseInline(text: string): ChatInline[] {
  const withoutLinks = text.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
  const out: ChatInline[] = [];
  const pattern =
    /(\*\*|__)(.+?)\1|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(withoutLinks)) !== null) {
    if (match.index > last) {
      out.push({ type: "text", text: withoutLinks.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      out.push({ type: "strong", children: parseInline(match[2]) });
    } else if (match[3] !== undefined) {
      out.push({ type: "em", children: [{ type: "text", text: match[3] }] });
    } else if (match[4] !== undefined) {
      out.push({ type: "code", text: match[4] });
    }
    last = match.index + match[0].length;
  }
  if (last < withoutLinks.length) {
    out.push({ type: "text", text: withoutLinks.slice(last) });
  }
  return out;
}

/** Plain text of a reply, for screen-reader labels and previews. */
export function chatPlainText(source: string): string {
  const flatten = (inlines: ChatInline[]): string =>
    inlines
      .map((node) =>
        node.type === "text" || node.type === "code"
          ? node.text
          : flatten(node.children),
      )
      .join("");
  return parseChatMarkdown(source)
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return block.lines.map(flatten).join(" ");
        case "heading":
          return flatten(block.content);
        case "list":
          return block.items.map(flatten).join("; ");
        case "table":
          return [block.header, ...block.rows]
            .map((row) => row.map(flatten).join(", "))
            .join("; ");
      }
    })
    .join("\n");
}
