import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloverApiUrl,
  cloverAuthorizeUrl,
  cloverNeedsRefresh,
  cloverOfferedTo,
  cloverReady,
  isCloverMerchantId,
  parseCloverState,
  parseCloverTokenResponse,
} from "@/lib/pos/clover/oauth-core";
import {
  CLOVER_UNCATEGORIZED_ID,
  mapCloverInventory,
} from "@/lib/pos/clover/catalog-core";
import { buildCloverOrder, pickOrderType } from "@/lib/pos/clover/order-core";

// Clover, phase 1 (20261121090000): connecting, importing the menu, and
// the atomic order a Tableside order becomes.

describe("connecting Clover", () => {
  it("sends the owner to Clover's sandbox or production sign-in", () => {
    const url = new URL(
      cloverAuthorizeUrl({
        environment: "sandbox",
        appId: "B9FYRQ8KPAJWJ",
        state: "r1.nonce",
        redirectUri: "https://tableside.menu/api/pos/clover/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://sandbox.dev.clover.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("B9FYRQ8KPAJWJ");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://tableside.menu/api/pos/clover/callback",
    );
    expect(cloverApiUrl("production")).toBe("https://api.clover.com");
    expect(cloverApiUrl("sandbox")).toBe("https://apisandbox.dev.clover.com");
  });

  it("reads Clover's token answer, Unix expiry included", () => {
    expect(
      parseCloverTokenResponse({
        access_token: "a",
        access_token_expiration: 1677875430,
        refresh_token: "r",
        refresh_token_expiration: 1709497830,
      }),
    ).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date(1677875430 * 1000).toISOString(),
    });
    expect(() => parseCloverTokenResponse({})).toThrow();
  });

  it("refreshes only when the token is about to expire", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    expect(cloverNeedsRefresh("2026-10-27T13:00:00Z", now)).toBe(false);
    expect(cloverNeedsRefresh("2026-10-27T12:03:00Z", now)).toBe(true);
    expect(cloverNeedsRefresh(null, now)).toBe(false);
  });

  it("trusts the cookie, and a state Clover echoes must match it", () => {
    expect(parseCloverState(null, "r1.n1")).toEqual({ restaurantId: "r1" });
    expect(parseCloverState("r1.n1", "r1.n1")).toEqual({
      restaurantId: "r1",
    });
    expect(parseCloverState("r2.n9", "r1.n1")).toBeNull();
    expect(parseCloverState("r1.n1", undefined)).toBeNull();
  });

  it("only accepts a merchant id that looks like Clover's", () => {
    expect(isCloverMerchantId("ABC123DEF4567")).toBe(true);
    expect(isCloverMerchantId("../etc")).toBe(false);
    expect(isCloverMerchantId(null)).toBe(false);
  });

  it("is offered only to the restaurants CLOVER_RESTAURANTS names", () => {
    expect(cloverOfferedTo("my-restaurant", "my-restaurant, demo")).toBe(true);
    expect(cloverOfferedTo("other", "my-restaurant")).toBe(false);
    expect(cloverOfferedTo("anyone", "all")).toBe(true);
    expect(cloverOfferedTo("anyone", undefined)).toBe(false);
  });

  it("needs an app id, a secret and a 32-byte token key", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(
      cloverReady({
        CLOVER_APP_ID: "a",
        CLOVER_APP_SECRET: "s",
        POS_TOKEN_ENCRYPTION_KEY: key,
      }),
    ).toBe(true);
    expect(
      cloverReady({ CLOVER_APP_ID: "a", POS_TOKEN_ENCRYPTION_KEY: key }),
    ).toBe(false);
  });
});

