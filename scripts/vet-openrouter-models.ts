/**
 * Does this model actually CALL the tool, or just talk about it?
 *
 *   npx tsx --env-file=.env.local scripts/vet-openrouter-models.ts [model...]
 *
 * The check docs/ai.md#model-fallback requires before any model may enter
 * aiConfig's OpenRouter preference list. It exists because the failure it
 * catches is silent: a model that answers a menu question without calling
 * search_menu returns a perfectly well-formed reply, the turn is logged
 * `outcome: ok`, and the customer is told the restaurant doesn't serve
 * something it serves. Nothing errors, so nothing else notices.
 *
 * Deliberately hits the raw API rather than the app's loop: the loop has a
 * factuality guard that would mask exactly the behaviour being measured.
 */
import { z } from "zod";
import {
  searchMenuSchema,
  getMenuItemSchema,
  getRestaurantInfoSchema,
  addItemToCartSchema,
} from "../src/lib/ai/tools/schemas";
import { toOpenRouterTools } from "../src/lib/ai/providers/openrouter-mapping";

/**
 * Built from schemas.ts rather than getToolDefinitions(), which reaches
 * the tool implementations and therefore `server-only`. These are the same
 * Zod schemas the app sends, converted the same way — the probe only needs
 * the model to be offered a realistic tool surface and decide whether to
 * call one.
 */
const TOOLS = toOpenRouterTools(
  (
    [
      [
        "search_menu",
        "Search this restaurant's currently available menu items by name/description text, dietary preference, spiciness, or menu category.",
        searchMenuSchema,
      ],
      [
        "get_menu_item",
        "Get full detail for one menu item by id — description, price, dietary flags, ingredients, declared allergens, preparation time, portion size, and its modifier groups/options.",
        getMenuItemSchema,
      ],
      [
        "get_restaurant_info",
        "Get this restaurant's name, description, address, phone number, and the list of menu categories it groups its food into.",
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

/** Each must be answerable ONLY by calling a tool — no general knowledge helps. */
const PROBES = [
  "What vegetarian dishes do you have?",
  "How much is the aloo paratha?",
  "What do you recommend?",
  "How is the halwa puri made and how long does it take?",
] as const;

const CANDIDATES = [
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "poolside/laguna-s-2.1:free",
  "dots-studio/dots-3-note-preview:free",
];

async function probe(model: string, prompt: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      tools: TOOLS,
      messages: [
        {
          role: "system",
          content:
            "You are a waiter for a restaurant. You have NO built-in knowledge of its menu. Every menu fact must come from a tool call.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(
    (e) =>
      ({
        ok: false,
        status: 0,
        json: async () => ({ error: String(e) }),
      }) as unknown as Response,
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return {
      called: false,
      note: `HTTP ${res.status} ${(body as { error?: { message?: string } })?.error?.message ?? ""}`.trim(),
    };
  }
  const json = await res.json();
  const message = json?.choices?.[0]?.message;
  const calls = message?.tool_calls ?? [];
  return {
    called: calls.length > 0,
    note:
      calls.length > 0
        ? calls
            .map((c: { function?: { name?: string } }) => c.function?.name)
            .join(",")
        : "no tool_calls",
  };
}

async function main() {
  const models = process.argv.slice(2).length
    ? process.argv.slice(2)
    : CANDIDATES;
  console.log(`${PROBES.length} probes per model\n`);
  for (const model of models) {
    let passed = 0;
    const notes: string[] = [];
    for (const prompt of PROBES) {
      const r = await probe(model, prompt);
      if (r.called) passed += 1;
      notes.push(
        `    ${r.called ? "OK  " : "MISS"} ${prompt}\n         ${r.note}`,
      );
    }
    const verdict =
      passed === PROBES.length
        ? "USABLE"
        : passed === 0
          ? "UNUSABLE"
          : "UNRELIABLE";
    console.log(`${model}\n  ${passed}/${PROBES.length} → ${verdict}`);
    console.log(notes.join("\n") + "\n");
  }
}

main();
