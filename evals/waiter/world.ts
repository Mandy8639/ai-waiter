import type { z } from "zod";
import type { ConversationMessage } from "@/lib/ai/conversation";
import type { LoopToolOutcome } from "@/lib/ai/loop";
import {
  checkOrderConfirmation,
  computeCartFingerprint,
} from "@/lib/ai/tools/order-confirmation";
import {
  checkCancelConfirmation,
  parsePendingCancellation,
} from "@/lib/ai/tools/cancel-confirmation";
import { assertedClaims, statedAllergens } from "@/lib/menu/diet-filters";
import { DINER_CONFIRMATIONS } from "@/lib/table-requests/core";
import { buildMenuGraph, type MenuGraph } from "@/lib/menu-graph/core";
import {
  allergenCheckResult,
  pairingsResult,
} from "@/lib/menu-graph/tool-results";
import {
  DISH,
  HOUSE_FAVORITES,
  MENU,
  PAIRINGS,
  RESTAURANT,
  dishById,
} from "./menu";

/**
 * One diner's visit, in memory: the cart, their orders, the table
 * requests they made and the conversation log. The waiter's tools run
 * against this instead of Supabase.
 *
 * What is real: every tool's argument schema (the same Zod objects
 * production validates with), the order-confirmation and
 * cancel-confirmation rules (order-confirmation.ts / cancel-confirmation.ts,
 * imported, not copied), the dietary-claim and allergen wording, and the
 * shape of every result. What is simulated: storage, and the kitchen.
 */

export interface CartLine {
  id: string;
  menuItemId: string;
  quantity: number;
  optionIds: string[];
  spicePreference?: string;
  notes?: string;
}

export interface Order {
  id: string;
  orderNumber: number;
  status:
    "pending" | "confirmed" | "preparing" | "ready" | "served" | "cancelled";
  lines: CartLine[];
  total: number;
  paidByCard: boolean;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
}

type ToolSchemas = Map<string, z.ZodType>;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The fixture restaurant as a menu knowledge graph, built by the same
 * code production uses (src/lib/menu-graph/core.ts). Fixture allergens are
 * the restaurant's confirmed ones.
 */
let fixtureGraph: MenuGraph | null = null;
function menuGraph(): MenuGraph {
  fixtureGraph ??= buildMenuGraph({
    currency: RESTAURANT.currency,
    sections: RESTAURANT.categories.map((c) => ({ id: c, name: c })),
    dishes: MENU.filter((d) => d.available).map((d) => ({
      id: d.id,
      name: d.name,
      price: d.price,
      sectionId: d.category,
      isVegetarian: d.isVegetarian,
      isVegan: d.isVegan,
      isHalal: d.isHalal,
      isKosher: false,
      isSpicy: d.isSpicy,
      containsNuts: d.containsNuts,
      containsDairy: d.containsDairy,
      containsGluten: d.containsGluten,
    })),
    ingredients: MENU.flatMap((d) =>
      d.ingredients.map((name) => ({ dishId: d.id, name })),
    ),
    allergens: MENU.flatMap((d) =>
      d.allergens.map((name) => ({ dishId: d.id, name })),
    ),
    pairings: PAIRINGS,
  });
  return fixtureGraph;
}

export class World {
  cart: CartLine[] = [];
  orders: Order[] = [];
  serviceRequests: { kind: "waiter" | "bill"; note?: string }[] = [];
  messages: ConversationMessage[] = [];
  /** Every tool call this visit, in order, with what it returned. */
  calls: ToolCallRecord[] = [];
  private clock = Date.parse("2026-10-25T18:00:00Z");
  private seq = 0;

  constructor(private readonly schemas: ToolSchemas) {}

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  addMessage(role: "user" | "assistant", content: string) {
    this.messages.push({
      id: this.nextId("m"),
      role,
      content,
      toolName: null,
      toolSuccess: null,
      createdAt: this.now(),
    });
  }

  // --- setup helpers for scenarios ---------------------------------------

