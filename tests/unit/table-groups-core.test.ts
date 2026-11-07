import { describe, expect, it } from "vitest";
import {
  groupErrorMessage,
  groupSections,
  memberLabel,
  othersList,
  parseGroupState,
  type GroupLine,
  type GroupMember,
} from "@/lib/table-groups/core";

const sam: GroupMember = { position: 1, name: "Sam", isMe: false };
const me: GroupMember = { position: 2, name: "Priya", isMe: true };
const guest3: GroupMember = { position: 3, name: null, isMe: false };

function line(memberPosition: number, lineTotal: number): GroupLine {
  return {
    id: `${memberPosition}-${lineTotal}`,
    memberPosition,
    isMine: memberPosition === 2,
    menuItemId: "m",
    name: "Dish",
    quantity: 1,
    lineTotal,
    modifiers: [],
    spicePreference: null,
    notes: null,
    stillAvailable: true,
  };
}

describe("parseGroupState", () => {
  it("reads a membership", () => {
    expect(
      parseGroupState({
        kind: "member",
        group_id: "g",
        members: [
          { position: 1, name: "Sam", is_me: false },
          { position: 2, name: null, is_me: true },
          { name: "no position" },
        ],
      }),
    ).toEqual({
      kind: "member",
      groupId: "g",
      members: [
        { position: 1, name: "Sam", isMe: false },
        { position: 2, name: null, isMe: true },
      ],
    });
  });

  it("falls back to none on anything unexpected", () => {
    expect(parseGroupState(null)).toEqual({ kind: "none" });
    expect(parseGroupState({ kind: "member" })).toEqual({ kind: "none" });
    expect(parseGroupState({ kind: "not_a_table" })).toEqual({
      kind: "not_a_table",
    });
  });
});

describe("names", () => {
  it("calls the reader You and the unnamed by number", () => {
    expect(memberLabel(me)).toBe("You");
    expect(memberLabel(sam)).toBe("Sam");
    expect(memberLabel(guest3)).toBe("Guest 3");
  });

  it("lists everyone but the reader", () => {
    expect(othersList([me])).toBe("");
    expect(othersList([sam, me])).toBe("Sam");
    expect(othersList([sam, me, guest3])).toBe("Sam and Guest 3");
    expect(
      othersList([sam, guest3, { position: 4, name: "Ana", isMe: false }]),
    ).toBe("Sam, Guest 3 and Ana");
  });
});

describe("groupSections", () => {
  it("puts the reader first and keeps people who haven't added anything", () => {
    const sections = groupSections(
      [sam, me, guest3],
      [line(1, 10), line(2, 4), line(1, 5)],
    );
    expect(sections.map((s) => memberLabel(s.member))).toEqual([
      "You",
      "Sam",
      "Guest 3",
    ]);
    expect(sections.map((s) => s.subtotal)).toEqual([4, 15, 0]);
    expect(sections[2].lines).toEqual([]);
  });
});

describe("groupErrorMessage", () => {
  it("turns codes into sentences", () => {
    expect(groupErrorMessage("TABLE_GROUP_EXISTS")).toMatch(/Join theirs/);
    expect(groupErrorMessage("TABLE_GROUP_NOT_FOUND")).toMatch(/ended/);
    expect(groupErrorMessage("boom")).toMatch(/try again/);
  });
});
