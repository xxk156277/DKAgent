import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TapApp } from "../../src/web/app/TapApp.js";

describe("TapApp", () => {
  it("renders Turn list, node detail and node navigation", () => {
    render(<TapApp />);

    expect(screen.getByRole("heading", { name: "对话轮次" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "节点详情" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "节点导航" })).toBeVisible();
  });
});
