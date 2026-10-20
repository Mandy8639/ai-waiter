import { SUPPORT_CONTACT_EMAIL } from "@/lib/legal/support";

/**
 * Admin Phase 6: AI features the platform owner can switch off for one
 * restaurant, overriding its own settings (docs/admin.md). No
 * `server-only`, per the extract-the-core convention.
 */

export const RESTAURANT_AI_FEATURES = [
  "waiter",
  "staff_assistant",
  "owner_tools",
] as const;

export type RestaurantAiFeature = (typeof RESTAURANT_AI_FEATURES)[number];

export const FEATURE_LABELS: Record<
  RestaurantAiFeature,
  { label: string; covers: string }
> = {
  waiter: {
    label: "AI waiter",
    covers: 'The diners\' AI waiter ("Ask the waiter" / "Ask the Chef").',
  },
  staff_assistant: {
    label: "Staff assistant",
    covers: 'The "Waiter" button staff use for commands like "86 the salmon".',
  },
  owner_tools: {
    label: "AI menu tools",
    covers:
      "Reading menu photos, filling in dish details, nutrition and translation drafts, AI dish images.",
  },
};

export function isRestaurantAiFeature(
  value: unknown,
): value is RestaurantAiFeature {
  return (RESTAURANT_AI_FEATURES as readonly unknown[]).includes(value);
}

export const SWITCH_REASON_MAX = 200;

/**
 * What the restaurant is told when Tableside has switched a feature off.
 * Never the admin's reason: that's for the admin.
 */
export function switchedOffMessage(feature: RestaurantAiFeature): string {
  return `${FEATURE_LABELS[feature].label} has been switched off for this restaurant by Tableside. To turn it back on, contact ${SUPPORT_CONTACT_EMAIL}.`;
}

/** What a diner is told: nothing about Tableside or the owner, just that it isn't available. */
export const WAITER_OFF_FOR_DINERS =
  "The AI waiter isn't available at this restaurant.";

/**
 * The dashboard banner for a restaurant Tableside has switched something
 * off for, or null. Shown to everyone on its dashboard: the kitchen needs
 * to know the Waiter button won't work as much as the owner does.
 */
export function switchedOffNotice(
  off: ReadonlySet<RestaurantAiFeature>,
): { tone: "warning"; title: string; body: string } | null {
  const features = RESTAURANT_AI_FEATURES.filter((f) => off.has(f));
  if (features.length === 0) return null;
  const names = features.map((f) => FEATURE_LABELS[f].label);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    tone: "warning",
    title: "Switched off by Tableside",
    body: `${list} ${names.length === 1 ? "is" : "are"} switched off for this restaurant. Everything else works as usual. To turn ${names.length === 1 ? "it" : "them"} back on, contact ${SUPPORT_CONTACT_EMAIL}.`,
  };
}
