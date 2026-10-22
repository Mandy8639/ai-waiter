// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_IMAGE_CAPTION_FULL,
  AI_IMAGE_CAPTION_SHORT,
  DishPhoto,
} from "@/components/customer/dish-photo";

/**
 * The sentence under an AI-generated dish image (2026-10-22): the full one
 * on the dish page, a short line on a menu card, nothing on a real photo.
 */
afterEach(cleanup);

const image = (aiGenerated: boolean) => ({
  src: "https://cdn.example/x.webp",
  srcSet: "",
  aiGenerated,
  unverified: false,
});

describe("DishPhoto caption", () => {
  it("explains an AI image on the dish page", () => {
    render(
      <DishPhoto
        image={image(true)}
        alt="Chicken 65"
        sizes="100vw"
        caption="full"
      />,
    );
    expect(screen.getByText(AI_IMAGE_CAPTION_FULL)).toBeInTheDocument();
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
  });

  it("uses the short line on a menu card", () => {
    render(
      <DishPhoto
        image={image(true)}
        alt="Chicken 65"
        sizes="96px"
        caption="short"
      />,
    );
    expect(screen.getByText(AI_IMAGE_CAPTION_SHORT)).toBeInTheDocument();
    expect(screen.queryByText(AI_IMAGE_CAPTION_FULL)).not.toBeInTheDocument();
  });

  it("says nothing under a restaurant's real photo", () => {
    render(
      <DishPhoto
        image={image(false)}
        alt="Chicken 65"
        sizes="100vw"
        caption="full"
      />,
    );
    expect(screen.queryByText(AI_IMAGE_CAPTION_FULL)).not.toBeInTheDocument();
    expect(screen.queryByText("AI-generated")).not.toBeInTheDocument();
  });

  it("keeps small chat cards to the label alone", () => {
    render(<DishPhoto image={image(true)} alt="Chicken 65" sizes="64px" />);
    expect(screen.queryByRole("figure")).not.toBeInTheDocument();
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
  });
});
