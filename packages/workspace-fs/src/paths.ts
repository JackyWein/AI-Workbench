import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export class PathBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathBoundaryError";
  }
}

/**
 * Keeps a path inside a permitted root (spec §25). Returns the resolved path or
 * throws; callers must never pass user input straight to the filesystem.
 *
 * This is a lexical check. Use `resolveRealPathInsideRoot` whenever the path is
 * about to be opened, because a symbolic link can point outside the root while
 * looking perfectly innocent here.
 */
export function resolveInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);

  if (!isInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw new PathBoundaryError(`Path "${candidate}" is outside the permitted root`);
  }
  return resolvedCandidate;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "") {
    return true;
  }
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/**
 * Resolves a path and then verifies where it really points, so a symbolic link
 * cannot be used to read or write outside the workspace.
 */
export async function resolveRealPathInsideRoot(
  root: string,
  candidate: string,
): Promise<string> {
  const target = resolveInsideRoot(root, candidate);

  const realRoot = await realpath(resolve(root));
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    // The path does not exist yet; the lexical check above is all there is.
    return target;
  }

  if (!isInsideRoot(realRoot, realTarget)) {
    throw new PathBoundaryError(
      `Path "${candidate}" resolves outside the permitted root`,
    );
  }
  return realTarget;
}

/** Path of `target` relative to `root`, always with forward slashes. */
export function toRelativePath(root: string, target: string): string {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath.split(sep).join("/");
}

/**
 * The same boundary rules for a root on another machine (spec §25).
 *
 * Remote paths are POSIX whatever this computer runs, so they must not go
 * through `node:path`, whose Windows implementation would read "/srv/app" as a
 * drive-relative path and "C:/x" as absolute. These work on POSIX semantics
 * only, and take the real path as an argument because resolving a symbolic
 * link means asking the other machine.
 */
export function resolvePosixInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = posix.resolve("/", root);
  const resolvedCandidate = posix.isAbsolute(candidate)
    ? posix.resolve("/", candidate)
    : posix.resolve(resolvedRoot, candidate);

  if (!isInsidePosixRoot(resolvedRoot, resolvedCandidate)) {
    throw new PathBoundaryError(`Path "${candidate}" is outside the permitted root`);
  }
  return resolvedCandidate;
}

export function isInsidePosixRoot(root: string, candidate: string): boolean {
  const relativePath = posix.relative(posix.resolve("/", root), posix.resolve("/", candidate));
  if (relativePath === "") {
    return true;
  }
  return !relativePath.startsWith("..") && !posix.isAbsolute(relativePath);
}

/** Path of `target` relative to `root`, for two POSIX paths. */
export function toPosixRelativePath(root: string, target: string): string {
  return posix.relative(posix.resolve("/", root), posix.resolve("/", target));
}
