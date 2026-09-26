/**
 * Sends one email through Resend's REST API (phase F).
 *
 * A plain fetch rather than the `resend` package: it is one POST, and the
 * endpoint is a parameter so tests can point it at a local server — the
 * same shape as src/lib/ai/providers/openrouter-model-call.ts. No
 * `server-only`, for the same reason; the API key only ever arrives here
 * from server code (src/lib/email/dispatch.ts).
 */
import type { EmailMessage } from "./templates";
import type { ProviderResult } from "./send-core";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendWithResend(options: {
  apiKey: string;
  from: string;
  to: string;
  message: EmailMessage;
  idempotencyKey: string;
  endpoint?: string;
  timeoutMs?: number;
}): Promise<ProviderResult> {
  let response: Response;
  try {
    response = await fetch(options.endpoint ?? RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat of the same key within 24 hours, so a
        // crash between our claim and our record cannot produce a second
        // copy on their side either.
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({
        from: options.from,
        to: [options.to],
        subject: options.message.subject,
        html: options.message.html,
        text: options.message.text,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return {
      ok: false,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Handled below by the status check.
  }

  if (!response.ok) {
    const message =
      (body as { message?: unknown } | null)?.message ?? response.statusText;
    return {
      ok: false,
      error: `resend ${response.status}: ${String(message)}`.slice(0, 500),
    };
  }

  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string"
    ? { ok: true, id }
    : { ok: false, error: "resend returned no message id" };
}