  seedCart(line: Omit<CartLine, "id">) {
    this.cart.push({ ...line, id: this.nextId("line") });
  }

  seedOrder(
    lines: Omit<CartLine, "id">[],
    status: Order["status"] = "pending",
    paidByCard = false,
  ) {
    const withIds = lines.map((l) => ({ ...l, id: this.nextId("line") }));
    this.orders.unshift({
      id: this.nextId("order"),
      orderNumber: 40 + this.orders.length + 1,
      status,
      lines: withIds,
      total: this.totals(withIds).total,
      paidByCard,
    });
  }

  // --- pricing ------------------------------------------------------------

  private linePrice(line: CartLine) {
    const d = dishById(line.menuItemId)!;
    const options = d.groups
      .flatMap((g) => g.options)
      .filter((o) => line.optionIds.includes(o.id));
    const modifiersPrice = options.reduce((s, o) => s + o.priceAdjustment, 0);
    return {
      dish: d,
      options,
      unitPrice: d.price,
      modifiersPrice,
      lineTotal: round((d.price + modifiersPrice) * line.quantity),
    };
  }

  private totals(lines: CartLine[]) {
    const subtotal = round(
      lines.reduce((s, l) => s + this.linePrice(l).lineTotal, 0),
    );
    const taxAmount = round(subtotal * RESTAURANT.taxRate);
    return { subtotal, taxAmount, total: round(subtotal + taxAmount) };
  }

  private fingerprint(lines: CartLine[]) {
    return computeCartFingerprint(
      lines.map((l) => {
        const p = this.linePrice(l);
        return {
          menuItemId: l.menuItemId,
          quantity: l.quantity,
          modifiers: p.options.map((o) => ({
            name: o.name,
            priceAdjustment: o.priceAdjustment,
          })),
          spicePreference: l.spicePreference ?? null,
          notes: l.notes ?? null,
        };
      }) as unknown as Parameters<typeof computeCartFingerprint>[0],
    );
  }

  private cartSummary() {
    const t = this.totals(this.cart);
    return {
      lines: this.cart.map((l) => {
        const p = this.linePrice(l);
        return {
          cartItemId: l.id,
          name: p.dish.name,
          quantity: l.quantity,
          unitPrice: p.unitPrice,
          modifiersPrice: p.modifiersPrice,
          lineTotal: p.lineTotal,
          modifiers: p.options.map((o) => o.name),
          stillAvailable: p.dish.available,
        };
      }),
      subtotal: t.subtotal,
      taxAmount: t.taxAmount,
      total: t.total,
      hasUnavailableItems: this.cart.some(
        (l) => !dishById(l.menuItemId)?.available,
      ),
    };
  }

  /** The current turn's user message time, and the latest successful call to `tool` before it. */
  private pendingCall(tool: string) {
    const lastUser =
      [...this.messages].reverse().find((m) => m.role === "user") ?? null;
    if (!lastUser) return { lastUserAt: null, row: null };
    const row =
      [...this.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "tool" &&
            m.toolName === tool &&
            m.toolSuccess === true &&
            m.createdAt < lastUser.createdAt,
        ) ?? null;
    return { lastUserAt: lastUser.createdAt, row };
  }

  // --- the tools ------------------------------------------------------------

