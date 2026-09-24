/**
 * The one and only ImageGenerationProvider implementation.
 *
 * No `server-only` import: `endpoint` is a parameter rather than a
 * hardcoded constant, exactly as src/lib/ai/providers/openrouter-model-call.ts
 * does, so the real fetch, the real AbortSignal.timeout and the real error
 * classification can be pointed at a local server in tests instead of
 * being mocked away.
 *
 * WRITTEN AGAINST THE DOCUMENTED API, NEVER EXERCISED AGAINST A REAL ONE.
 * Checked 2026-09-23 against OpenRouter's OpenAPI document
 * (openrouter.ai/docs/api/api-reference/images/generate-an-image.md):
 *
 *   POST /api/v1/images
 *     { model, prompt, n?, aspect_ratio?, output_format?, output_compression? }
 *   200
 *     { created, data: [{ b64_json, media_type? }], usage?: { cost, ... } }
 *
 * The response parsing below matches that document. It has never seen a
 * real 200, because there is nothing to call: on the same day, the
 * dedicated image API listed 54 models and **not one of them was free**
 * (`:free` appears in zero ids; the cheapest observed was
 * recraft/recraft-v4.1-flash at $0.007 per image, and
 * google/gemini-3.1-flash-lite-image at $0.00003 per output token). The
 * approved model, recraft/recraft-v3:free, still reports `"endpoints": []`.
 *
 * That is why this ships with no model configured. It is also why
 * `preflight()` is not an optimisation: it is the guard that turns "the
 * model you named cannot serve" into a clean, quota-free refusal instead
 * of a failed attempt the restaurant is charged for.
 */
import {
  GenerationFailed,
  GenerationUnavailable,
  type GeneratedImage,
  type GenerationRequest,
  type ImageGenerationProvider,
} from "./generation-provider";

export const OPENROUTER_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
export const OPENROUTER_IMAGE_MODELS_ENDPOINT =
  "https://openrouter.ai/api/v1/images/models";

export interface OpenRouterImageProviderOptions {
  apiKey: string;
  model: string;
  /** Overridden in tests; defaults to the real API. */
  endpoint?: string;
  modelsEndpoint?: string;
  /** Kept short: this is a metadata read, not the generation itself. */
  preflightTimeoutMs?: number;
}

/**
 * One 1:1 image, WebP out. Square because every surface that draws a dish
 * photo crops with object-cover (menu card at 96-112px, dish page
 * full-bleed), so a square source wastes the fewest pixels across both.
 * WebP because processing.ts re-encodes to WebP anyway — asking for it
 * directly avoids a PNG round-trip through sharp for no gain.
 */
const REQUEST_SHAPE = {
  n: 1,
  aspect_ratio: "1:1",
  output_format: "webp",
} as const;

export class OpenRouterImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "openrouter";

  constructor(private readonly options: OpenRouterImageProviderOptions) {}

  /**
   * Asks OpenRouter whether any provider currently serves the configured
   * model. An empty `endpoints` array is the exact shape recraft-v3:free
   * returns, and it means "listed but unservable" — a 404 would have been
   * easier to detect, which is why this check exists at all.
   */
  async preflight(): Promise<void> {
    const base =
      this.options.modelsEndpoint ?? OPENROUTER_IMAGE_MODELS_ENDPOINT;
    const url = `${base}/${this.options.model}/endpoints`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(this.options.preflightTimeoutMs ?? 10_000),
      });
    } catch {
      // Network error or timeout. Unavailable, not failed: nothing was
      // generated and nothing was billed, so no quota is consumed.
      throw new GenerationUnavailable("PROVIDER_UNAVAILABLE");
    }

    if (response.status === 404) {
      throw new GenerationUnavailable("NO_ENDPOINTS");
    }
    if (!response.ok) {
      throw new GenerationUnavailable("PROVIDER_UNAVAILABLE");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GenerationUnavailable("PROVIDER_UNAVAILABLE");
    }

    if (countEndpoints(body) === 0) {
      throw new GenerationUnavailable("NO_ENDPOINTS");
    }
  }

  async generate(request: GenerationRequest): Promise<GeneratedImage> {
    let response: Response;
    try {
      response = await fetch(
        this.options.endpoint ?? OPENROUTER_IMAGE_ENDPOINT,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://tableside.menu",
            "X-Title": "Tableside",
          },
          body: JSON.stringify({
            model: this.options.model,
            prompt: request.prompt,
            ...REQUEST_SHAPE,
          }),
          signal: AbortSignal.timeout(request.timeoutMs),
        },
      );
    } catch {
      // A timeout or a dropped connection. The request may well have
      // reached a provider and been billed, so this is a FAILURE, not
      // unavailability: the attempt has already been counted and stays
      // counted. §18 decision 4 counts attempts, not successes.
      throw new GenerationFailed(
        "The image generator did not respond in time.",
      );
    }

    // 402 is the one status worth its own branch: it means the account has
    // no credit, which for a feature that is supposed to cost nothing is a
    // configuration error rather than a transient fault. It still arrives
    // as an unavailability so it cannot burn further attempts.
    if (response.status === 402) {
      throw new GenerationUnavailable("PROVIDER_UNAVAILABLE");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GenerationUnavailable("PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      throw new GenerationFailed();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GenerationFailed();
    }

    const b64 = firstImageBase64(body);
    if (!b64) throw new GenerationFailed();

    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      throw new GenerationFailed();
    }
    // Buffer.from is lenient with invalid base64 — it returns whatever it
    // could decode rather than throwing — so emptiness is the real check.
    // Anything non-empty still has to satisfy processing.ts, which decodes
    // it properly and rejects what is not a usable image.
    if (bytes.byteLength === 0) throw new GenerationFailed();

    return { bytes, provider: this.name, model: this.options.model };
  }
}

/**
 * `endpoints` may be an array on the record, or nested under `data`.
 * Written defensively because the shape that matters most here — the empty
 * one — is the shape a strict parser is most likely to mistake for a
 * parse failure.
 */
function countEndpoints(body: unknown): number {
  const record = body as { data?: unknown; endpoints?: unknown };
  const container = (record?.data ?? record) as { endpoints?: unknown };
  const endpoints = container?.endpoints;
  return Array.isArray(endpoints) ? endpoints.length : 0;
}

function firstImageBase64(body: unknown): string | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { b64_json?: unknown };
  return typeof first?.b64_json === "string" && first.b64_json.length > 0
    ? first.b64_json
    : null;
}
