import { describe, expect, it } from "vitest";
import {
  compareGrants,
  expectedGrantsFromMigrations,
  findOverloads,
  type LiveFunctionGrant,
} from "@/lib/db-audit/function-grants-core";

/**
 * The two cases that actually happened on 2026-09-19 are pinned here as
 * regressions. Both were invisible to every other test in this repo,
 * because the integration harness builds its database *from* the
 * migrations — so the grants always match the migrations there, no matter
 * what the live project looks like.
 */

function liveRow(
  over: Partial<LiveFunctionGrant> & { name: string },
): LiveFunctionGrant {
  return {
    signature: `${over.name}()`,
    pub: true,
    anon: true,
    authenticated: true,
    service_role: true,
    ...over,
  };
}

describe("expectedGrantsFromMigrations", () => {
  it("starts from Supabase's permissive default when no migration says otherwise", () => {
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.other_fn(uuid) from anon;",
    ]);
    expect(expected.has("untouched_fn")).toBe(false);
  });

  it("applies revokes and later grants in order", () => {
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.get_restaurant_staff(uuid) from public;",
      "grant execute on function public.get_restaurant_staff(uuid) to authenticated;",
    ]);
    expect(expected.get("get_restaurant_staff")).toEqual({
      pub: false,
      anon: true,
      authenticated: true,
      service_role: true,
    });
  });

  it("parses a statement broken across lines", () => {
    const expected = expectedGrantsFromMigrations([
      `revoke execute on function public.record_restaurant_subscription(
         uuid, uuid, text, text, text, timestamptz, boolean
       ) from public, anon, authenticated;`,
    ]);
    expect(expected.get("record_restaurant_subscription")).toEqual({
      pub: false,
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("ignores roles outside the API set", () => {
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.f(uuid) from postgres, dashboard_user, anon;",
    ]);
    expect(expected.get("f")).toMatchObject({ anon: false, pub: true });
  });
});

describe("compareGrants", () => {
  it("stays quiet about functions the migrations never mention", () => {
    // The ~23 helpers that are deliberately left callable must not be noise,
    // or the report gets ignored and stops working as a guard.
    const drifts = compareGrants(new Map(), [
      liveRow({ name: "order_status_rank" }),
    ]);
    expect(drifts).toEqual([]);
  });

  it("catches a hand-recreated function whose ACL reset to PUBLIC", () => {
    // get_restaurant_staff: dropped and recreated in the SQL editor during
    // the PGRST202 fix, which restored Postgres's default PUBLIC grant. The
    // migration's revoke had already run and never ran again.
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.get_restaurant_staff(uuid) from public;",
      "grant execute on function public.get_restaurant_staff(uuid) to authenticated;",
    ]);
    const drifts = compareGrants(expected, [
      liveRow({
        name: "get_restaurant_staff",
        signature: "get_restaurant_staff(uuid)",
      }),
    ]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      name: "get_restaurant_staff",
      grantee: "pub",
      expected: false,
      actual: true,
      morePermissive: true,
    });
  });

  it("catches a migration edited after it was applied", () => {
    // The menu-photos migration gained its anon revokes only after it had
    // already been pushed, so production kept the draft's grants while
    // `supabase db push` reported "up to date".
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.publish_menu_item_image(uuid) from public, anon;",
      "grant execute on function public.publish_menu_item_image(uuid) to authenticated;",
    ]);
    const drifts = compareGrants(expected, [
      liveRow({
        name: "publish_menu_item_image",
        signature: "publish_menu_item_image(uuid)",
        pub: false, // the draft did revoke PUBLIC …
        anon: true, // … but never anon
      }),
    ]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      grantee: "anon",
      expected: false,
      actual: true,
      morePermissive: true,
    });
  });

  it("does not report a role as drifted when PUBLIC legitimately still holds EXECUTE", () => {
    // has_function_privilege() answers true when PUBLIC holds the grant, so
    // a revoke aimed only at anon cannot make it false. The database matches
    // the migrations here; the migration being ineffective is a separate,
    // repo-level problem and must not be reported as live drift.
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.f(uuid) from anon;",
    ]);
    const drifts = compareGrants(expected, [liveRow({ name: "f" })]);
    expect(drifts).toEqual([]);
  });

  it("reports a missing grant too, but not as more permissive", () => {
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.f(uuid) from public, anon;",
      "grant execute on function public.f(uuid) to authenticated;",
    ]);
    const drifts = compareGrants(expected, [
      liveRow({ name: "f", pub: false, anon: false, authenticated: false }),
    ]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      grantee: "authenticated",
      expected: true,
      actual: false,
      morePermissive: false,
    });
  });

  it("sorts the more permissive drifts first", () => {
    const expected = expectedGrantsFromMigrations([
      "revoke execute on function public.leaky(uuid) from public, anon;",
      "revoke execute on function public.missing(uuid) from public, anon;",
      "grant execute on function public.missing(uuid) to authenticated;",
    ]);
    const drifts = compareGrants(expected, [
      liveRow({
        name: "missing",
        pub: false,
        anon: false,
        authenticated: false,
      }),
      liveRow({ name: "leaky", pub: false, anon: true }),
    ]);

    expect(drifts.map((d) => [d.name, d.morePermissive])).toEqual([
      ["leaky", true],
      ["missing", false],
    ]);
  });
});

describe("findOverloads", () => {
  it("returns nothing when every name is unique", () => {
    expect(
      findOverloads([liveRow({ name: "a" }), liveRow({ name: "b" })]),
    ).toEqual([]);
  });

  it("flags a name carrying two signatures, since comparison is keyed by name", () => {
    expect(
      findOverloads([
        liveRow({ name: "f", signature: "f(uuid)" }),
        liveRow({ name: "f", signature: "f(uuid,text)" }),
      ]),
    ).toEqual(["f"]);
  });
});
