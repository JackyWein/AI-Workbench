import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { LocalWorkspaceFileSystem } from "../file-system.js";
import {
  PathBoundaryError,
  isInsideRoot,
  resolveInsideRoot,
  resolveRealPathInsideRoot,
  toRelativePath,
} from "../paths.js";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

describe("path boundaries", () => {
  // Built through resolve() so the expectations hold on Windows too.
  const root = resolve(join(tmpdir(), "workbench-root"));
  const outside = resolve(join(tmpdir(), "workbench-root-2"));

  it("accepts the root itself and its children", () => {
    expect(resolveInsideRoot(root, root)).toBe(root);
    expect(resolveInsideRoot(root, "src")).toBe(join(root, "src"));
  });

  it("rejects traversal out of the root", () => {
    expect(() => resolveInsideRoot(root, "../secrets")).toThrow(PathBoundaryError);
    expect(() => resolveInsideRoot(root, join(outside, "secret"))).toThrow(
      PathBoundaryError,
    );
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isInsideRoot(root, outside)).toBe(false);
  });

  it("normalizes a relative path to forward slashes", () => {
    expect(toRelativePath(root, join(root, "src", "app.ts"))).toBe("src/app.ts");
  });
});

// Creating file symbolic links on Windows needs privileges a CI runner does
// not have; the boundary logic itself is covered by the checks above.
describe.skipIf(process.platform === "win32")("symbolic links", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await makeTempDirectory("ai-workbench-fs-");
    outside = await makeTempDirectory("ai-workbench-out-");
  });

  afterEach(async () => {
    await removeTempDirectory(root);
    await removeTempDirectory(outside);
  });

  it("refuses a link that points outside the root", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    // The lexical check passes, which is exactly why the real path matters.
    expect(() => resolveInsideRoot(root, "link.txt")).not.toThrow();
    await expect(resolveRealPathInsideRoot(root, "link.txt")).rejects.toThrow(
      PathBoundaryError,
    );

    const fs = new LocalWorkspaceFileSystem({ logger: nullLogger });
    await expect(fs.readText(root, "link.txt")).rejects.toThrow(PathBoundaryError);
  });

  it("allows a link that stays inside the root", async () => {
    await writeFile(join(root, "real.txt"), "fine");
    await symlink(join(root, "real.txt"), join(root, "alias.txt"));

    const fs = new LocalWorkspaceFileSystem({ logger: nullLogger });
    expect((await fs.readText(root, "alias.txt")).content).toBe("fine");
  });
});

describe("LocalWorkspaceFileSystem", () => {
  let root: string;
  let fs: LocalWorkspaceFileSystem;

  beforeEach(async () => {
    root = await makeTempDirectory("ai-workbench-fs-");
    fs = new LocalWorkspaceFileSystem({ logger: nullLogger, maxReadBytes: 64 });
  });

  afterEach(async () => {
    await removeTempDirectory(root);
  });

  it("lists directories before files, each sorted by name", async () => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");

    const entries = await fs.list(root);
    expect(entries.map((entry) => entry.name)).toEqual([
      "docs",
      "src",
      "a.txt",
      "b.txt",
    ]);
    expect(entries[0]?.kind).toBe("directory");
    expect(entries[2]?.path).toBe("a.txt");
  });

  it("skips noise directories and dotfiles, but keeps .gitignore", async () => {
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, ".gitignore"), "dist");

    const names = (await fs.list(root)).map((entry) => entry.name);
    expect(names).toEqual([".gitignore"]);
  });

  it("lists a subdirectory with paths relative to the root", async () => {
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(join(root, "src/nested/app.ts"), "export {};");

    const entries = await fs.list(root, "src/nested");
    expect(entries[0]?.path).toBe("src/nested/app.ts");
  });

  it("refuses to list outside the root", async () => {
    await expect(fs.list(root, "..")).rejects.toThrow(PathBoundaryError);
  });

  it("reads a text file and reports truncation", async () => {
    await writeFile(join(root, "short.txt"), "hello");
    const short = await fs.readText(root, "short.txt");
    expect(short.content).toBe("hello");
    expect(short.truncated).toBe(false);

    await writeFile(join(root, "long.txt"), "x".repeat(200));
    const long = await fs.readText(root, "long.txt");
    expect(long.content).toHaveLength(64);
    expect(long.truncated).toBe(true);
    expect(long.size).toBe(200);
  });

  it("refuses to return binary content as text", async () => {
    await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const result = await fs.readText(root, "image.bin");
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });

  it("reports whether a path exists without throwing", async () => {
    await writeFile(join(root, "there.txt"), "x");
    expect(await fs.exists(root, "there.txt")).toBe(true);
    expect(await fs.exists(root, "missing.txt")).toBe(false);
    await expect(fs.exists(root, "../escape")).rejects.toThrow(PathBoundaryError);
  });
});
