/**
 * While-you-wait games (20261202090000): a short quiz and a photo match
 * game, built from the restaurant's own menu. Pure and free of
 * `server-only` (tests/unit/wait-games-core.test.ts).
 *
 * Every answer comes from what the restaurant entered (vegan, spice level,
 * preparation time, which section a dish is in), so there's no AI and no
 * cost. Allergens are deliberately left out: a game is no place for
 * allergy facts, which the menu, the Chef and the allergy hold handle
 * with care.
 *
 * Seeded by the order id, so a guest sees the same questions in the same
 * order on every reload, and the server and browser agree.
 */

export interface GameDish {
  id: string;
  name: string;
  category: string | null;
  isVegan: boolean;
  isVegetarian: boolean;
  /** none | mild | medium | hot | very_hot, or null when not given. */
  spiceLevel: string | null;
  /** Minutes, or null when not given. */
  prepMinutes: number | null;
  photoUrl: string | null;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: { id: string; name: string }[];
  answerId: string;
  /** Said after answering, right or wrong. */
  explain: string;
}

const SPICE_RANK: Record<string, number> = {
  none: 0,
  mild: 1,
  medium: 2,
  hot: 3,
  very_hot: 4,
};

/** A small deterministic random-number generator (mulberry32). */
function rng(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pick<T>(items: T[], n: number, random: () => number): T[] {
  return shuffle(items, random).slice(0, n);
}

function veganQuestion(dishes: GameDish[], random: () => number) {
  const vegan = dishes.filter((d) => d.isVegan);
  // Distractors that aren't even vegetarian, so nobody argues the answer.
  const meaty = dishes.filter((d) => !d.isVegan && !d.isVegetarian);
  if (vegan.length === 0 || meaty.length < 2) return null;
  const [answer] = pick(vegan, 1, random);
  const options = shuffle([answer, ...pick(meaty, 2, random)], random);
  return {
    id: "vegan",
    question: "Which of these is vegan?",
    options,
    answerId: answer.id,
    explain: `${answer.name} is vegan.`,
  };
}

function spiciestQuestion(dishes: GameDish[], random: () => number) {
  const rated = dishes.filter(
    (d) => d.spiceLevel !== null && d.spiceLevel in SPICE_RANK,
  );
  const levels = [...new Set(rated.map((d) => SPICE_RANK[d.spiceLevel!]))];
  if (levels.length < 3) return null;
  // Three dishes on three different heat levels, so one is clearly hottest.
  const chosenLevels = pick(levels, 3, random);
  const options = chosenLevels.map(
    (level) =>
      pick(
        rated.filter((d) => SPICE_RANK[d.spiceLevel!] === level),
        1,
        random,
      )[0],
  );
  const answer = options.reduce((a, b) =>
    SPICE_RANK[a.spiceLevel!] >= SPICE_RANK[b.spiceLevel!] ? a : b,
  );
  return {
    id: "spiciest",
    question: "Which of these is the spiciest?",
    options: shuffle(options, random),
    answerId: answer.id,
    explain: `${answer.name} is the hottest of the three.`,
  };
}

function fastestQuestion(dishes: GameDish[], random: () => number) {
  const timed = dishes.filter(
    (d) => d.prepMinutes !== null && d.prepMinutes > 0,
  );
  const times = [...new Set(timed.map((d) => d.prepMinutes!))];
  if (times.length < 3) return null;
  const options = pick(times, 3, random).map(
    (t) =>
      pick(
        timed.filter((d) => d.prepMinutes === t),
        1,
        random,
      )[0],
  );
  const answer = options.reduce((a, b) =>
    a.prepMinutes! <= b.prepMinutes! ? a : b,
  );
  return {
    id: "fastest",
    question: "Which of these is ready fastest?",
    options: shuffle(options, random),
    answerId: answer.id,
    explain: `${answer.name} takes about ${answer.prepMinutes} minutes.`,
  };
}

function sectionQuestion(dishes: GameDish[], random: () => number) {
  const named = dishes.filter((d) => d.category);
  const categories = [...new Set(named.map((d) => d.category!))];
  if (categories.length < 2) return null;
  const [category] = pick(categories, 1, random);
  const inIt = named.filter((d) => d.category === category);
  const elsewhere = named.filter((d) => d.category !== category);
  if (inIt.length === 0 || elsewhere.length < 2) return null;
  const [answer] = pick(inIt, 1, random);
  return {
    id: "section",
    question: `Which of these is on the menu under ${category}?`,
    options: shuffle([answer, ...pick(elsewhere, 2, random)], random),
    answerId: answer.id,
    explain: `${answer.name} is under ${category}.`,
  };
}

/** Up to three questions from what this menu can support. */
export function buildQuiz(dishes: GameDish[], seed: string): QuizQuestion[] {
  const random = rng(seed);
  const makers = shuffle(
    [veganQuestion, spiciestQuestion, fastestQuestion, sectionQuestion],
    random,
  );
  const questions: QuizQuestion[] = [];
  for (const make of makers) {
    const q = make(dishes, random);
    if (q) {
      questions.push({
        ...q,
        options: q.options.map((d) => ({ id: d.id, name: d.name })),
      });
    }
    if (questions.length === 3) break;
  }
  return questions;
}

export interface MatchCard {
  /** Unique per card. */
  key: string;
  dishId: string;
  name: string;
  photoUrl: string;
}

export const MATCH_PAIRS = 6;
/** Fewer photos than this and there's no match game. */
export const MATCH_MIN_PAIRS = 4;

/** Each chosen dish twice, shuffled; null when too few dishes have photos. */
export function buildMatchDeck(
  dishes: GameDish[],
  seed: string,
): MatchCard[] | null {
  const random = rng(`match:${seed}`);
  const withPhotos = dishes.filter((d) => d.photoUrl);
  if (withPhotos.length < MATCH_MIN_PAIRS) return null;
  const chosen = pick(withPhotos, MATCH_PAIRS, random);
  const cards = chosen.flatMap((d) => [
    { key: `${d.id}-a`, dishId: d.id, name: d.name, photoUrl: d.photoUrl! },
    { key: `${d.id}-b`, dishId: d.id, name: d.name, photoUrl: d.photoUrl! },
  ]);
  return shuffle(cards, random);
}

/** Order statuses during which the games show: placed, but not yet served. */
export function showWaitGames(status: string): boolean {
  return ["pending", "confirmed", "preparing", "ready"].includes(status);
}
