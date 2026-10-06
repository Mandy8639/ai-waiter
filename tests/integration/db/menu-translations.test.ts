// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createRestaurant,
  type Role,
} from "./helpers";

/**
 * Phase K: menu translation. The two promises: nothing reaches a diner
 * unreviewed, and a translation of old text is never shown.
 */

interface Served {
  translated_entity: string;
  translated_entity_id: string;
  translated_field: string;
  translated_text: string;
}

describe("menu translations", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function menu() {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId, {
      name: "Masala Dosa",
    });
    await db.admin.query(
      "update public.menu_items set description = $2 where id = $1;",
      [dishId, "Crisp rice crepe with spiced potato."],
    );
    return { restaurantId, ownerId, categoryId, dishId };
  }

  async function save(
    userId: string,
    restaurantId: string,
    entityId: string,
    text: string,
    opts: {
      entity?: string;
      field?: string;
      language?: string;
      origin?: string;
    } = {},
  ) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ save_menu_translation: string }>(
        "select public.save_menu_translation($1, $2, $3, $4, $5, $6, $7);",
        [
          restaurantId,
          opts.entity ?? "menu_item",
          entityId,
          opts.field ?? "description",
          opts.language ?? "hi",
          text,
          opts.origin ?? "ai",
        ],
      ),
    );
    return rows[0].save_menu_translation;
  }

  async function approve(userId: string, id: string) {
    await db.asUser(userId, (c) =>
      c.query("select public.approve_menu_translation($1);", [id]),
    );
  }

  async function served(restaurantId: string, language = "hi") {
    const { rows } = await db.asAnon((c) =>
      c.query<Served>("select * from public.get_menu_translations($1, $2);", [
        restaurantId,
        language,
      ]),
    );
    return rows;
  }

  async function languages(restaurantId: string) {
    const { rows } = await db.asAnon((c) =>
      c.query<{ menu_language: string }>(
        "select * from public.get_menu_languages($1);",
        [restaurantId],
      ),
    );
    return rows.map((r) => r.menu_language);
  }

  describe("nothing reaches a diner unreviewed", () => {
    it("serves a draft to nobody, and an approved translation to everyone", async () => {
      const m = await menu();
      const id = await save(
        m.ownerId,
        m.restaurantId,
        m.dishId,
        "मसालेदार आलू के साथ कुरकुरा चावल का क्रेप।",
      );
      expect(await served(m.restaurantId)).toEqual([]);
      expect(await languages(m.restaurantId)).toEqual([]);

      await approve(m.ownerId, id);
      expect(await served(m.restaurantId)).toEqual([
        {
          translated_entity: "menu_item",
          translated_entity_id: m.dishId,
          translated_field: "description",
          translated_text: "मसालेदार आलू के साथ कुरकुरा चावल का क्रेप।",
        },
      ]);
      expect(await languages(m.restaurantId)).toEqual(["hi"]);
    });

    it("sends an approved translation back to draft when someone edits it", async () => {
      const m = await menu();
      const id = await save(m.ownerId, m.restaurantId, m.dishId, "Primera");
      await approve(m.ownerId, id);
      await save(m.ownerId, m.restaurantId, m.dishId, "Segunda", {
        origin: "owner",
      });
      expect(await served(m.restaurantId)).toEqual([]);
    });

    it("keeps each language separate", async () => {
      const m = await menu();
      await approve(
        m.ownerId,
        await save(m.ownerId, m.restaurantId, m.dishId, "Crepa", {
          language: "es",
        }),
      );
      expect(await served(m.restaurantId, "hi")).toEqual([]);
      expect(await served(m.restaurantId, "es")).toHaveLength(1);
    });
  });

  describe("a translation of old text is never shown", () => {
    it("stops serving a translation once the original changes", async () => {
      const m = await menu();
      await approve(
        m.ownerId,
        await save(m.ownerId, m.restaurantId, m.dishId, "पुराना विवरण"),
      );
      expect(await served(m.restaurantId)).toHaveLength(1);

      await db.admin.query(
        "update public.menu_items set description = 'Now with peanut chutney.' where id = $1;",
        [m.dishId],
      );
      expect(await served(m.restaurantId)).toEqual([]);
      expect(await languages(m.restaurantId)).toEqual([]);
    });

    it("serves it again only after someone re-approves it against the new text", async () => {
      const m = await menu();
      const id = await save(m.ownerId, m.restaurantId, m.dishId, "विवरण");
      await approve(m.ownerId, id);
      await db.admin.query(
        "update public.menu_items set description = 'Changed.' where id = $1;",
        [m.dishId],
      );
      await approve(m.ownerId, id);
      expect(await served(m.restaurantId)).toHaveLength(1);
    });

    it("forgets translations of a deleted dish or category", async () => {
      const m = await menu();
      await save(m.ownerId, m.restaurantId, m.dishId, "नाम", { field: "name" });
      await save(m.ownerId, m.restaurantId, m.categoryId, "मुख्य", {
        entity: "category",
        field: "name",
      });
      await db.admin.query("delete from public.menu_items where id = $1;", [
        m.dishId,
      ]);
      await db.admin.query("delete from public.categories where id = $1;", [
        m.categoryId,
      ]);
      const { rows } = await db.admin.query(
        "select 1 from public.menu_translations where restaurant_id = $1;",
        [m.restaurantId],
      );
      expect(rows).toEqual([]);
    });
  });

  it("hashes an original exactly as the app does, so both agree on what's stale", async () => {
    const { translationHash } = await import("@/lib/translations/core");
    for (const text of ["Masala Dosa", "मसाला डोसा", "Café · 2× chai", ""]) {
      const { rows } = await db.admin.query<{ h: string }>(
        "select public.menu_translation_hash($1) as h;",
        [text],
      );
      expect(rows[0].h).toBe(translationHash(text));
    }
  });

  describe("who can do what", () => {
    it("lets owners and managers translate, and nobody else", async () => {
      const m = await menu();
      const manager = await db.createAuthUser();
      await addMember(db, m.restaurantId, manager, "manager");
      await approve(
        manager,
        await save(manager, m.restaurantId, m.dishId, "Crepa", {
          language: "es",
        }),
      );

      for (const role of ["kitchen", "staff"] as Role[]) {
        const u = await db.createAuthUser();
        await addMember(db, m.restaurantId, u, role);
        await expect(save(u, m.restaurantId, m.dishId, "x")).rejects.toThrow(
          /TRANSLATION_FORBIDDEN/,
        );
      }

      const stranger = await menu();
      await expect(
        save(stranger.ownerId, m.restaurantId, m.dishId, "x"),
      ).rejects.toThrow(/TRANSLATION_FORBIDDEN/);
    });

    it("won't translate another restaurant's dish, or a description that isn't there", async () => {
      const m = await menu();
      const other = await menu();
      await expect(
        save(m.ownerId, m.restaurantId, other.dishId, "x"),
      ).rejects.toThrow(/TRANSLATION_NO_SOURCE/);

      await db.admin.query(
        "update public.menu_items set description = null where id = $1;",
        [m.dishId],
      );
      await expect(
        save(m.ownerId, m.restaurantId, m.dishId, "x"),
      ).rejects.toThrow(/TRANSLATION_NO_SOURCE/);
    });

    it("can't be written directly, only read by members", async () => {
      const m = await menu();
      await expect(
        db.asUser(m.ownerId, (c) =>
          c.query(
            `insert into public.menu_translations
               (restaurant_id, entity, entity_id, field, language, text, source_hash, status, origin, approved_at)
             values ($1, 'menu_item', $2, 'description', 'hi', 'x', 'x', 'approved', 'owner', now());`,
            [m.restaurantId, m.dishId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("refuses a language outside the four offered", async () => {
      const m = await menu();
      await expect(
        save(m.ownerId, m.restaurantId, m.dishId, "texte", { language: "fr" }),
      ).rejects.toThrow(/menu_translations_language_valid/);
    });

    it("serves nothing for an inactive restaurant", async () => {
      const m = await menu();
      await approve(
        m.ownerId,
        await save(m.ownerId, m.restaurantId, m.dishId, "विवरण"),
      );
      await db.admin.query(
        "update public.restaurants set is_active = false where id = $1;",
        [m.restaurantId],
      );
      expect(await served(m.restaurantId)).toEqual([]);
    });
  });
});
