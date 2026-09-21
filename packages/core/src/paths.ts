import { isAbsolute, relative, resolve } from "node:path";

export class PathBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathBoundaryError";
  }
}

/**
 * Keeps a session inside its workspace (spec §25). Returns the resolved path or
 * throws; callers must never pass user input straight to the filesystem.
 */
export function resolveInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);

  if (!isInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw new PathBoundaryError(
      `Path "${candidate}" is outside the permitted root`,
    );
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
