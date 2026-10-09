// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChefArt } from "@/components/customer/chef-art";

afterEach(cleanup);

describe("ChefArt", () => {
  it("is decorative: hidden from assistive tech, with an empty alt", () => {
    const { container } = render(<ChefArt pose="hello" size={40} />);
    const wrapper = container.firstElementChild!;
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("crops a bust into a square box of the asked size", () => {
    const { container } = render(<ChefArt pose="neutral" size={28} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe("28px");
    expect(wrapper.style.height).toBe("28px");
    expect(wrapper).toHaveAttribute("data-chef-pose", "neutral");
  });

  it("shows a full figure at the asked height, in proportion", () => {
    const { container } = render(
      <ChefArt pose="thinking" size={80} crop="full" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.height).toBe("80px");
    // thinking.png is 184×257.
    expect(wrapper.style.width).toBe(`${Math.round((80 * 184) / 257)}px`);
  });

  it("adds a motion class only when asked", () => {
    const still = render(<ChefArt pose="found" size={44} />);
    expect(still.container.querySelector("img")!.className).not.toMatch(
      /chef-motion/,
    );
    cleanup();
    const nodding = render(<ChefArt pose="found" size={44} motion="nod" />);
    expect(nodding.container.querySelector("img")!.className).toMatch(
      /chef-motion-nod/,
    );
  });
});
