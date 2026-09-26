import "server-only";

/**
 * Owner email configuration (phase F).
 *
 * Optional, like push: with no RESEND_API_KEY, nothing is sent and nothing
 * fails — the daily job reports "not configured" and the webhooks carry on
 * without alerting.
 */
export interface EmailConfig {
  apiKey: string;
  /** "Tableside <hello@mail.tableside.menu>" — the domain verified in Resend. */
  from: string;
  /** Where links in emails point. Always the primary address, never whichever host a job happened to run on. */
  appUrl: string;
}

export function emailConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    from:
      process.env.EMAIL_FROM?.trim() || "Tableside <hello@mail.tableside.menu>",
    appUrl: (process.env.APP_URL?.trim() || "https://tableside.menu").replace(
      /\/$/,
      "",
    ),
  };
}