describe("importing a Clover menu", () => {
  const result = mapCloverInventory({
    categories: [
      { id: "C2", name: "Mains", sortOrder: 2 },
      { id: "C1", name: "Starters", sortOrder: 1 },
      { id: "C9", name: "Empty", sortOrder: 9 },
    ],
    modifierGroups: [
      {
        id: "G1",
        name: "Spice",
        minRequired: 1,
        maxAllowed: 1,
        modifiers: {
          elements: [
            { id: "M1", name: "Mild", price: 0 },
            { id: "M2", name: "Hot", price: 50 },
          ],
        },
      },
      {
        id: "G2",
        name: "Extras",
        maxAllowed: 0,
        modifiers: { elements: [{ id: "M3", name: "Raita", price: 150 }] },
      },
    ],
    items: [
      {
        id: "I1",
        name: "Chicken Biryani",
        price: 1700,
        priceType: "FIXED",
        categories: { elements: [{ id: "C2" }] },
        modifierGroups: { elements: [{ id: "G1" }, { id: "G2" }] },
      },
      {
        id: "I2",
        name: "Samosa",
        price: 650,
        categories: { elements: [{ id: "C1" }] },
      },
      { id: "I3", name: "Market fish", price: 0, priceType: "VARIABLE" },
      { id: "I4", name: "Soda", price: 250, hidden: true },
      { id: "I5", name: "Old dish", price: 900, deleted: true },
    ],
  });

  it("brings dishes in by Clover item id, in cents turned to dollars", () => {
    const biryani = result.menu.items.find((i) => i.external_id === "I1")!;
    expect(biryani).toMatchObject({
      name: "Chicken Biryani",
      price: 17,
      category_external_id: "C2",
      is_available: true,
    });
  });

  it("gives each dish its own copy of a shared modifier group", () => {
    const groups = result.menu.items.find(
      (i) => i.external_id === "I1",
    )!.groups;
    expect(groups[0]).toMatchObject({
      external_id: "mg:G1:I1",
      is_required: true,
      min_selections: 1,
      max_selections: 1,
    });
    expect(
      groups[0].options.map((o) => [o.external_id, o.price_adjustment]),
    ).toEqual([
      ["M1", 0],
      ["M2", 0.5],
    ]);
    // No limit set means any number.
    expect(groups[1]).toMatchObject({ is_required: false, max_selections: 1 });
  });

  it("keeps sections in Clover's order, only those with dishes, plus Other", () => {
    expect(result.menu.categories.map((c) => c.external_id)).toEqual([
      "C1",
      "C2",
      CLOVER_UNCATEGORIZED_ID,
    ]);
  });

  it("brings hidden items in unavailable, and skips register-priced ones", () => {
    expect(result.menu.items.find((i) => i.external_id === "I4")).toMatchObject(
      {
        is_available: false,
      },
    );
    expect(result.menu.items.some((i) => i.external_id === "I5")).toBe(false);
    expect(result.skipped).toEqual([
      { name: "Market fish", reason: "priced at the register" },
    ]);
  });
});

describe("a Tableside order as a Clover atomic order", () => {
  it("points imported dishes at their Clover items, one line per unit", () => {
    const order = buildCloverOrder({
      orderNumber: 12,
      tableLabel: "Table 4",
      customerNote: "No onions",
      orderTypeId: "OT1",
      lines: [
        {
          name: "Chicken Biryani",
          cloverItemId: "I1",
          unitPrice: 17,
          quantity: 2,
          options: [
            { name: "Hot", cloverModifierId: "M2", priceAdjustment: 0.5 },
            {
              name: "Extra lemon",
              cloverModifierId: null,
              priceAdjustment: 0.25,
            },
          ],
        },
      ],
    });
    expect(order.orderCart.lineItems).toHaveLength(2);
    expect(order.orderCart.lineItems[0]).toEqual({
      item: { id: "I1" },
      price: 1725,
      modifications: [{ modifier: { id: "M2" } }],
      note: "Extra lemon",
    });
    expect(order.orderCart.note).toBe(
      "Tableside #12 · Table 4 · Note: No onions",
    );
    expect(order.orderCart.orderType).toEqual({ id: "OT1" });
  });

  it("sends a dish added in Tableside as a named, priced line", () => {
    const order = buildCloverOrder({
      orderNumber: 3,
      tableLabel: null,
      customerNote: null,
      orderTypeId: null,
      lines: [
        {
          name: "Chef's special",
          cloverItemId: null,
          unitPrice: 12,
          quantity: 1,
          options: [
            { name: "Large", cloverModifierId: null, priceAdjustment: 3 },
          ],
        },
      ],
    });
    expect(order.orderCart.lineItems).toEqual([
      { name: "Chef's special", price: 1500, note: "Large" },
    ]);
    expect(order.orderCart.orderType).toBeUndefined();
  });

  it("refuses an order with nothing on it", () => {
    expect(() =>
      buildCloverOrder({
        orderNumber: 1,
        tableLabel: null,
        customerNote: null,
        orderTypeId: null,
        lines: [],
      }),
    ).toThrow();
  });

  it("files orders under a dine-in order type when the merchant has one", () => {
    expect(
      pickOrderType([
        { id: "A", label: "To Go" },
        { id: "B", label: "Dine In" },
      ]),
    ).toBe("B");
    expect(pickOrderType([{ id: "A", label: "To Go" }])).toBe("A");
    expect(pickOrderType([])).toBeNull();
  });
});

describe("who may use the service-key Clover token store", () => {
  // src/lib/pos/clover/api.ts reads pos_credentials with the service key.
  // Every importer must authorise the user first (authorizeClover), or be
  // the outbox worker delivering a restaurant's own orders; pin the list
  // so a new caller is a deliberate decision.
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
            .endsWith(path.join("pos", "clover"));
          if (
            /from ["']@\/lib\/pos\/clover\/api["']/.test(text) ||
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
        // The OAuth callback, after authorizeClover.
        "app/api/pos/clover/callback/route.ts",
        // Reads only whether Clover is configured.
        "app/dashboard/settings/pos/page.tsx",
        // Owner actions, each after authorizeClover.
        "lib/pos/clover/actions.ts",
        // The outbox worker: a restaurant's own placed orders only.
        "lib/pos/clover/deliver.ts",
      ].sort(),
    );
  });
});
