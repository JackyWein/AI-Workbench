export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface GitFileChange {
  /** Path relative to the repository root, with forward slashes. */
  readonly path: string;
  readonly kind: GitChangeKind;
  /** True when the change is in the index, false when only in the worktree. */
  readonly staged: boolean;
  /** Previous path for a rename or copy. */
  readonly previousPath?: string;
}

export interface GitStatus {
  readonly isRepository: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly changes: GitFileChange[];
  readonly clean: boolean;
}

export const notARepository: GitStatus = {
  isRepository: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  changes: [],
  clean: true,
};

/**
 * Parses `git status --porcelain=v2 --branch`.
 *
 * Version 2 of the format is used because it reports the branch, the upstream
 * and the ahead/behind counts in the same call, and its field layout is stable
 * across git versions.
 */
export function parseStatus(output: string): GitStatus {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: GitFileChange[] = [];

  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        detached = true;
      } else {
        branch = value;
      }
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /\+(-?\d+)\s+-(-?\d+)/.exec(line);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    const change = parseEntry(line);
    if (change) {
      changes.push(change);
    }
  }

  return {
    isRepository: true,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    changes,
    clean: changes.length === 0,
  };
}

function parseEntry(line: string): GitFileChange | null {
  const type = line[0];

  // "? <path>" — untracked
  if (type === "?") {
    return { path: unquote(line.slice(2)), kind: "untracked", staged: false };
  }
  // "! <path>" — ignored, not shown
  if (type === "!") {
    return null;
  }
  // "u <XY> ..." — unmerged
  if (type === "u") {
    const path = line.split(" ").slice(10).join(" ");
    return { path: unquote(path), kind: "conflicted", staged: false };
  }

  // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
  if (type === "1") {
    const fields = line.split(" ");
    const xy = fields[1] ?? "..";
    const path = fields.slice(8).join(" ");
    return buildChange(xy, unquote(path));
  }

  // "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>\t<origPath>"
  if (type === "2") {
    const fields = line.split(" ");
    const xy = fields[1] ?? "..";
    const rest = fields.slice(9).join(" ");
    const [path, previousPath] = rest.split("\t");
    const change = buildChange(xy, unquote(path ?? ""));
    return previousPath
      ? { ...change, previousPath: unquote(previousPath) }
      : change;
  }

  return null;
}

function buildChange(xy: string, path: string): GitFileChange {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  // The index column wins: a staged change is what would be committed.
  const staged = index !== ".";
  const code = staged ? index : worktree;

  return { path, kind: kindOf(code), staged };
}

function kindOf(code: string): GitChangeKind {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/** git quotes paths containing unusual characters in C style. */
function unquote(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  return trimmed
    .slice(1, -1)
    .replace(/\\([\\"])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}
