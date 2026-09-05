/**
 * Which free model should do WHICH job, ranked by how fast it answers.
 *
 *   npx tsx --env-file=.env.local scripts/vet-models-by-job.ts <job>
 *     job = waiter | vision | suggestion
 *
 * Three jobs, three different requirements, three different shortlists.
 * The waiter holds a conversation and must call tools; the reader takes a
 * photograph of a board and must not invent a price; the suggester turns
 * dish names into structured JSON and must not invent an allergen. The
 * model that is best at one of those is not automatically good at another,
 * which is the whole reason this script takes a job argument.
 *
 * CORRECTNESS IS A GATE, SPEED IS THE RANKING — in that order, and the
 * order matters. Ranking by latency alone actively selects for the failure
 * this project keeps hitting: a model that skips the tool call and answers
 * from memory is FASTER than one that does the work, and it is the one
 * that tells a diner a dish is on the menu when it is not. laguna-s
 * answered every price question correctly, quickly, and then invented a
 * recommendation. So a model that fails its job's probe is not ranked at
 * all, however quick it was.
 *
 * A 429 is recorded as unavailable rather than as a failure: it says the
 * free tier is busy, not that the model is wrong.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  searchMenuSchema,
  getMenuItemSchema,
  getRestaurantInfoSchema,
  addItemToCartSchema,
} from "../src/lib/ai/tools/schemas";
import { toOpenRouterTools } from "../src/lib/ai/providers/openrouter-mapping";
import {
  EXTRACTION_PROMPT,
  parseExtraction,
} from "../src/lib/menu-import/extraction";
import {
  SUGGESTION_PROMPT,
  parseSuggestions,
  ALLERGEN_VOCABULARY,
  SPICE_LEVELS,
} from "../src/lib/menu-import/suggestions";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BANNED = new Set(["openrouter/free"]);

/** Music, audio and safety-classifier models list image support but are not menu readers. */
const NOT_A_GENERAL_MODEL = /lyria|content-safety|whisper|tts|embed/i;

const TOOLS = toOpenRouterTools(
  (
    [
      [
        "search_menu",
        "Search this restaurant's available menu items by text, dietary preference, spiciness, or category.",
        searchMenuSchema,
      ],
      [
        "get_menu_item",
        "Get full detail for one menu item by id.",
        getMenuItemSchema,
      ],
      [
        "get_restaurant_info",
        "Get the restaurant's name, address, and menu categories.",
        getRestaurantInfoSchema,
      ],
      [
        "add_item_to_cart",
        "Add a menu item to the customer's cart.",
        addItemToCartSchema,
      ],
    ] as const
  ).map(([name, description, schema]) => ({
    name,
    description,
    jsonSchema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<
      string,
      unknown
    >,
  })),
);

/** Ground truth for tests/fixtures/menu-board.jpg. */
const BOARD_ITEMS: Array<[string, number]> = [
  ["Samosa", 4.99],
  ["Onion Bhaji", 5.49],
  ["Chicken 65", 8.95],
  ["Chicken Biryani", 14.5],
  ["Paneer Butter Masala", 12.99],
  ["Lamb Rogan Josh", 16.75],
  ["Dal Tadka", 9.25],
  ["Butter Naan", 3.5],
  ["Garlic Naan", 4.25],
  ["Tandoori Roti", 2.99],
  ["Mango Lassi", 4.5],
  ["Masala Chai", 2.75],
];

interface Probe {
  ok: boolean;
  detail: string;
  ms: number;
  unavailable?: boolean;
}

async function call(
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ json?: Record<string, unknown>; status: number; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { status: res.status, ms };
    return { json: await res.json(), status: 200, ms };
  } catch {
    return { status: 0, ms: Date.now() - started };
  }
}

/** JOB 1 — the waiter. Does it actually call a tool, on every kind of question? */
async function probeWaiter(model: string): Promise<Probe> {
  const prompts = [
    "What vegetarian dishes do you have?",
    "How much is the aloo paratha?",
    "What do you recommend?",
    "How is the halwa puri made and how long does it take?",
  ];
  let called = 0;
  let total = 0;
  for (const content of prompts) {
    const r = await call(
      model,
      {
        max_tokens: 800,
        tools: TOOLS,
        messages: [
          {
            role: "system",
            content:
              "You are a waiter. You have NO built-in knowledge of this restaurant's menu. Every menu fact must come from a tool call.",
          },
          { role: "user", content },
        ],
      },
      90_000,
    );
    if (r.status === 429)
      return { ok: false, detail: "rate limited", ms: 0, unavailable: true };
    if (r.status !== 200)
      return {
        ok: false,
        detail: `HTTP ${r.status}`,
        ms: 0,
        unavailable: true,
      };
    total += r.ms;
    const calls =
      (r.json as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> })
        ?.choices?.[0]?.message?.tool_calls ?? [];
    if (calls.length > 0) called += 1;
  }
  return {
    ok: called === prompts.length,
    detail: `${called}/${prompts.length} tool calls`,
    ms: Math.round(total / prompts.length),
  };
}

