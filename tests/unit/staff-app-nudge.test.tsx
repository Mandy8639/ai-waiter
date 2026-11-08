// @vitest-environment jsdom
//
// The dashboard's "get the app" nudge: shown until "Not now", which hides
// it on this device for 30 days.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StaffAppNudge } from "@/components/dashboard/staff-app-nudge";
import { STAFF_APP_SNOOZE_MS } from "@/lib/staff-app/core";

const KEY = "tableside:staff-app-nudge-dismissed";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function renderNudge() {
  await act(async () => {
    render(
      <StaffAppNudge
        title="Get new orders on your phone."
        body="Sign in with this same account."
        qrDataUrl="data:image/png;base64,AAAA"
      />,
    );
  });
}

describe("StaffAppNudge", () => {
  it("shows the pitch, a code to scan and both badges", async () => {
    await renderNudge();
    expect(
      screen.getByText("Get new orders on your phone."),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("QR code for tableside.menu/get-app"),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("Download on the App Store"),
    ).toBeInTheDocument();
    expect(screen.getByAltText("Get it on Google Play")).toBeInTheDocument();
  });

  it("goes away on Not now, and stays away for 30 days", async () => {
    await renderNudge();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Get new orders on your phone.")).toBeNull();
    expect(Number(localStorage.getItem(KEY))).toBeGreaterThan(0);

    cleanup();
    await renderNudge();
    expect(screen.queryByText("Get new orders on your phone.")).toBeNull();
  });

  it("comes back after 30 days", async () => {
    localStorage.setItem(KEY, String(Date.now() - STAFF_APP_SNOOZE_MS - 1000));
    await renderNudge();
    expect(
      screen.getByText("Get new orders on your phone."),
    ).toBeInTheDocument();
  });
});
