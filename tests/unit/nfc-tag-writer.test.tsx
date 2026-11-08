// @vitest-environment jsdom
//
// The NFC section of a table's QR page. A fake NDEFReader stands in for
// Chrome on Android: it records what would be written to the sticker.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NfcTagWriter } from "@/components/tables/nfc-tag-writer";

const URL_ =
  "https://tableside.menu/r/lantern-table-demo/table/eed3cefc-5124-45da-815e-c406fca42ce0";

const write = vi.fn(async () => undefined);
const makeReadOnly = vi.fn(async () => undefined);

function installReader() {
  (window as unknown as { NDEFReader: unknown }).NDEFReader = class {
    write = write;
    makeReadOnly = makeReadOnly;
  };
}

afterEach(() => {
  cleanup();
  write.mockReset();
  makeReadOnly.mockReset();
  delete (window as unknown as { NDEFReader?: unknown }).NDEFReader;
});

function renderWriter() {
  render(
    <NfcTagWriter
      url={URL_}
      tableLabel="Table 3"
      nextTableHref="/dashboard/tables/next/qr"
    />,
  );
}

describe("NfcTagWriter", () => {
  it("writes the table's link and locks the tag by default", async () => {
    installReader();
    renderWriter();
    expect(
      screen.getByRole("checkbox", { name: /Lock the tag/ }),
    ).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Write to tag/ }));
    });

    expect(write).toHaveBeenCalledWith(
      { records: [{ recordType: "url", data: URL_ }] },
      expect.objectContaining({ overwrite: true }),
    );
    expect(makeReadOnly).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/Tag written for Table 3 and locked/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next table" })).toHaveAttribute(
      "href",
      "/dashboard/tables/next/qr",
    );
  });

  it("leaves the tag unlocked when asked to", async () => {
    installReader();
    renderWriter();
    fireEvent.click(screen.getByRole("checkbox", { name: /Lock the tag/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Write to tag/ }));
    });
    expect(write).toHaveBeenCalled();
    expect(makeReadOnly).not.toHaveBeenCalled();
  });

  it("explains a failed write", async () => {
    installReader();
    write.mockRejectedValueOnce(
      Object.assign(new Error("moved"), { name: "NetworkError" }),
    );
    renderWriter();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Write to tag/ }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Hold it still/);
  });

  it("gives the app steps on a phone or computer that can't write", () => {
    renderWriter();
    expect(screen.queryByRole("button", { name: /Write to tag/ })).toBeNull();
    expect(screen.getAllByText(/NFC Tools/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Lock tag/)).toBeInTheDocument();
  });
});
