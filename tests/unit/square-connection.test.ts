import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  parseTokenKey,
} from "@/lib/pos/token-crypto";
import {
  REFRESH_MARGIN_MS,
  SQUARE_SCOPES,
  buildState,
  needsRefresh,
  parseState,
  parseTokenResponse,
  squareAuthorizeUrl,
} from "@/lib/pos/square/oauth-core";
import {
  UNCATEGORIZED_ID,
  mapSquareCatalog,
  presentAt,
  type SquareCatalogObject,
} from "@/lib/pos/square/catalog-core";

describe("token encryption", () => {
  const key = randomBytes(32);

  it("round-trips, and never stores the plaintext", () => {
    const sealed = encryptToken("EAAA-secret-token", key);
    expect(sealed).not.toContain("EAAA-secret-token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptToken(sealed, key)).toBe("EAAA-secret-token");
  });

  it("encrypts the same token differently each time (fresh IV)", () => {
    expect(encryptToken("t", key)).not.toBe(encryptToken("t", key));
  });

  it("refuses a tampered ciphertext or the wrong key", () => {
    const sealed = encryptToken("EAAA-secret-token", key);
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 1;
    parts[3] = flipped.toString("base64url");
    expect(() => decryptToken(parts.join("."), key)).toThrow();
    expect(() => decryptToken(sealed, randomBytes(32))).toThrow();
    expect(() => decryptToken("plaintext", key)).toThrow(/format/);
  });

  it("insists on a 32-byte key", () => {
    expect(() => parseTokenKey(undefined)).toThrow(/not set/);
    expect(() => parseTokenKey(randomBytes(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
    expect(parseTokenKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });
});

describe("Square OAuth", () => {
  it("asks for exactly the scopes it documents, and passes the state through", () => {
    const url = new URL(
      squareAuthorizeUrl({
        environment: "sandbox",
        applicationId: "sandbox-sq0idb-abc",
        state: "r1.n1",
        redirectUri: "https://tableside.menu/api/pos/square/callback",
      }),
    );
    expect(url.origin).toBe("https://connect.squareupsandbox.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...SQUARE_SCOPES,
    ]);
    expect(url.searchParams.get("state")).toBe("r1.n1");
    expect(url.searchParams.get("session")).toBeNull();
    // The fee permission is what lets Tableside take its cut in phase 2.
    expect(SQUARE_SCOPES).toContain("PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS");
  });

  it("forces Square's consent screen in production", () => {
    const url = new URL(
      squareAuthorizeUrl({
        environment: "production",
        applicationId: "sq0idp-abc",
        state: "s",
        redirectUri: "https://tableside.menu/api/pos/square/callback",
      }),
    );
    expect(url.origin).toBe("https://connect.squareup.com");
    expect(url.searchParams.get("session")).toBe("false");
  });

  it("reads Square's token response and rejects one without a token", () => {
    expect(
      parseTokenResponse({
        access_token: "A",
        refresh_token: "R",
        expires_at: "2026-11-24T00:00:00Z",
        merchant_id: "M",
      }),
    ).toEqual({
      accessToken: "A",
      refreshToken: "R",
      expiresAt: "2026-11-24T00:00:00Z",
      merchantId: "M",
    });
    expect(() => parseTokenResponse({ errors: [] })).toThrow();
  });

  it("refreshes inside the last week, not before", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const inDays = (d: number) =>
      new Date(now.getTime() + d * 86_400_000).toISOString();
    expect(needsRefresh(inDays(20), now)).toBe(false);
    expect(needsRefresh(inDays(6), now)).toBe(true);
    expect(needsRefresh(inDays(-1), now)).toBe(true);
    expect(needsRefresh(null, now)).toBe(false);
    expect(REFRESH_MARGIN_MS).toBe(7 * 86_400_000);
  });

  it("only accepts a state that matches the cookie", () => {
    const state = buildState("rest-1", "nonce");
    expect(parseState(state, state)).toEqual({ restaurantId: "rest-1" });
    expect(parseState(state, "rest-1.other")).toBeNull();
    expect(parseState(state, undefined)).toBeNull();
    expect(parseState(null, state)).toBeNull();
  });
});

const LOC = "LOC_MAIN";

const variation = (
  id: string,
  name: string,
  cents: number | null,
  extra: Partial<NonNullable<SquareCatalogObject["item_variation_data"]>> = {},
): SquareCatalogObject => ({
  type: "ITEM_VARIATION",
  id,
  item_variation_data: {
    name,
    pricing_type: cents === null ? "VARIABLE_PRICING" : "FIXED_PRICING",
    price_money:
      cents === null ? undefined : { amount: cents, currency: "USD" },
    ...extra,
  },
});

const item = (
  id: string,
  name: string,
  variations: SquareCatalogObject[],
  extra: Partial<NonNullable<SquareCatalogObject["item_data"]>> = {},
  top: Partial<SquareCatalogObject> = {},
): SquareCatalogObject => ({
  type: "ITEM",
  id,
  present_at_all_locations: true,
  ...top,
  item_data: { name, variations, ...extra },
});

describe("Square catalog mapping", () => {
  it("one variation: the dish is the variation, priced in dollars", () => {
    const { menu } = mapSquareCatalog(
      [
        {
          type: "CATEGORY",
          id: "CAT_DRINKS",
          category_data: { name: "Drinks" },
        },
        item(
          "ITEM_LASSI",
          "Mango Lassi",
          [variation("VAR_LASSI", "Regular", 500)],
          {
            categories: [{ id: "CAT_DRINKS" }],
            description_plaintext: "Yogurt and mango",
          },
        ),
      ],
      LOC,
    );
    expect(menu.categories).toEqual([
      { external_id: "CAT_DRINKS", name: "Drinks", display_order: 0 },
    ]);
    expect(menu.items[0]).toMatchObject({
      external_id: "VAR_LASSI",
      category_external_id: "CAT_DRINKS",
      price: 5,
      description: "Yogurt and mango",
      groups: [],
    });
  });

  it("several variations: cheapest as the price, the rest as a required choice", () => {
    const { menu } = mapSquareCatalog(
      [
        item("ITEM_BIRYANI", "Biryani", [
          variation("VAR_FAMILY", "Family", 2500, { ordinal: 1 }),
          variation("VAR_REGULAR", "Regular", 1600, { ordinal: 0 }),
        ]),
      ],
      LOC,
    );
    const dish = menu.items[0];
    expect(dish.external_id).toBe("ITEM_BIRYANI");
    expect(dish.price).toBe(16);
    expect(dish.groups[0]).toMatchObject({
      external_id: "var:ITEM_BIRYANI",
      is_required: true,
      min_selections: 1,
      max_selections: 1,
    });
    expect(
      dish.groups[0].options.map((o) => [
        o.external_id,
        o.name,
        o.price_adjustment,
      ]),
    ).toEqual([
      ["VAR_REGULAR", "Regular", 0],
      ["VAR_FAMILY", "Family", 9],
    ]);
  });

  it("modifier lists become one group per dish, with Square's limits", () => {
    const spice: SquareCatalogObject = {
      type: "MODIFIER_LIST",
      id: "ML_SPICE",
      present_at_all_locations: true,
      modifier_list_data: {
        name: "Spice",
        selection_type: "SINGLE",
        modifiers: [
          {
            type: "MODIFIER",
            id: "MOD_HOT",
            present_at_all_locations: true,
            modifier_data: {
              name: "Hot",
              ordinal: 1,
              price_money: { amount: 50 },
            },
          },
          {
            type: "MODIFIER",
            id: "MOD_MILD",
            present_at_all_locations: true,
            modifier_data: { name: "Mild", ordinal: 0 },
          },
        ],
      },
    };
    const extras: SquareCatalogObject = {
      type: "MODIFIER_LIST",
      id: "ML_EXTRAS",
      present_at_all_locations: true,
      modifier_list_data: {
        name: "Extras",
        selection_type: "MULTIPLE",
        modifiers: [
          {
            type: "MODIFIER",
            id: "MOD_RAITA",
            present_at_all_locations: true,
            modifier_data: { name: "Raita", price_money: { amount: 150 } },
          },
          {
            type: "MODIFIER",
            id: "MOD_EGG",
            present_at_all_locations: true,
            modifier_data: { name: "Egg", price_money: { amount: 100 } },
          },
        ],
      },
    };
    const { menu } = mapSquareCatalog(
      [
        spice,
        extras,
        item("ITEM_A", "Curry A", [variation("VAR_A", "R", 1000)], {
          modifier_list_info: [
            {
              modifier_list_id: "ML_SPICE",
              min_selected_modifiers: 1,
              max_selected_modifiers: -1,
            },
            {
              modifier_list_id: "ML_EXTRAS",
              min_selected_modifiers: -1,
              max_selected_modifiers: -1,
            },
            { modifier_list_id: "ML_SPICE", enabled: false },
          ],
        }),
        item("ITEM_B", "Curry B", [variation("VAR_B", "R", 1100)], {
          modifier_list_info: [{ modifier_list_id: "ML_SPICE" }],
        }),
      ],
      LOC,
    );
    const [a, b] = menu.items;
    expect(
      a.groups.map((g) => [
        g.external_id,
        g.is_required,
        g.min_selections,
        g.max_selections,
      ]),
    ).toEqual([
      ["ml:ML_SPICE:ITEM_A", true, 1, 1],
      ["ml:ML_EXTRAS:ITEM_A", false, 0, 2],
    ]);
    expect(
      a.groups[0].options.map((o) => [o.name, o.price_adjustment]),
    ).toEqual([
      ["Mild", 0],
      ["Hot", 0.5],
    ]);
    // Same Square list, separate Tableside group per dish.
    expect(b.groups[0].external_id).toBe("ml:ML_SPICE:ITEM_B");
    expect(b.groups[0].is_required).toBe(false);
  });

  it("skips variable-priced items and says why, rather than guessing a price", () => {
    const { menu, skipped } = mapSquareCatalog(
      [item("ITEM_MKT", "Market Fish", [variation("VAR_MKT", "Whole", null)])],
      LOC,
    );
    expect(menu.items).toEqual([]);
    expect(skipped).toEqual([
      {
        name: "Market Fish",
        reason: expect.stringMatching(/variable pricing/),
      },
    ]);
  });

  it("respects locations: absent, location-only, per-location price and sold out", () => {
    const { menu } = mapSquareCatalog(
      [
        item(
          "ITEM_GONE",
          "Elsewhere only",
          [variation("V1", "R", 500)],
          {},
          {
            present_at_all_locations: false,
            present_at_location_ids: ["LOC_OTHER"],
          },
        ),
        item(
          "ITEM_ABSENT",
          "Not here",
          [variation("V2", "R", 500)],
          {},
          {
            absent_at_location_ids: [LOC],
          },
        ),
        item("ITEM_HERE", "Here", [
          variation("V3", "R", 500, {
            location_overrides: [
              {
                location_id: LOC,
                price_money: { amount: 650 },
                sold_out: true,
              },
            ],
          }),
        ]),
      ],
      LOC,
    );
    expect(menu.items.map((i) => i.external_id)).toEqual(["V3"]);
    expect(menu.items[0].price).toBe(6.5);
    expect(menu.items[0].is_available).toBe(false);
    expect(presentAt({ type: "ITEM", id: "x" }, LOC)).toBe(true);
  });

  it("puts uncategorised items in Other and ignores deleted or archived ones", () => {
    const { menu } = mapSquareCatalog(
      [
        item("ITEM_X", "Loose item", [variation("VX", "R", 300)]),
        item(
          "ITEM_DEL",
          "Deleted",
          [variation("VD", "R", 300)],
          {},
          { is_deleted: true },
        ),
        item("ITEM_ARC", "Archived", [variation("VA", "R", 300)], {
          is_archived: true,
        }),
      ],
      LOC,
    );
    expect(menu.items.map((i) => i.name)).toEqual(["Loose item"]);
    expect(menu.categories).toEqual([
      { external_id: UNCATEGORIZED_ID, name: "Other", display_order: 0 },
    ]);
  });
});

describe("who may use the service-key Square token store", () => {
  // src/lib/pos/square/api.ts reads pos_credentials with the service key.
  // Every importer must authorise the user first (authorizeSquare, or the
  // RLS read on the settings page); pin the list so a new caller is a
  // deliberate decision, not an accident.
  it("is imported only by the reviewed callers", () => {
    const root = path.resolve(__dirname, "../../src");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(full, "utf8");
          const sibling = path
            .dirname(full)
            .endsWith(path.join("pos", "square"));
          if (
            /from ["']@\/lib\/pos\/square\/api["']/.test(text) ||
            (sibling && /from ["']\.\/api["']/.test(text))
          ) {
            importers.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(importers.sort()).toEqual(
      [
        "app/api/pos/square/callback/route.ts",
        "app/dashboard/settings/pos/page.tsx",
        "lib/pos/square/actions.ts",
        // Phase 2: opening Square's checkout for a diner's own payment.
        "lib/pos/square/checkout.ts",
        // Phase 3: Terminal payments and cash copies, on a member's request.
        "lib/pos/square/in-person.ts",
        // Refunds to a Square card, after start_refund() checked the owner or manager.
        "lib/pos/square/refunds.ts",
      ].sort(),
    );
  });
});

describe("squareReady", () => {
  const key = randomBytes(32).toString("base64");
  it("needs the app id, secret and a real 32-byte key", async () => {
    const { squareReady } = await import("@/lib/pos/square/oauth-core");
    expect(
      squareReady({
        SQUARE_APPLICATION_ID: "a",
        SQUARE_APPLICATION_SECRET: "b",
        POS_TOKEN_ENCRYPTION_KEY: key,
      }),
    ).toBe(true);
    expect(
      squareReady({
        SQUARE_APPLICATION_ID: "a",
        SQUARE_APPLICATION_SECRET: "b",
      }),
    ).toBe(false);
    expect(
      squareReady({
        SQUARE_APPLICATION_ID: "a",
        SQUARE_APPLICATION_SECRET: "b",
        POS_TOKEN_ENCRYPTION_KEY: "short",
      }),
    ).toBe(false);
    expect(
      squareReady({
        SQUARE_APPLICATION_SECRET: "b",
        POS_TOKEN_ENCRYPTION_KEY: key,
      }),
    ).toBe(false);
  });
});
