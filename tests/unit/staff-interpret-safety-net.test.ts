// The staff assistant's model call: when its whole list is busy, one more
// try on the free safety net (src/lib/staff-assistant/interpret.ts).
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
vi.mock("@/lib/ai/model-settings", () => ({
  getModelsFor: async () => ({ models: ["main:free"], source: "default" }),
}));
const safetyNet = vi.fn(async () => ["net-a:free", "net-b:free"]);
vi.mock("@/lib/ai/safety-net", () => ({
  getSafetyNetModels: () => safetyNet(),
}));

import { interpretWithModel } from "@/lib/staff-assistant/interpret";

const fetchMock = vi.fn();

function reply(content: string, model: string) {
  return new Response(
    JSON.stringify({ model, choices: [{ message: { content } }] }),
    { status: 200 },
  );
}

const SOLD_OUT = JSON.stringify({
  kind: "sold_out",
  target: "paneer tikka",
  until: "next_opening",
});

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  safetyNet.mockClear();
});

function sentModels(call: number): string[] {
  return JSON.parse(fetchMock.mock.calls[call][1].body).models;
}

describe("interpretWithModel", () => {
  it("uses its own list and never touches the net when that answers", async () => {
    fetchMock.mockResolvedValueOnce(reply(SOLD_OUT, "main:free"));
    const result = await interpretWithModel("out of paneer tikka");
    expect(result).toMatchObject({
      intent: { kind: "sold_out", target: "paneer tikka" },
      model: "main:free",
    });
    expect(safetyNet).not.toHaveBeenCalled();
  });

  it("tries the safety net when its list is busy", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(reply(SOLD_OUT, "net-a:free"));
    const result = await interpretWithModel("out of paneer tikka");
    expect(result).toMatchObject({
      intent: { kind: "sold_out" },
      model: "net-a:free",
    });
    expect(sentModels(0)).toEqual(["main:free"]);
    expect(sentModels(1)).toEqual(["net-a:free", "net-b:free"]);
  });

  it("says it didn't catch that when the net is busy too", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    expect(await interpretWithModel("out of paneer tikka")).toEqual({
      intent: { kind: "unknown" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't use the net for a nonsense answer, which another model wouldn't fix any faster", async () => {
    fetchMock.mockResolvedValueOnce(reply("no idea", "main:free"));
    expect(await interpretWithModel("blah")).toMatchObject({
      intent: { kind: "unknown" },
    });
    expect(safetyNet).not.toHaveBeenCalled();
  });
});