/** JOB 2 — the menu reader. Can it read a degraded board without inventing a price? */
async function probeVision(model: string): Promise<Probe> {
  const jpg = readFileSync("tests/fixtures/menu-board.jpg").toString("base64");
  const r = await call(
    model,
    {
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACTION_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${jpg}` },
            },
          ],
        },
      ],
    },
    180_000,
  );
  if (r.status === 429)
    return { ok: false, detail: "rate limited", ms: 0, unavailable: true };
  if (r.status !== 200)
    return { ok: false, detail: `HTTP ${r.status}`, ms: 0, unavailable: true };

  const text =
    (r.json as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";
  const parsed = parseExtraction(text);
  if (!parsed.ok)
    return { ok: false, detail: `unparseable: ${parsed.error}`, ms: r.ms };

  // Match on the whole normalised name, not a first word. Matching
  // "Chicken Biryani" by "chicken" also matches the "Chicken 65" draft,
  // and "Masala Chai" by "masala" matches "Paneer Butter Masala" — a flaw
  // that failed two otherwise-correct models at 9/12 for a fault in this
  // probe rather than in the model.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  let correct = 0;
  for (const [name, price] of BOARD_ITEMS) {
    const target = norm(name);
    const hit = parsed.drafts.find((d) => {
      const got = norm(d.name);
      return got.includes(target) || target.includes(got);
    });
    if (hit && hit.price !== null && Math.abs(hit.price - price) < 0.005)
      correct += 1;
  }
  // The trap: the "ask at counter" line must NOT come back with a number.
  const invented = parsed.drafts.some(
    (d) => /market|counter|ask/i.test(d.name) && d.price !== null,
  );
  return {
    ok: correct >= 11 && !invented,
    detail: `${correct}/${BOARD_ITEMS.length} prices${invented ? ", INVENTED a price" : ""}`,
    ms: r.ms,
  };
}

/** JOB 3 — the suggester. Structured JSON, and no allergen outside the vocabulary. */
async function probeSuggestion(model: string): Promise<Probe> {
  const dishes = [
    "Chicken Biryani",
    "Mango Lassi",
    "Paneer Tikka",
    "Masala Dosa",
    "Gulab Jamun",
  ];
  // 8000, matching production. A reasoning model spends most of its
  // budget on thinking that never reaches `content`, so 4000 returned an
  // empty completion and scored the model that actually does this job in
  // production as "unparseable" — measuring the probe's budget, not the
  // model. See scripts/suggest-nashta-details.ts for the same lesson.
  const r = await call(
    model,
    {
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: `${SUGGESTION_PROMPT}\n\nDishes:\n${dishes.map((d) => `- ${d}`).join("\n")}`,
        },
      ],
    },
    180_000,
  );
  if (r.status === 429)
    return { ok: false, detail: "rate limited", ms: 0, unavailable: true };
  if (r.status !== 200)
    return { ok: false, detail: `HTTP ${r.status}`, ms: 0, unavailable: true };

  const text =
    (r.json as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";
  const parsed = parseSuggestions(text);
  if (!parsed.ok)
    return { ok: false, detail: `unparseable: ${parsed.error}`, ms: r.ms };

  const returned = new Set(parsed.suggestions.map((s) => s.name.toLowerCase()));
  const matched = dishes.filter((d) => returned.has(d.toLowerCase())).length;
  const badAllergen = parsed.suggestions.some((s) =>
    s.allergens.some(
      (a) => !(ALLERGEN_VOCABULARY as readonly string[]).includes(a),
    ),
  );
  const badSpice = parsed.suggestions.some(
    (s) =>
      s.spiceLevel !== null &&
      !(SPICE_LEVELS as readonly string[]).includes(s.spiceLevel),
  );
  const withIngredients = parsed.suggestions.filter(
    (s) => s.ingredients.length > 0,
  ).length;
  return {
    ok:
      matched === dishes.length &&
      !badAllergen &&
      !badSpice &&
      withIngredients === dishes.length,
    detail: `${matched}/${dishes.length} dishes, ${withIngredients} with ingredients${badAllergen ? ", BAD allergen" : ""}${badSpice ? ", BAD spice" : ""}`,
    ms: r.ms,
  };
}

async function candidates(job: string): Promise<string[]> {
  const { data } = (await (
    await fetch("https://openrouter.ai/api/v1/models")
  ).json()) as {
    data: Array<{
      id: string;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[] };
    }>;
  };
  const free = data.filter(
    (m) =>
      (m.id.endsWith(":free") ||
        (Number(m.pricing?.prompt ?? 1) === 0 &&
          Number(m.pricing?.completion ?? 1) === 0)) &&
      !BANNED.has(m.id) &&
      !NOT_A_GENERAL_MODEL.test(m.id),
  );
  if (job === "waiter")
    return free
      .filter((m) => (m.supported_parameters ?? []).includes("tools"))
      .map((m) => m.id);
  if (job === "vision")
    return free
      .filter((m) => (m.architecture?.input_modalities ?? []).includes("image"))
      .map((m) => m.id);
  return free.map((m) => m.id);
}

async function main() {
  const job = process.argv[2];
  const probe =
    job === "waiter"
      ? probeWaiter
      : job === "vision"
        ? probeVision
        : job === "suggestion"
          ? probeSuggestion
          : null;
  if (!probe) {
    console.error("usage: vet-models-by-job.ts <waiter|vision|suggestion>");
    process.exitCode = 1;
    return;
  }

  const models = await candidates(job);
  console.log(`JOB: ${job} — ${models.length} free candidates\n`);

  const passed: Array<{ model: string; ms: number; detail: string }> = [];
  for (const model of models) {
    process.stdout.write(`  ${model} … `);
    const r = await probe(model);
    if (r.unavailable) console.log(`unavailable (${r.detail})`);
    else if (!r.ok) console.log(`FAIL — ${r.detail}`);
    else {
      console.log(`pass — ${r.detail}, ${r.ms}ms`);
      passed.push({ model, ms: r.ms, detail: r.detail });
    }
  }

  passed.sort((a, b) => a.ms - b.ms);
  console.log(`\n=== ${job}: correct models, fastest first ===`);
  if (passed.length === 0) console.log("  (none passed)");
  passed.slice(0, 5).forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.model}\n       ${p.ms}ms — ${p.detail}`);
  });
  if (passed.length > 5)
    console.log(`  (+${passed.length - 5} more passed but slower)`);
}

main();
