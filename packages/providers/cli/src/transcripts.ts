import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SessionTranscript } from "@ai-workbench/provider-base";

/**
 * A tool's session id as it may appear in a file name. Anything else — a
 * separator, "..", an empty id — is never looked up, so an id can never
 * point outside the home.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * The files and folders of one conversation in a configuration home, found by
 * the profile's patterns ("projects/*\/{session}.jsonl"): `*` stands for any
 * one folder, `{session}` for the session id.
 */
export async function findTranscript(
  family: string,
  home: string,
  patterns: readonly string[],
  providerSessionId: string,
): Promise<SessionTranscript | null> {
  if (patterns.length === 0 || !SAFE_SESSION_ID.test(providerSessionId) || providerSessionId.includes("..")) {
    return null;
  }
  const entries: { source: string; relative: string }[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const relative of await matchInHome(home, pattern.replaceAll("{session}", providerSessionId))) {
      if (!seen.has(relative)) {
        seen.add(relative);
        entries.push({ source: join(home, relative), relative });
      }
    }
  }
  return entries.length > 0 ? { family, providerSessionId, entries } : null;
}

/**
 * Copies another account's conversation into this home at the same places,
 * leaving whatever is already there. Refuses another tool's transcript and
 * any entry that would land outside the home.
 */
export async function adoptTranscript(
  family: string,
  home: string,
  transcript: SessionTranscript,
): Promise<boolean> {
  if (transcript.family !== family || transcript.entries.length === 0) {
    return false;
  }
  const root = resolve(home);
  const targets = transcript.entries.map((entry) => ({
    source: resolve(entry.source),
    target: resolve(root, entry.relative),
  }));
  if (targets.some(({ target }) => !target.startsWith(`${root}${sep}`))) {
    return false;
  }
  for (const { source, target } of targets) {
    if (source === target) {
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: false });
  }
  return true;
}

async function matchInHome(home: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    return [];
  }
  let found = [""];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of found) {
      if (segment === "*") {
        for (const name of await folders(join(home, base))) {
          next.push(base ? `${base}/${name}` : name);
        }
      } else {
        const candidate = base ? `${base}/${segment}` : segment;
        if (existsSync(join(home, candidate))) {
          next.push(candidate);
        }
      }
    }
    found = next;
  }
  return found.filter((entry) => entry.length > 0);
}

async function folders(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
