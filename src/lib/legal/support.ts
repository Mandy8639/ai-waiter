import { PRIVACY_CONTACT_EMAIL } from "./privacy";

/**
 * The support page (src/app/support/page.tsx): the App Store listing's
 * required Support URL, and linked from the landing page and sign-in.
 *
 * SUPPORT_CONTACT_EMAIL is the privacy address for now because it's the
 * one tableside.menu address that forwards today (Porkbun). To use a
 * support@ address, add the forward in Porkbun first, then change it here.
 */
export const SUPPORT_CONTACT_EMAIL = PRIVACY_CONTACT_EMAIL;

export const SUPPORT_PATH = "/support";
