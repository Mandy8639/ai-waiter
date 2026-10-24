import { describe, expect, it } from "vitest";
import { describeTestResults } from "@/lib/push/dispatch-core";

describe("what Send a test says", () => {
  it("says so when this device got it", () => {
    expect(
      describeTestResults([{ kind: "ios", ok: true, thisDevice: true }]),
    ).toBe("Sent to this device.");
  });

  it("says this device isn't registered when the test only reached others", () => {
    expect(
      describeTestResults([{ kind: "web", ok: true, thisDevice: false }]),
    ).toBe(
      "This device isn't registered for alerts here: turn alerts off and on again to add it. Also: 1 other web browser (sent).",
    );
  });

  it("gives the refusal code for this device, and counts the others by kind", () => {
    expect(
      describeTestResults([
        { kind: "ios", ok: false, statusCode: 410, thisDevice: true },
        { kind: "ios", ok: true, thisDevice: false },
        { kind: "ios", ok: false, thisDevice: false },
        { kind: "web", ok: true, thisDevice: false },
      ]),
    ).toBe(
      "This device: refused (410). Also: 2 other iPhone/iPad apps (1 sent, 1 refused), 1 other web browser (sent).",
    );
  });

  it("handles no devices at all", () => {
    expect(describeTestResults([])).toBe(
      "Alerts aren't on for any of your devices yet.",
    );
  });
});
