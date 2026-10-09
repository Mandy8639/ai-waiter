import { describe, expect, it } from "vitest";
import { fallbackText, isFallbackText } from "@/lib/ai/fallback-text";
import {
  chefEnabledFor,
  chefMoment,
  isSafetyQuestion,
  type ChefMomentMessage,
} from "@/lib/chef/core";

/**
 * The Chef's rules. The one that matters most: an answer to a safety
 * question — or one whose question is unknown — never gets a happy face.
 */

const ready = { historyLoaded: true, isPending: false, hasError: false };
const user: ChefMomentMessage = { role: "user", recommendationCount: 0 };
const reply = (
  recommendationCount: number,
  safety?: boolean,
): ChefMomentMessage => ({ role: "assistant", recommendationCount, safety });

describe("chefMoment", () => {
  it("shows nothing until the conversation has loaded", () => {
    expect(
      chefMoment({ ...ready, historyLoaded: false, messages: [] }),
    ).toEqual({ placement: "none" });
  });

  it("waves hello on an empty conversation", () => {
    expect(chefMoment({ ...ready, messages: [] })).toEqual({
      placement: "welcome",
      pose: "hello",
      motion: "wave",
    });
  });

  it("thinks while a reply is on its way, over everything else", () => {
    for (const hasError of [false, true]) {
      expect(
        chefMoment({
          ...ready,
          isPending: true,
          hasError,
          messages: [user, reply(3, false), user],
        }),
      ).toEqual({ placement: "thinking", pose: "thinking", motion: "think" });
    }
    expect(chefMoment({ ...ready, isPending: true, messages: [] })).toEqual({
      placement: "thinking",
      pose: "thinking",
      motion: "think",
    });
  });

  it("says oops on an error, instead of introducing older cards", () => {
    expect(
      chefMoment({
        ...ready,
        hasError: true,
        messages: [user, reply(2, false), user],
      }),
    ).toEqual({ placement: "error", pose: "oops" });
  });

  it("introduces the newest set of dishes as found — only when the server said it's not a safety question", () => {
    expect(
      chefMoment({
        ...ready,
        messages: [user, reply(2, false), user, reply(0, false)],
      }),
    ).toEqual({
      placement: "recommendations",
      messageIndex: 1,
      pose: "found",
      celebrate: true,
    });
    expect(
      chefMoment({
        ...ready,
        messages: [user, reply(2, false), user, reply(1, false)],
      }),
    ).toMatchObject({ messageIndex: 3, pose: "found" });
  });

  it("stays neutral and doesn't celebrate for safety answers", () => {
    expect(chefMoment({ ...ready, messages: [user, reply(1, true)] })).toEqual({
      placement: "recommendations",
      messageIndex: 1,
      pose: "neutral",
      celebrate: false,
    });
  });

  it("treats an unknown question as safety — history from an earlier visit has no flag", () => {
    expect(
      chefMoment({ ...ready, messages: [user, reply(2, undefined)] }),
    ).toMatchObject({ pose: "neutral", celebrate: false });
  });

  it("looks apologetic when the newest reply is a fixed 'couldn't answer' one — neutral for safety", () => {
    const fallback = (safety?: boolean): ChefMomentMessage => ({
      role: "assistant",
      recommendationCount: 0,
      fallback: true,
      safety,
    });
    expect(
      chefMoment({
        ...ready,
        messages: [user, reply(2, false), user, fallback(false)],
      }),
    ).toEqual({ placement: "apology", messageIndex: 3, pose: "oops" });
    expect(chefMoment({ ...ready, messages: [user, fallback(true)] })).toEqual({
      placement: "apology",
      messageIndex: 1,
      pose: "neutral",
    });
    expect(
      chefMoment({ ...ready, messages: [user, fallback(undefined)] }),
    ).toMatchObject({ pose: "neutral" });
    // Once a real answer follows, the apology is over.
    expect(
      chefMoment({
        ...ready,
        messages: [user, fallback(false), user, reply(1, false)],
      }),
    ).toMatchObject({ placement: "recommendations", messageIndex: 3 });
  });

  it("shows nothing when no reply came with dishes", () => {
    expect(chefMoment({ ...ready, messages: [user, reply(0, false)] })).toEqual(
      { placement: "none" },
    );
  });
});

describe("isSafetyQuestion", () => {
  it("catches allergen questions, in English, Hindi and Spanish", () => {
    for (const q of [
      "Does anything contain peanuts?",
      "Is the dosa gluten free?",
      "What allergens are in the shake?",
      "इसमें मूंगफली है?",
      "¿Lleva cacahuetes?",
    ]) {
      expect(isSafetyQuestion(q), q).toBe(true);
    }
  });

  it("catches every diet question — religious, medical and ethical", () => {
    for (const q of [
      "Is the biryani halal?",
      "Anything kosher?",
      "I'm coeliac, what can I eat?",
      "Do you have Jain food?",
      "I'm lactose intolerant",
      "क्या यह हलाल है?",
      "Soy celíaco",
      // Found live: "none are marked vegan", with vegetarian cards below.
      "Which dishes are vegan?",
      "Anything vegetarian?",
      "Something plant-based",
      "शाकाहारी क्या है?",
      "¿Tienen platos veganos?",
    ]) {
      expect(isSafetyQuestion(q), q).toBe(true);
    }
  });

  it("leaves ordinary browsing alone", () => {
    for (const q of [
      "Something spicy but not too heavy",
      "Something light, not too spicy",
      "What do you recommend?",
      "Surprise me",
      "Comfort food",
      "How long does the biryani take?",
    ]) {
      expect(isSafetyQuestion(q), q).toBe(false);
    }
  });
});

describe("chefEnabledFor", () => {
  it("is off unless the restaurant is listed, or everyone is", () => {
    expect(chefEnabledFor(undefined, "nashta")).toBe(false);
    expect(chefEnabledFor("", "nashta")).toBe(false);
    expect(chefEnabledFor("other", "nashta")).toBe(false);
    expect(chefEnabledFor("other, Nashta ", "nashta")).toBe(true);
    expect(chefEnabledFor("*", "anything")).toBe(true);
  });
});

describe("isFallbackText", () => {
  it("recognises every fixed reply, in every language, and nothing else", () => {
    for (const key of [
      "menuFact",
      "cartState",
      "decline",
      "toolLimit",
      "didNotCatch",
    ] as const) {
      for (const language of ["en", "hi", "es"] as const) {
        expect(isFallbackText(fallbackText(key, language))).toBe(true);
      }
    }
    expect(isFallbackText("Try the Paneer Tikka — it's spicy.")).toBe(false);
    expect(
      isFallbackText(
        "I wasn't able to pull that up from the menu just now — could you try asking again?",
      ),
    ).toBe(false);
  });
});
