import { describe, expect, it } from "vitest";
import { staffChefMoment } from "@/lib/staff-assistant/chef-core";

/** The staff side's Chef: which face goes with which moment. Every word is still the server's. */

describe("staffChefMoment", () => {
  it("waves hello before anything is said", () => {
    expect(staffChefMoment({ pending: false, messages: [] })).toEqual({
      placement: "welcome",
      pose: "hello",
      motion: "wave",
    });
  });

  it("thinks while a command is being worked on", () => {
    expect(
      staffChefMoment({ pending: true, messages: [{ from: "you" }] }),
    ).toMatchObject({ placement: "thinking", pose: "thinking" });
  });

  it.each([
    ["done", "found", "nod"],
    ["question", "curious", undefined],
    ["error", "oops", undefined],
    ["info", "neutral", undefined],
  ] as const)("a %s reply gets the %s Chef", (tone, pose, motion) => {
    expect(
      staffChefMoment({
        pending: false,
        messages: [{ from: "you" }, { from: "assistant", tone }],
      }),
    ).toEqual({
      placement: "reply",
      messageIndex: 1,
      pose,
      ...(motion ? { motion } : {}),
    });
  });

  it("only celebrates something actually done", () => {
    for (const tone of ["question", "error", "info"] as const) {
      const moment = staffChefMoment({
        pending: false,
        messages: [{ from: "you" }, { from: "assistant", tone }],
      });
      expect(moment).not.toHaveProperty("motion");
    }
  });
});
