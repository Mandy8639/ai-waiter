import { describe, expect, it } from "vitest";
import {
  chooseFormat,
  formatForMediaType,
  needsInfo,
  parsePoll,
  pollReply,
  printedOk,
  isOnline,
  pollUpdate,
  SEEN_WRITE_EVERY_MS,
} from "@/lib/printing/cloudprnt-core";
import {
  docToText,
  pairLines,
  renderDoc,
  toLatin1,
  wrap,
  type PrintDoc,
} from "@/lib/printing/star-commands";
import {
  billDoc,
  partReceiptDoc,
  kitchenTicketDoc,
  receiptDoc,
  testDoc,
  type PrintOrder,
  type PrintRestaurant,
} from "@/lib/printing/documents";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const restaurant: PrintRestaurant = {
  name: "Spice Route",
  address: "12 Main St, Newark, NJ 07102",
  phone: "(973) 555-0100",
  timeZone: "America/New_York",
};

const order: PrintOrder = {
  orderNumber: 42,
  createdAt: "2026-10-22T23:05:00Z",
  placeLabel: "Table 4",
  customerNote: "Birthday — bring a candle",
  subtotal: 32.5,
  tax: 2.88,
  serviceCharge: 0,
  total: 35.38,
  currency: "USD",
  items: [
    {
      quantity: 2,
      itemName: "Chicken Biryani",
      lineTotal: 25,
      stationId: "grill",
      modifiers: ["Family"],
      spicePreference: "hot",
      notes: "no onions",
    },
    {
      quantity: 1,
      itemName: "Mango Lassi",
      lineTotal: 7.5,
      stationId: "bar",
      modifiers: [],
      spicePreference: null,
      notes: null,
    },
  ],
};

describe("parsing a printer's poll", () => {
  it("reads the MAC, status and what it said it is", () => {
    expect(
      parsePoll({
        printerMAC: "00:11:62:AB:CD:EF",
        statusCode: "200%20OK",
        clientAction: [
          { request: "ClientType", result: "Star mC-Print3" },
          {
            request: "Encodings",
            result:
              "application/vnd.star.line; application/vnd.star.starprnt; text/plain",
          },
        ],
      }),
    ).toEqual({
      mac: "00:11:62:ab:cd:ef",
      statusCode: "200 OK",
      clientType: "Star mC-Print3",
      encodings:
        "application/vnd.star.line; application/vnd.star.starprnt; text/plain",
    });
  });

  it("ignores junk", () => {
    expect(parsePoll("nope")).toEqual({
      mac: null,
      statusCode: null,
      clientType: null,
      encodings: null,
    });
    expect(parsePoll({ printerMAC: "not a mac" }).mac).toBeNull();
  });

  it("knows a printed job from a failed one", () => {
    expect(printedOk("200 OK")).toBe(true);
    expect(printedOk("200%20OK")).toBe(true);
    expect(printedOk("520 Paper out")).toBe(false);
    expect(printedOk(null)).toBe(false);
  });
});

describe("choosing how to talk to a printer", () => {
  it("uses Line Mode with UTF-8 on an mC-Print3", () => {
    expect(
      chooseFormat(
        "application/vnd.star.line;application/vnd.star.starprnt;text/plain",
        "Star mC-Print3",
      ),
    ).toEqual({
      mediaType: "application/vnd.star.line",
      format: "line",
      columns: 48,
      utf8: true,
    });
  });

  it("uses 42 columns and code page 1252 on an impact printer", () => {
    expect(
      chooseFormat("application/vnd.star.linematrix; text/plain", "Star SP742"),
    ).toEqual({
      mediaType: "application/vnd.star.linematrix",
      format: "line",
      columns: 42,
      utf8: false,
    });
  });

  it("uses StarPRNT, 32 columns on a 58mm printer, and plain text as a last resort", () => {
    expect(
      chooseFormat("application/vnd.star.starprnt", "Star mC-Print2"),
    ).toMatchObject({
      format: "starprnt",
      columns: 32,
    });
    expect(chooseFormat(null, null)).toMatchObject({
      format: "text",
      mediaType: "text/plain",
    });
  });

  it("honours the type a printer asks for", () => {
    const base = chooseFormat("application/vnd.star.line", "Star mC-Print3");
    expect(
      formatForMediaType("application/vnd.star.starprnt", base).format,
    ).toBe("starprnt");
    expect(formatForMediaType("image/png", base)).toBe(base);
  });
});

