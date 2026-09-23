/**
 * Turning a dish row into the sentence an image model is given.
 *
 * Pure and dependency-free, so the wording is testable and reviewable on
 * its own — the prompt is the product decision here, not the HTTP call.
 *
 * STYLE IS NOT A PREFERENCE, IT IS A PROMISE. docs/MENU_PHOTO_STRATEGY.md
 * §18 decision 6 requires AI images to be *illustrative, not photo-real*:
 * premium, appetising, tasteful, editorial, and clearly an illustration.
 * A photo-real generation of a dish the kitchen has never plated is a
 * picture of food the diner cannot order, and the "AI-generated" label
 * alone does not undo that — a diner reading a label still believes a
 * photograph. Looking like an illustration is what makes the label
 * truthful rather than decorative.
 *
 * Everything interpolated below is owner-entered text from menu_items.
 * It is bounded and stripped (see `clean`) rather than trusted: not
 * because an image model is likely to be steered into something harmful,
 * but because a dish description is free text and free text that reaches a
 * third party should always leave through a narrow gate.
 */

/** The fields of a dish that legitimately describe how it looks. */
export interface DishForPrompt {
  name: string;
  description?: string | null;
  /** Owner-entered components, not the allergen catalogue. */
  ingredients?: string[] | null;
  category?: string | null;
}

/**
 * Caps. A menu description can be a paragraph; an image prompt that long
 * mostly dilutes the subject, and the tail of it is rarely visual.
 */
const MAX_NAME = 80;
const MAX_DESCRIPTION = 240;
const MAX_INGREDIENTS = 6;
const MAX_INGREDIENT = 40;

/**
 * The fixed half of every prompt. Written as instructions about the
 * *rendering*, not about the food, so a dish description cannot contradict
 * it by accident: "digital illustration" survives a description that
 * happens to contain the word "photograph".
 */
const STYLE =
  "Editorial digital illustration, clearly hand-illustrated and not photographic. " +
  "Warm, appetising, premium restaurant-menu style. Soft natural lighting, " +
  "shallow depth of field, clean uncluttered background, single plated serving, " +
  "overhead three-quarter view. No text, no words, no lettering, no logos, " +
  "no watermarks, no hands, no people, no cutlery brands.";

/**
 * Strips what should never reach a third-party API from owner free text:
 * control characters, newlines (which turn one instruction into two), and
 * runs of whitespace. Truncation is on a word boundary where one is near,
 * so a cut description does not end mid-word and read as a typo in a log.
 */
function clean(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The prompt for one dish.
 *
 * Throws on a dish with no usable name, because a prompt of pure style
 * with no subject would generate *something* — a generic plate of food —
 * and that image would then be attached to a named dish on a real menu.
 * Refusing costs the owner nothing; the alternative is a confident picture
 * of the wrong food.
 */
export function buildGenerationPrompt(dish: DishForPrompt): string {
  const name = clean(dish.name, MAX_NAME);
  if (!name) {
    throw new Error("menu image prompt: the dish has no usable name");
  }

  const parts = [`A single serving of "${name}"`];

  const category = clean(dish.category, MAX_NAME);
  if (category) parts.push(`a ${category.toLowerCase()} dish`);

  const description = clean(dish.description, MAX_DESCRIPTION);
  if (description) parts.push(description);

  const ingredients = (dish.ingredients ?? [])
    .map((entry) => clean(entry, MAX_INGREDIENT))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_INGREDIENTS);
  if (ingredients.length > 0) {
    parts.push(`Visible ingredients: ${ingredients.join(", ")}`);
  }

  return `${parts.join(". ")}. ${STYLE}`;
}

/**
 * The alt text and disclosure copy live in the diner UI (see
 * src/components/customer/dish-photo.tsx), not here — this module decides
 * what is drawn, not what is said about it. Exported so a test can assert
 * the two never drift apart in intent.
 */
export const GENERATED_IMAGE_IS_ILLUSTRATION = true;
