// The Admin page's model dropdowns: tested models per job, with prices
// from OpenRouter's public list (src/lib/admin/model-catalogue.ts).
import { describe, expect, it } from "vitest";
import {
  catalogueFor,
  parseOpenRouterModels,
  priceLabel,
  TESTED_MODELS,
} from "@/lib/admin/model-catalogue";
import { AI_JOBS } from "@/lib/ai/model-settings-core";
import { isFreeModel } from "@/lib/translations/core";

const body = {
  data: [
    {
      id: "dots-studio/dots-3-note-preview:free",
      name: "dots.3",
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools"],
    },
    {
      id: "anthropic/some-model",
      name: "Some Model",
      pricing: { prompt: "0.0000008", completion: "0.000004" },
      architecture: { input_modalities: ["text"] },
    },
    { name: "no id" },
  ],
};

describe("parseOpenRouterModels", () => {
  it("reads id, prices and abilities, and skips malformed entries", () => {
    const models = parseOpenRouterModels(body);
    expect(models.size).toBe(2);
    expect(models.get("dots-studio/dots-3-note-preview:free")).toMatchObject({
      promptPrice: 0,
      imageInput: true,
      tools: true,
    });
    expect(models.get("anthropic/some-model")).toMatchObject({
      promptPrice: 0.0000008,
      completionPrice: 0.000004,
      tools: false,
    });
  });

  it("returns nothing for a body it doesn't recognise", () => {
    expect(parseOpenRouterModels(null).size).toBe(0);
    expect(parseOpenRouterModels({ data: "x" }).size).toBe(0);
  });
});

describe("priceLabel", () => {
  const models = parseOpenRouterModels(body);
  it("says Free, or the price per million tokens", () => {
    expect(priceLabel(models.get("dots-studio/dots-3-note-preview:free"))).toBe(
      "Free",
    );
    expect(priceLabel(models.get("anthropic/some-model"))).toBe(
      "$0.80 in · $4.00 out per million tokens",
    );
    expect(priceLabel(undefined)).toBe("Not on OpenRouter now");
  });
});

describe("catalogueFor", () => {
  const known = parseOpenRouterModels(body);

  it("lists the tested models, then whatever is in use and not among them", () => {
    const options = catalogueFor("waiter", ["anthropic/some-model"], known);
    expect(options[0].model).toBe("dots-studio/dots-3-note-preview:free");
    expect(options.at(-1)).toMatchObject({
      model: "anthropic/some-model",
      available: true,
      note: expect.stringMatching(/In use now/),
    });
  });

  it("marks a model OpenRouter no longer lists as unavailable", () => {
    const options = catalogueFor("vision", [], known);
    const gone = options.find(
      (o) => o.model === "nvidia/nemotron-3.5-super-vl:free",
    );
    expect(gone).toMatchObject({ available: false });
  });

  it("marks nothing unavailable when OpenRouter's list couldn't be fetched", () => {
    expect(catalogueFor("vision", [], null).every((o) => o.available)).toBe(
      true,
    );
  });

  it("offers only free models for the free-only jobs", () => {
    for (const { job, freeOnly } of AI_JOBS) {
      if (!freeOnly) continue;
      expect(
        TESTED_MODELS[job].every((t) => isFreeModel("openrouter", t.model)),
      ).toBe(true);
    }
  });

  it("offers at least one tested model for every job", () => {
    for (const { job } of AI_JOBS) {
      expect(TESTED_MODELS[job].length).toBeGreaterThan(0);
    }
  });
});
