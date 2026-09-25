import "server-only";

/**
 * VAPID keys for kitchen push (phase F).
 *
 * VAPID is how a push service knows a message really comes from the server
 * that the device subscribed to: we sign each push with the private key,
 * and the browser subscribed using the public one. Generated once, locally
 * (`npx web-push generate-vapid-keys`), free, no account anywhere.
 *
 * Optional, like the AI key: with no keys configured, push is simply off —
 * the kitchen page hides its "Turn on alerts" control and nothing tries to
 * send. Nothing else in the app depends on it.
 *
 * Changing the keys invalidates every existing subscription (each was made
 * against the old public key), so rotate them only on purpose.
 */
export interface PushServerConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function pushServerConfig(): PushServerConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // A contact for push services if our pushes misbehave. A URL is
    // allowed and avoids publishing anyone's personal email address.
    subject: process.env.VAPID_SUBJECT?.trim() || "https://tableside.menu",
  };
}

export function pushConfigured(): boolean {
  return pushServerConfig() !== null;
}
