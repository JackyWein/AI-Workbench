import type { TeamArtifact } from "@ai-workbench/shared";

export type ArtifactViewKind = "diff" | "code" | "other";
export type DiffLineKind = "add" | "del" | "hunk" | "file" | "ctx";

/** Lines shown before the viewer folds the rest behind "Show all". */
export const ARTIFACT_PREVIEW_LINES = 120;
/** Hard cap so one huge artifact cannot bury the timeline. */
export const ARTIFACT_MAX_LINES = 400;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  cpp: "cpp",
  c: "c",
  h: "c",
  css: "css",
  html: "html",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

/**
 * Code/diff artifacts get a visual viewer; everything else keeps the plain
 * markdown rendering. A diff is either declared (`type: "diff"`) or looks
 * like a unified diff. Content is the only source — nothing is guessed.
 */
export function classifyArtifact(artifact: Pick<TeamArtifact, "type" | "content">): ArtifactViewKind {
  const declared = artifact.type.trim().toLowerCase();
  if (declared === "diff" || declared === "patch") {
    return "diff";
  }
  if (declared === "code") {
    return looksLikeDiff(artifact.content) ? "diff" : "code";
  }
  if (looksLikeDiff(artifact.content)) {
    return "diff";
  }
  return "other";
}

function looksLikeDiff(content: string | null): boolean {
  if (!content) {
    return false;
  }
  let markers = 0;
  for (const line of content.split("\n")) {
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@ ") ||
      line.startsWith("diff --git ")
    ) {
      markers += 1;
      if (markers >= 2) {
        return true;
      }
    }
  }
  return false;
}

/** One diff line, classified the same way as the Changes view. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  // Where one file's changes begin, so a diff of several files reads as such.
  if (line.startsWith("diff --git ")) {
    return "file";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "del";
  }
  return "ctx";
}

/** Added/removed line counts for the header pill; hunk/file headers excluded. */
export function diffStats(content: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of content.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "add") {
      added += 1;
    } else if (kind === "del") {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * The "why" behind an artifact, when the agent gave one. Reads the optional
 * metadata fields agents may attach; null when there is nothing — the UI
 * then shows no reason rather than inventing one.
 */
export function artifactReason(metadata: TeamArtifact["metadata"]): string | null {
  for (const key of ["reason", "summary", "description", "why"]) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Language label for the code header: explicit metadata wins, then extension. */
export function artifactLanguage(artifact: Pick<TeamArtifact, "path" | "metadata">): string {
  const fromMetadata = (artifact.metadata as Record<string, unknown>)["language"];
  if (typeof fromMetadata === "string" && fromMetadata.trim().length > 0) {
    return fromMetadata.trim().toLowerCase();
  }
  const path = artifact.path ?? "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGE[ext] ?? "";
}

/**
 * Agents often publish code wrapped in a single markdown fence; the viewer
 * wants the raw code with line numbers, so unwrap one outer fence pair.
 */
export function extractCodeContent(content: string): string {
  const match = content.match(/^```[\w+-]*\n([\s\S]*?)\n```\s*$/);
  return match?.[1] ?? content;
}
