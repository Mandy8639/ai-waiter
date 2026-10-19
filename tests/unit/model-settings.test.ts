// The settings reader: saved lists win, are cached for a minute, and a
// failed read falls back to Vercel variables instead of breaking the
// waiter.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Read once, when config.ts loads, so it is set before the import below.
const previousProvider = vi.hoisted(() => {
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "openrouter";
  return previous;
});

afterAll(() => {
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;
});

vi.mock("server-only", () => ({}));

const select = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ select }) }),
}));

import { clearModelSettingsCache, getModelsFor } from "@/lib/ai/model-settings";

beforeEach(() => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret");
  vi.stubEnv("AI_MODEL", "env/waiter:free");
  clearModelSettingsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  select.mockReset();
});

describe("getModelsFor", () => {
  it("uses a list saved on /admin over the Vercel variable", async () => {
    select.mockResolvedValue({
      data: [{ job: "waiter", models: ["saved/paid", "saved/b:free"] }],
      error: null,
    });
    expect(await getModelsFor("waiter")).toEqual({
      models: ["saved/paid", "saved/b:free"],
      source: "saved",
    });
  });

  it("reads the store at most once a minute", async () => {
    vi.useFakeTimers();
    select.mockResolvedValue({ data: [], error: null });
    await getModelsFor("waiter");
    await getModelsFor("vision");
    expect(select).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await getModelsFor("waiter");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("falls back to the Vercel variable when the store can't be read", async () => {
    select.mockResolvedValue({ data: null, error: { message: "down" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getModelsFor("waiter")).toEqual({
      models: ["env/waiter:free"],
      source: "env",
    });
    spy.mockRestore();
  });

  it("never reads the store without the secret key", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    clearModelSettingsCache();
    await getModelsFor("waiter");
    expect(select).not.toHaveBeenCalled();
  });
});
