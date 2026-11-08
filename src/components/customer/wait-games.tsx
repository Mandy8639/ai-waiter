"use client";

import { useState } from "react";
import { Check, Gamepad2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MatchCard, QuizQuestion } from "@/lib/wait-games/core";
import { cn } from "@/lib/utils";

/**
 * "While you wait": a short menu quiz and a dish-photo match game on the
 * guest's order page, until the food is served (20261202090000). Just for
 * fun: no scores kept, no prizes, nothing sent anywhere.
 */
export function WaitGames({
  quiz,
  deck,
}: {
  quiz: QuizQuestion[];
  deck: MatchCard[] | null;
}) {
  const games = [
    ...(quiz.length > 0 ? (["quiz"] as const) : []),
    ...(deck ? (["match"] as const) : []),
  ];
  const [game, setGame] = useState<"quiz" | "match">(games[0] ?? "quiz");
  if (games.length === 0) return null;

  return (
    <section
      aria-labelledby="wait-games-heading"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="wait-games-heading"
          className="flex items-center gap-2 font-medium"
        >
          <Gamepad2 className="text-primary size-5" aria-hidden="true" />
          While you wait
        </h2>
        {games.length > 1 && (
          <div role="tablist" className="flex gap-1">
            {games.map((g) => (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={game === g}
                onClick={() => setGame(g)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  game === g
                    ? "bg-primary text-primary-foreground border-primary"
                    : "hover:bg-muted",
                )}
              >
                {g === "quiz" ? "Menu quiz" : "Dish match"}
              </button>
            ))}
          </div>
        )}
      </div>
      {game === "quiz" ? <Quiz questions={quiz} /> : <Match deck={deck!} />}
    </section>
  );
}

function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [right, setRight] = useState(0);

  if (index >= questions.length) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm">
          You got {right} of {questions.length}.
          {right === questions.length
            ? " You know this menu!"
            : " Now you know a little more of the menu."}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setIndex(0);
            setPicked(null);
            setRight(0);
          }}
        >
          Play again
        </Button>
      </div>
    );
  }

  const q = questions[index];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">
        <span className="text-muted-foreground font-normal">
          {index + 1} of {questions.length} ·{" "}
        </span>
        {q.question}
      </p>
      <ul className="flex flex-col gap-2">
        {q.options.map((o) => {
          const isAnswer = o.id === q.answerId;
          const chosen = picked === o.id;
          return (
            <li key={o.id}>
              <button
                type="button"
                disabled={picked !== null}
                onClick={() => {
                  setPicked(o.id);
                  if (isAnswer) setRight((n) => n + 1);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                  picked === null && "hover:bg-muted",
                  picked !== null && isAnswer && "border-success bg-success/10",
                  chosen && !isAnswer && "border-destructive bg-destructive/10",
                )}
              >
                {o.name}
                {picked !== null && isAnswer && (
                  <Check className="text-success size-4" aria-label="Right" />
                )}
                {chosen && !isAnswer && (
                  <X
                    className="text-destructive size-4"
                    aria-label="Not this one"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {picked !== null && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-muted-foreground text-sm">
            {picked === q.answerId ? "Right! " : ""}
            {q.explain}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setIndex((i) => i + 1);
              setPicked(null);
            }}
          >
            {index + 1 === questions.length ? "See score" : "Next"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Match({ deck }: { deck: MatchCard[] }) {
  const [open, setOpen] = useState<string[]>([]);
  const [matched, setMatched] = useState<Set<string>>(() => new Set());
  const [moves, setMoves] = useState(0);
  const done = matched.size * 2 === deck.length;

  function flip(card: MatchCard) {
    if (matched.has(card.dishId) || open.includes(card.key)) return;
    if (open.length === 2) return;
    const next = [...open, card.key];
    setOpen(next);
    if (next.length === 2) {
      setMoves((m) => m + 1);
      const [a, b] = next.map((k) => deck.find((c) => c.key === k)!);
      if (a.dishId === b.dishId) {
        setMatched((m) => new Set(m).add(a.dishId));
        setOpen([]);
      } else {
        setTimeout(() => setOpen([]), 900);
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {done
          ? `All matched in ${moves} moves!`
          : "Find the pairs. Pass the phone around the table."}
      </p>
      <ul className="grid grid-cols-4 gap-2" aria-label="Cards">
        {deck.map((card) => {
          const faceUp = open.includes(card.key) || matched.has(card.dishId);
          return (
            <li key={card.key}>
              <button
                type="button"
                onClick={() => flip(card)}
                aria-label={faceUp ? card.name : "Face-down card"}
                className={cn(
                  "bg-muted relative aspect-square w-full overflow-hidden rounded-lg border",
                  matched.has(card.dishId) && "ring-success ring-2",
                )}
              >
                {faceUp ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a published dish photo
                  <img
                    src={card.photoUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground flex size-full items-center justify-center text-lg"
                  >
                    ?
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {done && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen([]);
              setMatched(new Set());
              setMoves(0);
            }}
          >
            Play again
          </Button>
        </div>
      )}
    </div>
  );
}
