/**
 * The facts the privacy policy (src/app/privacy/page.tsx) states that other
 * places repeat: the Play Store listing links to /privacy and shows the
 * contact address, and the sign-up page links to the policy.
 *
 * PRIVACY_CONTACT_EMAIL forwards to the owner's inbox (Porkbun email
 * forwarding on tableside.menu, which has no mailbox of its own). It is
 * where data-deletion requests go, so it must keep working: check it
 * still forwards before changing DNS for tableside.menu.
 */
export const PRIVACY_CONTACT_EMAIL = "privacy@tableside.menu";

/** Shown as "Last updated". Change it whenever the policy's substance changes. */
export const PRIVACY_POLICY_UPDATED = "October 10, 2026";

export const PRIVACY_POLICY_PATH = "/privacy";
