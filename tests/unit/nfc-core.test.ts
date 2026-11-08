import { describe, expect, it } from "vitest";
import {
  canWriteNfc,
  needsBiggerTag,
  nfcErrorMessage,
  tableTagMessage,
} from "@/lib/nfc/core";

describe("NFC table tags", () => {
  it("writes exactly the table's link, as one URL record", () => {
    const url =
      "https://tableside.menu/r/lantern-table-demo/table/eed3cefc-5124-45da-815e-c406fca42ce0";
    expect(tableTagMessage(url)).toEqual({
      records: [{ recordType: "url", data: url }],
    });
  });

  it("knows which browsers can write", () => {
    expect(canWriteNfc({ NDEFReader: class {} })).toBe(true);
    expect(canWriteNfc({})).toBe(false);
    expect(canWriteNfc(undefined)).toBe(false);
  });

  it("says when a link is too long for the common sticker", () => {
    expect(
      needsBiggerTag(
        "https://tableside.menu/r/lantern-table-demo/table/eed3cefc-5124-45da-815e-c406fca42ce0",
      ),
    ).toBe(false);
    expect(
      needsBiggerTag(
        `https://tableside.menu/r/${"a".repeat(80)}/table/eed3cefc-5124-45da-815e-c406fca42ce0`,
      ),
    ).toBe(true);
  });

  it("turns Web NFC errors into something to do", () => {
    expect(nfcErrorMessage("NotAllowedError")).toMatch(/NFC is on/);
    expect(nfcErrorMessage("NotSupportedError")).toMatch(/locked/);
    expect(nfcErrorMessage("NetworkError")).toMatch(/Hold it still/);
    expect(nfcErrorMessage(undefined)).toMatch(/try again/);
  });
});
