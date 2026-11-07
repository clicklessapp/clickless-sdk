// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Adaptive, AdaptiveRegion, PromptPanel, propPresets, useAdaptiveAction, useAdaptiveRegion } from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SectionCount() {
  const { manifest } = useAdaptiveRegion("tasks");
  return <span>sections:{manifest?.components.length ?? "none"}</span>;
}

function TasksPage() {
  useAdaptiveAction({
    name: "completeTask",
    title: "Mark a task done",
    mode: "write",
    run: () => "done",
  });
  return (
    <AdaptiveRegion id="tasks" version="1">
      <Adaptive
        id="board"
        kind="table"
        presets={{ view: propPresets.choice({ values: ["board", "list"], initial: "board", means: "how tasks are shown" }) }}
        defaults={{ w: 12, h: 4 }}
      >
        {(props, adaptiveControls) => (
          <>
            <span>view:{String(props.view)}</span>
            <button onClick={() => void adaptiveControls.setProp("view", "list")}>show as list</button>
            <SectionCount />
          </>
        )}
      </Adaptive>
      <Adaptive id="archive" kind="list" defaults={{ w: 12, h: 2, hidden: true }}>
        <span>archive body</span>
      </Adaptive>
    </AdaptiveRegion>
  );
}

describe("outside AdaptiveProvider", () => {
  it("shows the application's own components with their defaults", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<TasksPage />);

    expect(screen.getByText("view:board")).toBeTruthy();
    expect(screen.queryByText("archive body")).toBeNull();
  });

  it("says so in the console once, however many regions are drawn", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const freshSdk = await import("../src/index");
    const Region = () => (
      <freshSdk.AdaptiveRegion id="tasks" version="1">
        <freshSdk.Adaptive id="board" defaults={{ w: 12, h: 4 }}>
          <span>board</span>
        </freshSdk.Adaptive>
      </freshSdk.AdaptiveRegion>
    );
    render(<Region />);
    render(<Region />);

    expect(warn.mock.calls.filter(([message]) => String(message).includes("<AdaptiveProvider>"))).toHaveLength(1);
  });

  it("lets useAdaptiveRegion inside the region read the region on screen", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<TasksPage />);

    expect(screen.getByText("sections:2")).toBeTruthy();
  });

  it("keeps a change in memory, and the next render starts from the defaults again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<TasksPage />);
    await act(async () => screen.getByText("show as list").click());
    expect(screen.getByText("view:list")).toBeTruthy();

    cleanup();
    render(<TasksPage />);
    expect(screen.getByText("view:board")).toBeTruthy();
  });

  it("still asks for the provider around a prompt panel, which has nothing to offer without it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<PromptPanel regionId="tasks" />)).toThrow(
      "ClickLess components must be rendered inside <AdaptiveProvider>",
    );
  });
});
