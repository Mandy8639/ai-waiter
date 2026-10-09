"use server";

import { requireActiveCustomerSession } from "@/lib/customer/session";
import {
  getPublicRestaurantBySlug,
  getPublicOrderSettings,
} from "@/lib/customer/restaurant";
import { sendAiMessage } from "./orchestrator";
import { getAiPersonaForSession } from "./get-persona";
import { isAiConfigured } from "./client";
import { getRecentMessages } from "./conversation";
import {
  buildRecommendationCards,
  type RecommendationCard,
} from "./recommendation-cards";
import { isSafetyQuestion } from "@/lib/chef/core";

export type { RecommendationCard };

export interface SendChatMessageResult {
  error?: string;
  reply?: string;
  orderId?: string;
  /** Dish cards for the menu items this reply names — see src/lib/ai/recommendations.ts. */
  recommendations?: RecommendationCard[];
  /**
   * True when the diner asked about allergens or a religious or medical
   * diet. Presentation only: the Chef shows its neutral face for these
   * answers (src/lib/chef/core.ts). It changes nothing the waiter says.
   */
  safety?: boolean;
}

/**
 * The customer-facing entry point into the AI waiter — everything the
 * orchestrator needs (restaurant identity, session, the
 * allow_ai_recommendations/allow_upselling toggles) is derived here from
 * the authenticated session and the restaurant's own settings, never
 * accepted as an argument from the client beyond the raw message text and
 * which restaurant's storefront the customer is currently on (itself only
 * used to look up the restaurant row — ownership is still verified against
 * the session below, not trusted from this parameter).
 */
export async function sendChatMessage(
  restaurantSlug: string,
  message: string,
): Promise<SendChatMessageResult> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };
  const { session } = sessionResult;

  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant || !restaurant.isActive) {
    return { error: "This restaurant isn't available right now." };
  }

  // The session's OWN restaurant_id (set server-side at QR scan time,
  // Batch 4) must match the restaurant this chat is for — never trust
  // that the client only ever calls this for "its own" restaurant.
  if (session.restaurantId !== restaurant.id) {
    return { error: "Your session doesn't match this restaurant." };
  }

  const orderSettings = await getPublicOrderSettings(restaurant.id);
  if (!orderSettings.allowAiRecommendations) {
    return { error: "The AI waiter isn't available at this restaurant." };
  }

  // Read from the diner's own session inside the database, never from an
  // argument, so it is always the persona of the restaurant checked above.
  const persona = await getAiPersonaForSession();

  const result = await sendAiMessage({
    restaurantId: restaurant.id,
    restaurantSlug,
    restaurantName: restaurant.name,
    customerSessionId: session.id,
    allowUpselling: orderSettings.allowUpselling,
    persona,
    message,
  });

  if (!result.ok) return { error: result.error };

  // Best effort: a card is a convenience on top of a reply the diner
  // already has, so a failed lookup drops the cards, never the reply.
  const recommendations = await buildRecommendationCards(
    restaurant.id,
    result.mentionedItems ?? [],
  ).catch(() => []);

  return {
    reply: result.reply,
    orderId: result.orderId,
    recommendations,
    safety: isSafetyQuestion(message),
  };
}

export interface ChatHistoryEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * The customer's own persisted conversation (user/assistant turns only —
 * 'tool' rows are an internal audit log, never shown), so reopening the
 * chat panel — or reloading the page — doesn't lose context the model
 * itself still remembers (spec section 20). RLS
 * (ai_conversation_messages_select_own) scopes this to the caller's own
 * session; requireActiveCustomerSession() here is only for the friendlier
 * "no session" message, same non-security-boundary role documented
 * throughout src/lib/customer/ and src/lib/orders/.
 */
export async function getChatHistory(): Promise<ChatHistoryEntry[]> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return [];

  const messages = await getRecentMessages(sessionResult.session.id);
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

/**
 * Whether to even offer the AI waiter entry point in the UI — checks both
 * that a provider key is configured (spec section 32: AI is optional) and
 * that this specific restaurant has opted in. Never the sole security
 * boundary (sendChatMessage re-checks both independently), just what
 * decides whether the floating button renders at all.
 */
export async function isAiWaiterAvailable(
  restaurantSlug: string,
): Promise<boolean> {
  if (!isAiConfigured()) return false;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant || !restaurant.isActive) return false;
  const settings = await getPublicOrderSettings(restaurant.id);
  return settings.allowAiRecommendations;
}
