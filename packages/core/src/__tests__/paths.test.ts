import { describe, expect, it } from "vitest";
import { PathBoundaryError, isInsideRoot, resolveInsideRoot } from "../paths.js";

describe("path boundaries", () => {
  it("accepts the root itself and its children", () => {
    expect(resolveInsideRoot("/home/project", "/home/project")).toBe("/home/project");
    expect(resolveInsideRoot("/home/project", "src")).toBe("/home/project/src");
    expect(resolveInsideRoot("/home/project", "/home/project/src/app")).toBe(
      "/home/project/src/app",
    );
  });

  it("rejects traversal out of the root", () => {
    expect(() => resolveInsideRoot("/home/project", "../secrets")).toThrow(
      PathBoundaryError,
    );
    expect(() => resolveInsideRoot("/home/project", "/etc/passwd")).toThrow(
      PathBoundaryError,
    );
    expect(() => resolveInsideRoot("/home/project", "src/../../other")).toThrow(
      PathBoundaryError,
    );
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isInsideRoot("/home/project", "/home/project-2")).toBe(false);
  });
});
