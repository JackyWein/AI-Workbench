import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";

const workspace = {
  id: "ws1",
  name: "Demo",
  path: "/tmp/demo",
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("EventBus", () => {
  it("delivers to global and typed subscribers", () => {
    const bus = new EventBus();
    const all = vi.fn();
    const typed = vi.fn();

    bus.subscribe(all);
    bus.on("workspace.created", typed);
    bus.publish({ type: "workspace.created", workspace });

    expect(all).toHaveBeenCalledTimes(1);
    expect(typed).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);

    unsubscribe();
    bus.publish({ type: "workspace.created", workspace });

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the others", () => {
    const bus = new EventBus();
    const healthy = vi.fn();

    bus.subscribe(() => {
      throw new Error("subscriber failed");
    });
    bus.subscribe(healthy);

    expect(() => bus.publish({ type: "workspace.created", workspace })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
