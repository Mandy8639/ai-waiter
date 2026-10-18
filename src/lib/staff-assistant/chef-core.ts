import type { ChefMotion, ChefPose } from "@/lib/chef/core";
import type { AssistantReply } from "./plan-core";

/**
 * The staff side's Chef: which face goes with which moment. Like the
 * diner's (src/lib/chef/core.ts) it is presentation only — every word is
 * the server's — and it shows one moment at a time:
 *
 *   thinking  a command is being worked on
 *   welcome   nothing said yet
 *   reply     the newest reply: pleased when something was done, curious
 *             when it's asking (yes? which one?), sheepish when it failed
 *             or was refused, calm when it's just telling you something
 *
 * No `server-only`, per the extract-the-core convention.
 */

export type StaffChefMoment =
  | { placement: "thinking"; pose: "thinking"; motion: ChefMotion }
  | { placement: "welcome"; pose: "hello"; motion: ChefMotion }
  | {
      placement: "reply";
      /** Which message the Chef sits beside: the newest assistant reply. */
      messageIndex: number;
      pose: ChefPose;
      motion?: ChefMotion;
    }
  | { placement: "none" };

const POSE_FOR_TONE: Record<AssistantReply["tone"], ChefPose> = {
  done: "found",
  question: "curious",
  error: "oops",
  info: "neutral",
};

export function staffChefMoment(input: {
  pending: boolean;
  messages: ReadonlyArray<{
    from: "you" | "assistant";
    tone?: AssistantReply["tone"];
  }>;
}): StaffChefMoment {
  if (input.pending) {
    return { placement: "thinking", pose: "thinking", motion: "think" };
  }
  if (!input.messages.some((m) => m.from === "you")) {
    return { placement: "welcome", pose: "hello", motion: "wave" };
  }
  const index = input.messages.length - 1;
  const last = input.messages[index];
  if (last.from !== "assistant" || !last.tone) return { placement: "none" };
  const pose = POSE_FOR_TONE[last.tone];
  return {
    placement: "reply",
    messageIndex: index,
    pose,
    // A small nod when something was actually done.
    ...(last.tone === "done" ? { motion: "nod" as const } : {}),
  };
}