  async executeTool(name: string, rawArgs: unknown): Promise<LoopToolOutcome> {
    const schema = this.schemas.get(name);
    let result: { ok: boolean; data?: unknown; error?: string };
    let args: unknown = rawArgs;
    if (!schema) {
      result = { ok: false, error: `Unknown tool: ${name}` };
    } else {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        result = {
          ok: false,
          error: `Invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
        };
      } else {
        args = parsed.data;
        result = this.run(name, parsed.data as Record<string, unknown>);
      }
    }
    this.calls.push({
      name,
      args,
      ok: result.ok,
      data: result.data,
      error: result.error,
    });
    this.messages.push({
      id: this.nextId("m"),
      role: "tool",
      content: JSON.stringify(result).slice(0, 4000),
      toolName: name,
      toolSuccess: result.ok,
      createdAt: this.now(),
    });
    return { toolName: name, result };
  }

  private run(
    name: string,
    a: Record<string, unknown>,
  ): { ok: boolean; data?: unknown; error?: string } {
    switch (name) {
      case "get_restaurant_info":
        return {
          ok: true,
          data: {
            houseFavorites: HOUSE_FAVORITES.map((i) => {
              const d = dishById(i)!;
              return { id: d.id, name: d.name, price: d.price };
            }),
            mostOrderedThisMonth: [],
            menuCategories: RESTAURANT.categories,
            menus: [
              {
                name: "All day",
                hours: "11:00 AM – 10:00 PM",
                servingNow: true,
              },
            ],
            currency: RESTAURANT.currency,
            name: RESTAURANT.name,
            description: RESTAURANT.description,
            address: RESTAURANT.address,
            city: RESTAURANT.city,
            state: RESTAURANT.state,
            phone: RESTAURANT.phone,
            isActive: true,
          },
        };

      case "search_menu": {
        const wanted =
          typeof a.category === "string" ? a.category.trim().toLowerCase() : "";
        if (
          wanted &&
          !RESTAURANT.categories.some((c) => c.toLowerCase() === wanted)
        ) {
          return {
            ok: true,
            data: {
              items: [],
              note: `This restaurant has no menu category called "${a.category}". Its categories are: ${RESTAURANT.categories.join(", ")}.`,
            },
          };
        }
        const q =
          typeof a.query === "string" ? a.query.trim().toLowerCase() : "";
        const items = MENU.filter((d) => d.available)
          .filter((d) => !wanted || d.category.toLowerCase() === wanted)
          .filter(
            (d) =>
              !q ||
              d.name.toLowerCase().includes(q) ||
              d.description.toLowerCase().includes(q),
          )
          .filter(
            (d) => a.dietary !== "vegetarian" || d.isVegetarian || d.isVegan,
          )
          .filter((d) => a.dietary !== "vegan" || d.isVegan)
          .filter((d) => a.dietary !== "halal" || d.isHalal)
          // No dish here is marked kosher.
          .filter(() => a.dietary !== "kosher")
          .filter((d) => !a.spicyOnly || d.isSpicy)
          .slice(0, 25);
        return {
          ok: true,
          data: {
            currency: RESTAURANT.currency,
            items: items.map((d) => ({
              id: d.id,
              name: d.name,
              description: d.description,
              price: d.price,
              isVegetarian: d.isVegetarian,
              isVegan: d.isVegan,
              isSpicy: d.isSpicy,
              dietaryClaims: assertedClaims({
                isVegetarian: d.isVegetarian,
                isVegan: d.isVegan,
                isSpicy: d.isSpicy,
                isHalal: d.isHalal,
                isKosher: false,
              }),
              category: d.category,
            })),
          },
        };
      }

      case "get_menu_item": {
        const d = dishById(a.menuItemId as string);
        if (!d || !d.available) {
          return {
            ok: false,
            error:
              "That item isn't on the menu (or isn't currently available).",
          };
        }
        return {
          ok: true,
          data: {
            currency: RESTAURANT.currency,
            id: d.id,
            name: d.name,
            description: d.description,
            price: d.price,
            isVegetarian: d.isVegetarian,
            isVegan: d.isVegan,
            isSpicy: d.isSpicy,
            dietaryClaims: assertedClaims({
              isVegetarian: d.isVegetarian,
              isVegan: d.isVegan,
              isSpicy: d.isSpicy,
              isHalal: d.isHalal,
              isKosher: false,
            }),
            spiceLevel: d.spiceLevel,
            preparationTimeMinutes: d.preparationTimeMinutes,
            portionNote: d.portionNote,
            nutrition: d.nutrition
              ? { perServing: true, ...d.nutrition }
              : null,
            ingredients: d.ingredients,
            declaredAllergens: statedAllergens(d.allergens, {
              containsNuts: d.containsNuts,
              containsDairy: d.containsDairy,
              containsGluten: d.containsGluten,
            }),
            modifierGroups: d.groups,
          },
        };
      }

      case "check_menu_allergens":
        return allergenCheckResult(menuGraph(), RESTAURANT.currency, {
          allergens: String(a.allergens ?? ""),
          dietary: typeof a.dietary === "string" ? a.dietary : undefined,
          notSpicy: a.notSpicy === true,
        });

      case "get_pairings":
        return pairingsResult(
          menuGraph(),
          RESTAURANT.currency,
          String(a.menuItemId ?? ""),
        );

      case "get_cart":
        return { ok: true, data: this.cartSummary() };

      case "add_item_to_cart": {
        const d = dishById(a.menuItemId as string);
        if (!d)
          return { ok: false, error: "This item is no longer on the menu." };
        if (!d.available)
          return { ok: false, error: "This item is currently unavailable." };
        const optionIds = (a.selectedOptionIds as string[]) ?? [];
        const allOptions = d.groups.flatMap((g) =>
          g.options.map((o) => ({ ...o, groupId: g.id })),
        );
        if (optionIds.some((o) => !allOptions.some((x) => x.id === o))) {
          return {
            ok: false,
            error: "One of the selected options isn't valid for this item.",
          };
        }
        for (const g of d.groups) {
          const count = optionIds.filter((o) =>
            g.options.some((x) => x.id === o),
          ).length;
          const min = g.isRequired
            ? Math.max(1, g.minSelections)
            : g.minSelections;
          if (count < min) {
            return {
              ok: false,
              error: g.isRequired
                ? `Please make a selection for "${g.name}".`
                : `Choose at least ${min} option(s) for "${g.name}".`,
            };
          }
          if (count > g.maxSelections) {
            return {
              ok: false,
              error: `Choose at most ${g.maxSelections} option(s) for "${g.name}".`,
            };
          }
        }
        this.cart.push({
          id: this.nextId("line"),
          menuItemId: d.id,
          quantity: a.quantity as number,
          optionIds,
          spicePreference: a.spicePreference as string | undefined,
          notes: a.notes as string | undefined,
        });
        return { ok: true, data: { added: true } };
      }

      case "update_cart_item": {
        const line = this.cart.find((l) => l.id === a.cartItemId);
        if (!line)
          return { ok: false, error: "That item is no longer in your cart." };
        line.quantity = a.quantity as number;
        return { ok: true, data: { updated: true } };
      }

      case "remove_cart_item": {
        const before = this.cart.length;
        this.cart = this.cart.filter((l) => l.id !== a.cartItemId);
        if (this.cart.length === before)
          return { ok: false, error: "That item is no longer in your cart." };
        return { ok: true, data: { removed: true } };
      }

      case "clear_cart":
        this.cart = [];
        return { ok: true, data: { cleared: true } };

      case "request_order_confirmation": {
        if (this.cart.length === 0) {
          return {
            ok: false,
            error:
              "The cart is empty — add something before requesting a total.",
          };
        }
        const t = this.totals(this.cart);
        return {
          ok: true,
          data: {
            lines: this.cart.map((l) => {
              const p = this.linePrice(l);
              return {
                name: p.dish.name,
                quantity: l.quantity,
                modifiers: p.options.map((o) => o.name),
                lineTotal: p.lineTotal,
              };
            }),
            ...t,
            cartFingerprint: this.fingerprint(this.cart),
          },
        };
      }

      case "submit_order": {
        const { lastUserAt, row } = this.pendingCall(
          "request_order_confirmation",
        );
        let pending = null;
        if (row) {
          try {
            const fp = (
              JSON.parse(row.content) as { data?: { cartFingerprint?: string } }
            ).data?.cartFingerprint;
            if (fp) pending = { fingerprint: fp, requestedAt: row.createdAt };
          } catch {
            pending = null;
          }
        }
        const decision = checkOrderConfirmation({
          pending,
          currentFingerprint: this.fingerprint(this.cart),
          currentTurnUserMessageAt: lastUserAt,
        });
        if (!decision.confirmed) return { ok: false, error: decision.reason };
        if (this.cart.length === 0)
          return {
            ok: false,
            error: "Your cart is empty — add something before ordering.",
          };
        const order: Order = {
          id: this.nextId("order"),
          orderNumber: 40 + this.orders.length + 1,
          status: "pending",
          lines: this.cart,
          total: this.totals(this.cart).total,
          paidByCard: false,
        };
        this.orders.unshift(order);
        this.cart = [];
        return { ok: true, data: { orderId: order.id } };
      }

      case "get_order_status": {
        const o = this.orders[0];
        if (!o)
          return {
            ok: false,
            error: "No orders have been placed in this session yet.",
          };
        return {
          ok: true,
          data: {
            orderNumber: o.orderNumber,
            status: o.status,
            total: o.total,
            currency: RESTAURANT.currency,
            createdAt: new Date(this.clock - 5 * 60_000).toISOString(),
            estimatedTotalMinutes: 25,
            estimatedMinutesRemaining: 15,
            estimatedMinutesRemainingAtWorst: 25,
            ordersAheadInKitchen: 2,
            items: o.lines.map((l) => {
              const p = this.linePrice(l);
              return {
                name: p.dish.name,
                quantity: l.quantity,
                modifiers: p.options.map((x) => x.name),
              };
            }),
          },
        };
      }

      case "get_customer_order_history":
        return {
          ok: true,
          data: {
            orders: this.orders.map((o) => ({
              orderNumber: o.orderNumber,
              status: o.status,
              total: o.total,
              currency: RESTAURANT.currency,
            })),
          },
        };

      case "request_order_cancellation": {
        const o = this.orders[0];
        if (!o)
          return {
            ok: false,
            error: "No orders have been placed in this visit.",
          };
        if (o.status === "cancelled")
          return {
            ok: false,
            error: `Order #${o.orderNumber} is already cancelled.`,
          };
        if (o.status !== "pending") {
          return {
            ok: false,
            error: `The kitchen has already accepted order #${o.orderNumber}, so it can't be cancelled here — the customer should ask a member of staff (you can call one with request_service).`,
          };
        }
        if (o.paidByCard) {
          return {
            ok: false,
            error: `Order #${o.orderNumber} has been paid by card, so a member of staff needs to cancel and refund it.`,
          };
        }
        return {
          ok: true,
          data: {
            orderId: o.id,
            orderNumber: o.orderNumber,
            items: o.lines.map(
              (l) => `${l.quantity} × ${dishById(l.menuItemId)!.name}`,
            ),
            total: o.total,
            currency: RESTAURANT.currency,
          },
        };
      }

      case "cancel_order": {
        const { lastUserAt, row } = this.pendingCall(
          "request_order_cancellation",
        );
        const current = this.orders[0] ?? null;
        const decision = checkCancelConfirmation({
          pending: parsePendingCancellation(
            row ? { content: row.content, createdAt: row.createdAt } : null,
          ),
          currentOrderId: current?.id ?? null,
          currentTurnUserMessageAt: lastUserAt,
        });
        if (!decision.confirmed || !current)
          return { ok: false, error: decision.reason };
        if (current.status !== "pending") {
          return {
            ok: false,
            error: "The kitchen has already accepted that order.",
          };
        }
        current.status = "cancelled";
        if (!a.putBackInCart) return { ok: true, data: { cancelled: true } };
        for (const l of current.lines)
          this.cart.push({ ...l, id: this.nextId("line") });
        return {
          ok: true,
          data: {
            cancelled: true,
            backInCart: current.lines.map((l) => dishById(l.menuItemId)!.name),
            couldNotPutBack: null,
          },
        };
      }

      case "request_service": {
        const kind = a.kind as "waiter" | "bill";
        this.serviceRequests.push({ kind, note: a.note as string | undefined });
        return {
          ok: true,
          data: {
            requestId: this.nextId("req"),
            kind,
            confirmation: DINER_CONFIRMATIONS[kind],
          },
        };
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }
}

export { DISH };
