import { chmod, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * node-pty spawns every shell through a small `spawn-helper` binary, but ships
 * it in its prebuilds without the executable bit. Without this, opening a
 * terminal fails with "posix_spawnp failed" on macOS and Linux — in the
 * packaged application as much as in a checkout, because the file is copied
 * with whatever mode it has.
 *
 * Runs after install; a no-op on Windows and once the bit is set.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

/** Every node-pty copy in the workspace, however the package manager laid it out. */
async function* nodePtyDirectories(directory, depth = 0) {
  if (depth > 6) {
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const path = join(directory, entry.name);
    if (entry.name === "node-pty") {
      yield path;
    } else if (entry.name === "node_modules" || entry.name === ".pnpm") {
      yield* nodePtyDirectories(path, depth + 1);
    } else if (entry.name.startsWith("node-pty@")) {
      yield* nodePtyDirectories(path, depth + 1);
    }
  }
}

async function makeExecutable(path) {
  try {
    const stats = await stat(path);
    if ((stats.mode & 0o111) !== 0) {
      return false;
    }
    await chmod(path, 0o755);
    return true;
  } catch {
    // The helper is absent on platforms that do not use one.
    return false;
  }
}

if (process.platform === "win32") {
  process.exit(0);
}

let fixed = 0;
for await (const directory of nodePtyDirectories(join(root, "node_modules"))) {
  if (await makeExecutable(join(directory, "build", "Release", "spawn-helper"))) {
    fixed += 1;
  }
  let prebuilds = [];
  try {
    prebuilds = await readdir(join(directory, "prebuilds"));
  } catch {
    prebuilds = [];
  }
  for (const target of prebuilds) {
    if (await makeExecutable(join(directory, "prebuilds", target, "spawn-helper"))) {
      fixed += 1;
    }
  }
}

if (fixed > 0) {
  process.stdout.write(`Made ${fixed} node-pty spawn-helper binaries executable.\n`);
}
