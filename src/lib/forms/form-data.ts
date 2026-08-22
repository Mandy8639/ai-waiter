/** Shared FormData -> primitive coercion helpers, used by every dashboard CRUD action. */

export function emptyToUndefined(
  value: FormDataEntryValue | null,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function toNumber(
  value: FormDataEntryValue | null,
  fallback = 0,
): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/** HTML checkboxes only appear in FormData when checked, with value "on" by default. */
export function toBoolean(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true";
}
