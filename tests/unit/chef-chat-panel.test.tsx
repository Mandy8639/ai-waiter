// @vitest-environment jsdom
//
// The Chef in the real chat panel. The server calls are mocked; what's
// tested is which face the diner sees — above all, that a safety answer
// gets the neutral Chef even when it comes with dish cards.
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The full suite runs files in parallel, so allow more than the default
// second for the mocked reply to settle.
const WAIT = { timeout: 5000 };

// jsdom has no layout: the panel scrolls its log to the newest message.
Element.prototype.scrollTo = () => {};

const getChatHistory = vi.fn(async () => []);
const sendChatMessage = vi.fn();
vi.mock("@/lib/ai/actions", () => ({
  getChatHistory: () => getChatHistory(),
  sendChatMessage: (...args: unknown[]) => sendChatMessage(...args),
}));
vi.mock("@/lib/cart/actions", () => ({ addToCart: vi.fn(async () => ({})) }));
vi.mock("@/lib/table-requests/actions", () => ({
  requestService: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { AiWaiterPanel } = await import("@/components/customer/ai-waiter-panel");

afterEach(() => {
  cleanup();
  sendChatMessage.mockReset();
});

function renderPanel(chef = true) {
  return render(
    <AiWaiterPanel
      chef={chef}
      restaurantSlug="rasoi"
      restaurantName="Rasoi House"
      open
      onOpenChange={() => {}}
      promptRequest={null}
      onPromptHandled={() => {}}
      finalFocus={createRef<HTMLElement>()}
    />,
  );
}

const card = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Peanut Chikki Shake",
  price: 5.99,
  currency: "USD",
  isVegetarian: true,
  isVegan: false,
  isSpicy: false,
  image: null,
  allergens: ["Peanuts", "Milk"],
  needsOptions: false,
};

function poses() {
  return [...document.querySelectorAll("[data-chef-pose]")].map((el) =>
    el.getAttribute("data-chef-pose"),
  );
}

async function ask(question: string) {
  fireEvent.change(screen.getByLabelText("Message the Chef"), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("the Chef in the chat", () => {
  it("greets with a calm header Chef, a waving welcome and the first-use line", async () => {
    renderPanel();
    expect(
      await screen.findByText("What are we feeling today?", undefined, WAIT),
    ).toBeVisible();
    expect(screen.getByText("Chef")).toBeVisible();
    expect(screen.getByText("AI menu guide")).toBeVisible();
    expect(
      screen.getByText(
        "Answers are based on this restaurant's menu. For allergies, confirm with staff.",
      ),
    ).toBeVisible();
    expect(poses()).toEqual(["neutral", "hello"]);
    for (const prompt of [
      "Something spicy",
      "Something light",
      "Comfort food",
      "Surprise me",
    ]) {
      expect(screen.getByRole("button", { name: prompt })).toBeVisible();
    }
  });

  it("stays neutral over dish cards that answer an allergen question", async () => {
    sendChatMessage.mockResolvedValue({
      reply: "Yes — it contains Peanuts and Milk.",
      recommendations: [card],
      safety: true,
    });
    renderPanel();
    await screen.findByText("What are we feeling today?", undefined, WAIT);
    await ask("Does the shake contain peanuts?");

    await waitFor(() => expect(poses()).toEqual(["neutral", "neutral"]), WAIT);
    expect(screen.getByText("1 dish from the menu")).toBeVisible();
    expect(poses()).not.toContain("found");
  });

  it("is pleased with dishes found for an ordinary question", async () => {
    sendChatMessage.mockResolvedValue({
      reply: "Try the shake.",
      recommendations: [card],
      safety: false,
    });
    renderPanel();
    await screen.findByText("What are we feeling today?", undefined, WAIT);
    await ask("Something sweet");

    await waitFor(() => expect(poses()).toEqual(["neutral", "found"]), WAIT);
    expect(screen.getByText("1 dish from the menu")).toBeVisible();
  });

  it("says oops on an error", async () => {
    sendChatMessage.mockResolvedValue({ error: "Something went wrong." });
    renderPanel();
    await screen.findByText("What are we feeling today?", undefined, WAIT);
    await ask("Hello");

    await waitFor(() => expect(poses()).toEqual(["neutral", "oops"]), WAIT);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong.",
    );
  });

  it("looks apologetic beside a reply the waiter couldn't answer", async () => {
    sendChatMessage.mockResolvedValue({
      reply:
        "I'm having trouble finishing that in one go — could you break that into a smaller request?",
      recommendations: [],
      safety: false,
    });
    renderPanel();
    await screen.findByText("What are we feeling today?", undefined, WAIT);
    await ask("Something spicy but not too heavy");
    await waitFor(() => expect(poses()).toEqual(["neutral", "oops"]), WAIT);
  });

  it("shows no Chef at all where it isn't switched on", async () => {
    renderPanel(false);
    expect(
      await screen.findByText("What are you in the mood for?", undefined, WAIT),
    ).toBeVisible();
    expect(screen.getByText("Your waiter")).toBeVisible();
    expect(poses()).toEqual([]);
  });
});
