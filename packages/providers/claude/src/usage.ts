import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CliExtensionContext } from "@ai-workbench/provider-cli";
import type { ProviderUsageSnapshot, UsageLimit } from "@ai-workbench/shared";
import { configHomeOf, TranscriptTokens } from "./telemetry.js";

/**
 * Token totals read from Claude Code's own session transcripts on this
 * machine, without spending a turn (spec §55, §56).
 *
 * Headless turns only report usage while they run, so before the first turn
 * in the application there would be nothing to show — even when the person
 * has used the tool for months outside it. The transcripts are the tool's own
 * record of that work: one JSON line per message, each assistant message
 * carrying the token counts the API returned. Their sum is shown as amounts
 * used, never as remaining quota, which the transcripts do not know.
 */

const PROJECTS_DIR = "projects";
/** The most transcript files one reading opens; transcripts can be many. */
const MAX_FILES = 20;
/** A transcript larger than this is skipped rather than read in full. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface TranscriptFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Sums the token counts of the most recent local transcripts. Returns null
 * when there are none to read, so the caller stays honestly unavailable
 * rather than guessing. Never throws.
 */
export async function readTranscriptUsage(
  configHome: string,
): Promise<{ tokens: { input: number; output: number }; updatedAt: Date } | null> {
  let files: TranscriptFile[];
  try {
    files = await recentTranscripts(join(configHome, PROJECTS_DIR));
  } catch {
    return null;
  }
  if (files.length === 0) {
    return null;
  }
  let input = 0;
  let output = 0;
  let updatedAt: Date | null = null;
  for (const file of files) {
    try {
      const fileStat = await stat(file.path);
      if (fileStat.size > MAX_FILE_BYTES) {
        continue;
      }
      const tokens = await new TranscriptTokens(file.path).read();
      if (!tokens) {
        continue;
      }
      input += tokens.input;
      output += tokens.output;
      const mtime = new Date(fileStat.mtimeMs);
      if (!updatedAt || mtime.getTime() > updatedAt.getTime()) {
        updatedAt = mtime;
      }
    } catch {
      // One unreadable transcript hides nothing; the rest still count.
    }
  }
  if (!updatedAt || (input === 0 && output === 0)) {
    return null;
  }
  return { tokens: { input, output }, updatedAt };
}

/** The most recently changed transcript files, newest first. */
async function recentTranscripts(projects: string): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const entries = await readdir(projects, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(projects, entry.name);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const path = join(directory, name);
      try {
        const fileStat = await stat(path);
        found.push({ path, mtimeMs: fileStat.mtimeMs });
      } catch {
        // Gone already; not ours to worry about.
      }
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);
}

/** Account usage from the local transcripts, or null when there are none. */
export async function readUsage(
  context: CliExtensionContext,
): Promise<ProviderUsageSnapshot | null> {
  const totals = await readTranscriptUsage(configHomeOf(context));
  if (!totals) {
    return null;
  }
  const limits: UsageLimit[] = [
    {
      id: "transcripts.tokens",
      label: "Tokens used",
      used: totals.tokens.input + totals.tokens.output,
      unit: "tokens",
    },
  ];
  return {
    providerId: context.providerId,
    state: "available",
    limits,
    updatedAt: totals.updatedAt,
    source: "cli",
    note: "Sum of this machine's Claude Code session transcripts; the account's current limits are reported while the tool works.",
  };
}
