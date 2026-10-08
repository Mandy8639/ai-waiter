import { describe, expect, it } from "vitest";
import { orderProgress } from "@/lib/orders/progress";

const labels = (status: string) => orderProgress(status).map((s) => s.label);
const stateOf = (status: string, label: string) =>
  orderProgress(status).find((s) => s.label === label)?.state;

describe("orderProgress", () => {
  it("marks everything before the current step as done", () => {
    expect(stateOf("preparing", "Order received")).toBe("done");
    expect(stateOf("preparing", "Accepted by the kitchen")).toBe("done");
    expect(stateOf("preparing", "Being cooked")).toBe("current");
    expect(stateOf("preparing", "Ready")).toBe("upcoming");
  });

  it("starts at the first step for a brand new order", () => {
    expect(stateOf("pending", "Order received")).toBe("current");
    expect(stateOf("pending", "Accepted by the kitchen")).toBe("upcoming");
  });

  it("shows the whole journey done once served", () => {
    expect(stateOf("served", "Ready")).toBe("done");
    expect(stateOf("served", "Served")).toBe("done");
  });

  it("gives a cancelled order no tracker at all", () => {
    // A greyed-out tracker reads like the food is still coming. An empty
    // list is what lets the page render something else entirely.
    expect(orderProgress("cancelled")).toEqual([]);
  });

  it("claims no progress for a status it does not recognise", () => {
    // Inventing progress from an unknown status would tell a diner the
    // kitchen has started when nothing said so.
    const steps = orderProgress("something-new");
    expect(steps.every((s) => s.state === "upcoming")).toBe(true);
    expect(labels("something-new").length).toBeGreaterThan(0);
  });
});
