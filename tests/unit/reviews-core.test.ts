import { describe, expect, it } from "vitest";
import {
  parseGoogleReviewUrl,
  showStandaloneReviewLink,
} from "@/lib/reviews/core";

describe("parseGoogleReviewUrl", () => {
  it.each([
    [
      "https://g.page/r/CabcDEF123/review",
      "https://g.page/r/CabcDEF123/review",
    ],
    ["g.page/r/CabcDEF123/review", "https://g.page/r/CabcDEF123/review"],
    ["http://g.page/r/X/review", "https://g.page/r/X/review"],
    [
      "https://search.google.com/local/writereview?placeid=ChIJ123",
      "https://search.google.com/local/writereview?placeid=ChIJ123",
    ],
    ["https://maps.app.goo.gl/AbC123", "https://maps.app.goo.gl/AbC123"],
    [
      "  https://www.google.com/maps/place/x  ",
      "https://www.google.com/maps/place/x",
    ],
  ])("accepts %s", (input, expected) => {
    expect(parseGoogleReviewUrl(input)).toEqual({ ok: true, url: expected });
  });

  it("treats blank as turning it off", () => {
    expect(parseGoogleReviewUrl("   ")).toEqual({ ok: true, url: null });
  });

  it.each([
    "https://yelp.com/biz/x",
    "https://g.page.evil.com/r/x",
    "https://google.com.evil.com/x",
    "https://goo.gl/abc",
    "javascript:alert(1)",
    "ftp://g.page/r/x",
    "not a link at all",
  ])("refuses %s", (input) => {
    expect(parseGoogleReviewUrl(input).ok).toBe(false);
  });

  it("refuses a link that's too long", () => {
    const long = `https://g.page/r/${"a".repeat(600)}`;
    expect(parseGoogleReviewUrl(long).ok).toBe(false);
  });
});

describe("showStandaloneReviewLink", () => {
  it("shows once served when the feedback panel isn't there", () => {
    expect(
      showStandaloneReviewLink({
        hasLink: true,
        status: "served",
        feedbackPanelShown: false,
      }),
    ).toBe(true);
  });

  it("stays hidden before the food arrives, without a link, or beside the panel", () => {
    expect(
      showStandaloneReviewLink({
        hasLink: true,
        status: "preparing",
        feedbackPanelShown: false,
      }),
    ).toBe(false);
    expect(
      showStandaloneReviewLink({
        hasLink: false,
        status: "served",
        feedbackPanelShown: false,
      }),
    ).toBe(false);
    expect(
      showStandaloneReviewLink({
        hasLink: true,
        status: "served",
        feedbackPanelShown: true,
      }),
    ).toBe(false);
  });
});