describe("answering a poll", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const format = chooseFormat("application/vnd.star.line", "Star mC-Print3");

  it("asks a new printer what it is before offering anything", () => {
    expect(needsInfo({ encodings: null, encodings_at: null }, now)).toBe(true);
    expect(pollReply({ askInfo: true, job: { id: "j" }, format })).toEqual({
      jobReady: false,
      clientAction: [{ request: "ClientType" }, { request: "Encodings" }],
    });
  });

  it("asks again after a day", () => {
    expect(
      needsInfo({ encodings: "x", encodings_at: "2026-10-21T11:00:00Z" }, now),
    ).toBe(true);
    expect(
      needsInfo({ encodings: "x", encodings_at: "2026-10-22T11:00:00Z" }, now),
    ).toBe(false);
  });

  it("offers a waiting job in exactly one media type", () => {
    expect(pollReply({ askInfo: false, job: { id: "job-1" }, format })).toEqual(
      {
        jobReady: true,
        mediaTypes: ["application/vnd.star.line"],
        jobToken: "job-1",
        deleteMethod: "DELETE",
      },
    );
    expect(pollReply({ askInfo: false, job: null, format })).toEqual({
      jobReady: false,
    });
  });

  it("counts a printer as online for a minute after its last poll", () => {
    expect(isOnline("2026-10-22T11:59:30Z", now)).toBe(true);
    expect(isOnline("2026-10-22T11:58:00Z", now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
  });
});

describe("noting a poll", () => {
  const now = new Date("2026-10-27T18:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const known = {
    mac: "00:11:62:aa:bb:cc",
    client_type: "Star mC-Print3",
    last_seen_at: ago(4_000),
    last_status: "200 OK",
  };
  const poll = {
    mac: "00:11:62:aa:bb:cc",
    statusCode: "200 OK",
    clientType: null,
    encodings: null,
  };

  it("skips the write when nothing changed and it was seen recently", () => {
    expect(pollUpdate(known, poll, now)).toBeNull();
  });

  it('writes "last seen" again once it is getting old', () => {
    const update = pollUpdate(
      { ...known, last_seen_at: ago(SEEN_WRITE_EVERY_MS) },
      poll,
      now,
    );
    expect(update).toEqual({
      last_seen_at: now.toISOString(),
      last_status: "200 OK",
    });
  });

  it("writes at once when the status changes", () => {
    expect(
      pollUpdate(known, { ...poll, statusCode: "200 Paper empty" }, now),
    ).toMatchObject({ last_status: "200 Paper empty" });
  });

  it("writes what the printer says about itself", () => {
    expect(
      pollUpdate(
        known,
        { ...poll, clientType: "Star TSP143IV", encodings: "text/plain" },
        now,
      ),
    ).toMatchObject({
      client_type: "Star TSP143IV",
      encodings: "text/plain",
      encodings_at: now.toISOString(),
    });
  });

  it("writes the first poll of a printer never seen", () => {
    expect(
      pollUpdate({ ...known, last_seen_at: null }, poll, now),
    ).not.toBeNull();
  });

  it("keeps the printer online between writes", () => {
    expect(isOnline(ago(SEEN_WRITE_EVERY_MS * 2), now)).toBe(true);
  });
});

describe("laying out text", () => {
  it("wraps at spaces and splits words longer than a line", () => {
    expect(wrap("Chicken Biryani with extra raita", 16)).toEqual([
      "Chicken Biryani",
      "with extra raita",
    ]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("   ! no onions and no garlic please", 20)).toEqual([
      "   ! no onions and",
      "   no garlic please",
    ]);
  });

  it("keeps an amount right-aligned on the last line", () => {
    expect(pairLines("2 x Biryani", "$25.00", 24)).toEqual([
      "2 x Biryani       $25.00",
    ]);
    expect(pairLines("2 x Chicken Biryani Family Size", "$25.00", 24)).toEqual([
      "2 x Chicken Biryani",
      "Family Size       $25.00",
    ]);
    expect(pairLines("2 x Chicken Biryani Family", "$25.00", 24)).toEqual([
      "2 x Chicken Biryani",
      "Family            $25.00",
    ]);
    expect(pairLines("Paneer Butter Masala", "$125.00", 24)).toEqual([
      "Paneer Butter Masala",
      "                 $125.00",
    ]);
  });

  it("brings 1252 printers as close as it can", () => {
    expect(toLatin1("Crème brûlée — “chef’s” ₹200 पनीर")).toBe(
      'Creme brulee - "chef\'s" Rs200 ????',
    );
  });
});

describe("the bytes", () => {
  const doc: PrintDoc = {
    lines: [
      { kind: "text", text: "#7", align: "center", bold: true, size: 2 },
      { kind: "text", text: "Hi" },
    ],
    openDrawer: true,
  };

  it("writes Star Line Mode: init, code page, drawer, text, cut", () => {
    const bytes = hex(
      renderDoc(doc, { format: "line", columns: 48, utf8: false }),
    );
    expect(bytes).toBe(
      [
        "1b40", // initialise
        "1b1d7420", // code page 1252
        "1b1d07010a0a", // drawer pulse (Line Mode)
        "1b1d6101", // centre
        "1b45", // bold
        "1b690101", // double size
        "2337",
        "0a", // "#7"
        "1b690000",
        "1b46",
        "1b1d6100", // left
        "4869",
        "0a", // "Hi"
        "0a0a1b6403", // feed, partial cut
      ].join(""),
    );
  });

  it("uses StarPRNT's drawer command and UTF-8 when asked", () => {
    const bytes = hex(
      renderDoc(doc, { format: "starprnt", columns: 48, utf8: true }),
    );
    expect(
      bytes.startsWith("1b40" + "1b1d295502003001" + "1b1d295502004000"),
    ).toBe(true);
    expect(bytes).toContain("1b1d191101" + "0a0a" + "1b1d1912010100");
    expect(bytes).not.toContain("1b1d07");
  });

  it("prints plain text for a text/plain printer", () => {
    const bytes = renderDoc(
      { lines: [{ kind: "text", text: "Hello" }] },
      { format: "text", columns: 48, utf8: true },
    );
    expect(Buffer.from(bytes).toString("utf8")).toBe("Hello\n");
  });

  it("opens the drawer without printing or cutting", () => {
    expect(
      hex(
        renderDoc(
          { lines: [], openDrawer: true, cut: false },
          { format: "line", columns: 48, utf8: false },
        ),
      ),
    ).toBe("1b40" + "1b1d7420" + "1b1d07010a0a");
  });
});

describe("what goes on paper", () => {
  it("prints a kitchen ticket with add-ons, spice, notes and the order note", () => {
    const doc = kitchenTicketDoc(order, { restaurant })!;
    expect(docToText(doc, 42)).toEqual([
      "         #42",
      "                 Table 4",
      "                 7:05 PM",
      "-".repeat(42),
      "2 x Chicken Biryani",
      "   + Family",
      "   * Hot",
      "   ! no onions",
      "1 x Mango Lassi",
      "-".repeat(42),
      "Note: Birthday — bring a candle",
    ]);
  });

  it("gives a station printer only its dishes, or nothing", () => {
    const bar = kitchenTicketDoc(order, {
      restaurant,
      stationId: "bar",
      stationName: "Bar",
      reprint: true,
    })!;
    const lines = docToText(bar, 42);
    expect(lines[0]).toContain("** REPRINT **");
    expect(lines).toContain("1 x Mango Lassi");
    expect(lines).not.toContain("2 x Chicken Biryani");
    expect(lines.some((l) => l.includes("7:05 PM · Bar"))).toBe(true);

    expect(
      kitchenTicketDoc(order, { restaurant, stationId: "pastry" }),
    ).toBeNull();
  });

  it("prints a bill with the total", () => {
    const lines = docToText(
      billDoc([order], { restaurant, now: new Date(order.createdAt) }),
      48,
    );
    expect(lines).toContain("2 x Chicken Biryani                       $25.00");
    expect(lines).toContain("Tax                                        $2.88");
    expect(lines).toContain("Total                                     $35.38");
    expect(lines.some((l) => l.includes("Thank you!"))).toBe(true);
  });

  it("leaves voided dishes off, shows comped ones free, and lists the discount", () => {
    // One biryani voided, the lassi comped, $2 off: 12.50 - 2 = 10.50.
    const adjusted: PrintOrder = {
      ...order,
      discountTotal: 22,
      orderDiscount: 2,
      tax: 0.93,
      total: 11.43,
      items: [
        { ...order.items[0], voided: 1 },
        { ...order.items[1], comped: 1 },
      ],
    };
    const lines = docToText(
      billDoc([adjusted], { restaurant, now: new Date(order.createdAt) }),
      48,
    );
    const row = (left: string, right: string) =>
      lines.some((l) => l.startsWith(left) && l.endsWith(right));
    expect(row("1 x Chicken Biryani", "$12.50")).toBe(true);
    expect(row("1 x Mango Lassi (comped)", "$0.00")).toBe(true);
    expect(row("Subtotal", "$12.50")).toBe(true);
    expect(row("Discount", "-$2.00")).toBe(true);
    expect(row("Total", "$11.43")).toBe(true);
    expect(
      docToText(kitchenTicketDoc(adjusted, { restaurant })!, 42),
    ).toContain("1 x Chicken Biryani");
  });

  it("prints what one guest paid for when the bill was split", () => {
    const doc = partReceiptDoc(
      [{ label: "Share 1 of 3", amount: 11.8 }],
      {
        method: "cash",
        cardPresent: false,
        amount: 11.8,
        tip: 2,
        currency: "USD",
        paidAt: "2026-10-22T23:45:00Z",
      },
      { restaurant, openDrawer: true },
    );
    const lines = docToText(doc, 48);
    const row = (left: string, right: string) =>
      lines.some((l) => l.startsWith(left) && l.endsWith(right));
    expect(doc.openDrawer).toBe(true);
    expect(lines.some((l) => l.includes("Part of the bill"))).toBe(true);
    expect(row("Share 1 of 3", "$11.80")).toBe(true);
    expect(row("Paid · Cash", "$13.80")).toBe(true);
  });

  it("prints a receipt with the tip and how it was paid, opening the drawer for cash", () => {
    const doc = receiptDoc(
      [order],
      {
        method: "cash",
        cardPresent: false,
        amount: 35.38,
        tip: 5,
        currency: "USD",
        paidAt: "2026-10-22T23:45:00Z",
      },
      { restaurant, openDrawer: true },
    );
    const lines = docToText(doc, 48);
    expect(doc.openDrawer).toBe(true);
    expect(lines.some((l) => l.includes("RECEIPT"))).toBe(true);
    expect(lines.some((l) => l.includes("#42 · Oct 22, 2026 7:45 PM"))).toBe(
      true,
    );
    expect(lines).toContain("Tip                                        $5.00");
    expect(lines).toContain("Paid · Cash                               $40.38");
  });

  it("prints a test page naming the printer", () => {
    const lines = docToText(
      testDoc({
        restaurant,
        printerName: "Pass",
        role: "kitchen",
        now: new Date(order.createdAt),
      }),
      48,
    );
    expect(lines).toContain("Printer                                     Pass");
    expect(lines).toContain("Prints                           Kitchen tickets");
  });
});
