import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * node-pty spawns every shell through a small `spawn-helper` binary, but ships
 * it in its prebuilds without the executable bit. Without this, opening a
 * terminal fails with "posix_spawnp failed" on macOS and Linux — in the
 * packaged application as much as in a checkout, because the file is copied
 * with whatever mode it has.
 *
 * Runs after install; the executable-bit fix is a no-op on Windows and once
 * the bit is set. On Windows, node-pty 1.1.0 also needs its ConPTY fallback
 * fixed before any terminal is started.
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

async function avoidStaleWindowsPid(directory) {
  const agentPath = join(directory, "lib", "windowsPtyAgent.js");
  const helperPath = join(directory, "lib", "conpty_console_list_agent.js");
  let agent;
  let helper;
  try {
    [agent, helper] = await Promise.all([readFile(agentPath, "utf8"), readFile(helperPath, "utf8")]);
  } catch {
    return false;
  }
  // When AttachConsole loses the race with ConPTY teardown, the helper cannot
  // report a process list. node-pty's old timeout guesses the original shell
  // PID five seconds later; Windows may already have reused that PID for a
  // completely unrelated process. An empty list is the only safe fallback.
  const unsafeFallback = "resolve([_this._innerPid]);";
  const safeFallback = "resolve([]);";
  if (!agent.includes(unsafeFallback) && !agent.includes(safeFallback)) {
    throw new Error(`Unknown node-pty ConPTY fallback in ${agentPath}`);
  }
  const unsafeHelper = "var consoleProcessList = getConsoleProcessList(shellPid);";
  const safeHelper = "var consoleProcessList;\ntry {\n    consoleProcessList = getConsoleProcessList(shellPid);\n}\ncatch {\n    consoleProcessList = [];\n}";
  if (!helper.includes(unsafeHelper) && !helper.includes(safeHelper)) {
    throw new Error(`Unknown node-pty ConPTY helper in ${helperPath}`);
  }
  const nextAgent = agent.replace(unsafeFallback, safeFallback);
  const nextHelper = helper.replace(unsafeHelper, safeHelper);
  if (nextAgent !== agent) await writeFile(agentPath, nextAgent, "utf8");
  if (nextHelper !== helper) await writeFile(helperPath, nextHelper, "utf8");
  return nextAgent !== agent || nextHelper !== helper;
}

let fixed = 0;
let patched = 0;
for await (const directory of nodePtyDirectories(join(root, "node_modules"))) {
  if (process.platform === "win32") {
    if (await avoidStaleWindowsPid(directory)) patched += 1;
    continue;
  }
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
if (patched > 0) {
  process.stdout.write(`Protected ${patched} node-pty ConPTY copies from stale PIDs.\n`);
}
