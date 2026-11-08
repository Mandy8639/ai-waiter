// @vitest-environment jsdom
//
// The while-you-wait card: answering the quiz and playing the match game.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaitGames } from "@/components/customer/wait-games";
import type { MatchCard, QuizQuestion } from "@/lib/wait-games/core";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const QUIZ: QuizQuestion[] = [
  {
    id: "vegan",
    question: "Which of these is vegan?",
    options: [
      { id: "wings", name: "Lantern Wings" },
      { id: "soup", name: "Garden Soup" },
      { id: "ribs", name: "Braised Short Rib" },
    ],
    answerId: "soup",
    explain: "Garden Soup is vegan.",
  },
  {
    id: "fastest",
    question: "Which of these is ready fastest?",
    options: [
      { id: "sorbet", name: "Mango Sorbet" },
      { id: "ribs", name: "Braised Short Rib" },
      { id: "salmon", name: "Lemon Herb Salmon" },
    ],
    answerId: "sorbet",
    explain: "Mango Sorbet takes about 2 minutes.",
  },
];

const card = (dishId: string, side: string): MatchCard => ({
  key: `${dishId}-${side}`,
  dishId,
  name: dishId,
  photoUrl: `https://img.test/${dishId}.webp`,
});
const DECK = [card("a", "a"), card("b", "a"), card("a", "b"), card("b", "b")];

describe("WaitGames", () => {
  it("runs the quiz: right and wrong answers, then the score", () => {
    render(<WaitGames quiz={QUIZ} deck={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Garden Soup" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Right! Garden Soup is vegan.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(screen.getByRole("button", { name: /Braised Short Rib/ }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Mango Sorbet takes about 2 minutes.",
    );
    fireEvent.click(screen.getByRole("button", { name: "See score" }));
    expect(screen.getByText(/You got 1 of 2/)).toBeInTheDocument();
  });

  it("plays the match game to the end", () => {
    vi.useFakeTimers();
    render(<WaitGames quiz={[]} deck={DECK} />);
    const faceDown = () =>
      screen.getAllByRole("button", { name: "Face-down card" });

    // A miss turns back over.
    fireEvent.click(faceDown()[0]); // a
    fireEvent.click(faceDown()[0]); // b
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(faceDown()).toHaveLength(4);

    // Both pairs.
    const cards = screen
      .getAllByRole("listitem")
      .map((li) => li.firstChild as HTMLElement);
    fireEvent.click(cards[0]);
    fireEvent.click(cards[2]);
    fireEvent.click(cards[1]);
    fireEvent.click(cards[3]);
    expect(screen.getByText(/All matched in 3 moves/)).toBeInTheDocument();
  });

  it("offers both games when both are available, and nothing when neither is", () => {
    render(<WaitGames quiz={QUIZ} deck={DECK} />);
    expect(screen.getByRole("tab", { name: "Menu quiz" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Dish match" }));
    expect(
      screen.getAllByRole("button", { name: "Face-down card" }),
    ).toHaveLength(4);
    cleanup();
    const { container } = render(<WaitGames quiz={[]} deck={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
