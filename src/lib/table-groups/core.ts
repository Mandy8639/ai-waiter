/**
 * Ordering together, in words: who's who, how the shared cart is grouped,
 * and the database's error codes as sentences. Pure and free of
 * `server-only`, so it's unit-tested directly
 * (tests/unit/table-groups-core.test.ts).
 *
 * The rules themselves live in 20261129090000_table_groups.sql.
 */

export interface GroupMember {
  position: number;
  name: string | null;
  isMe: boolean;
}

export type TableGroupState =
  | { kind: "none" | "not_a_table" }
  | { kind: "member" | "can_join"; groupId: string; members: GroupMember[] };

/** table_group_state()'s jsonb, checked rather than trusted. */
export function parseGroupState(value: unknown): TableGroupState {
  if (!value || typeof value !== "object") return { kind: "none" };
  const v = value as Record<string, unknown>;
  if (v.kind === "not_a_table") return { kind: "not_a_table" };
  if (
    (v.kind === "member" || v.kind === "can_join") &&
    typeof v.group_id === "string" &&
    Array.isArray(v.members)
  ) {
    const members: GroupMember[] = [];
    for (const raw of v.members) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      if (typeof m.position !== "number") continue;
      members.push({
        position: m.position,
        name: typeof m.name === "string" ? m.name : null,
        isMe: m.is_me === true,
      });
    }
    return { kind: v.kind, groupId: v.group_id, members };
  }
  return { kind: "none" };
}

/** "You", the name they gave, or "Guest 2". */
export function memberLabel(member: GroupMember): string {
  if (member.isMe) return "You";
  return member.name ?? `Guest ${member.position}`;
}

/** "Sam", "Sam and Priya", "Sam, Priya and Guest 3". Never includes the reader. */
export function othersList(members: GroupMember[]): string {
  const names = members.filter((m) => !m.isMe).map(memberLabel);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface GroupLine {
  id: string;
  memberPosition: number;
  isMine: boolean;
  menuItemId: string;
  name: string;
  quantity: number;
  lineTotal: number;
  modifiers: string[];
  spicePreference: string | null;
  notes: string | null;
  stillAvailable: boolean;
}

export interface GroupSection {
  member: GroupMember;
  lines: GroupLine[];
  subtotal: number;
}

/**
 * The shared cart, one section per person: the reader first (it's the
 * part they can change), then everyone else in the order they joined.
 * People who haven't added anything yet still get a section, so it's
 * clear who's still choosing.
 */
export function groupSections(
  members: GroupMember[],
  lines: GroupLine[],
): GroupSection[] {
  const sections = members.map((member) => {
    const mine = lines.filter((l) => l.memberPosition === member.position);
    return {
      member,
      lines: mine,
      subtotal: mine.reduce((sum, l) => sum + l.lineTotal, 0),
    };
  });
  return sections.sort((a, b) => {
    if (a.member.isMe !== b.member.isMe) return a.member.isMe ? -1 : 1;
    return a.member.position - b.member.position;
  });
}

export function groupErrorMessage(message: string): string {
  if (message.includes("TABLE_GROUP_NO_SESSION")) {
    return "Scan the QR code on your table first.";
  }
  if (message.includes("TABLE_GROUP_EXISTS")) {
    return "Someone at your table already started a shared order. Join theirs instead.";
  }
  if (message.includes("TABLE_GROUP_NOT_FOUND")) {
    return "That shared order has ended. You can start a new one.";
  }
  if (message.includes("TABLE_GROUP_FULL")) {
    return "That shared order is full.";
  }
  if (message.includes("TABLE_GROUP_NOT_AT_TABLE")) {
    return "Ordering together is for tables, not the pickup counter.";
  }
  if (message.includes("TABLE_GROUP_NOT_MEMBER")) {
    return "You're no longer in this shared order. Reload to see your own.";
  }
  return "That didn't go through. Please try again.";
}
