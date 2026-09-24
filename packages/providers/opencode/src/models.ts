import type { ModelInfo } from "@ai-workbench/shared";
import { field, numberField, stringField } from "@ai-workbench/provider-cli";

/**
 * OpenCode's models, as `opencode models --verbose` printed them on 1.x and
 * `opencode api model.list` prints them on 2.x.
 *
 * 1.18.32: each model is a line `provider/model`, followed by its record as
 * indented JSON — `name`, `providerID`, `limit.context`, `status` and
 * `variants`, the reasoning efforts `--variant` takes. Only providers
 * OpenCode can reach are listed: those signed in, configured, given by an
 * environment variable, and OpenCode's own free models. Plain
 * `opencode models` prints the id lines alone.
 *
 * 2.x removed the `--verbose` flag, so the details now come from
 * `opencode api model.list`: `{ data: [...] }` with one record per model —
 * `id`/`modelID`, `providerID`, `name`, `limit.context`, `status` and
 * `variants`, an array of `{ id }` entries naming the reasoning efforts
 * `--model provider/model#effort` takes. Records without variants offer no
 * selectable effort.
 *
 * Through a pipe, OpenCode 1.x loses the end of what it prints when it exits
 * (measured: 110–166 KB of 264 KB arrived, exit code 0), which only the long
 * verbose list reaches. So the plain list says which models there are, and
 * the detail lists only add names, context sizes and efforts where their
 * records arrived. Nothing is assumed: a model whose details never arrived
 * keeps its plain entry with no effort claim.
 */

const ID_LINE = /^([^\s/{}[\]"]+)\/(\S+)$/;

/** Reasoning efforts from a model's `variants`, in either release's shape. */
export function effortsOf(record: unknown): string[] {
  const variants = field(record, "variants");
  const raw: unknown[] = Array.isArray(variants)
    ? variants
    : typeof variants === "object" && variants !== null
      ? Object.keys(variants)
      : [];
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const entry of raw) {
    const name =
      typeof entry === "string" ? entry : stringField(entry, "id") ?? stringField(entry, "name");
    const trimmed = name?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      efforts.push(trimmed);
    }
  }
  return efforts;
}

/** One model record of either detail source, or null when unusable. */
function modelFromRecord(record: unknown, fallbackProvider: string, fallbackId: string): ModelInfo | null {
  if (stringField(record, "status") === "deprecated") {
    return null;
  }
  const provider = stringField(record, "providerID") ?? fallbackProvider;
  const rawId = stringField(record, "modelID") ?? stringField(record, "id") ?? fallbackId;
  const id = rawId.includes("/") ? rawId : `${provider}/${rawId}`;
  const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  const name = stringField(record, "name");
  const context = numberField(record, "limit", "context");
  const efforts = effortsOf(record);
  return {
    id,
    displayName: name ?? shortId,
    ...(provider ? { group: provider } : {}),
    ...(context !== undefined && context > 0 ? { contextWindow: Math.round(context) } : {}),
    ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
    source: "provider",
  };
}

/** Models from `opencode models --verbose`, or from the plain list. */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const lines = stdout.replace(/\r/g, "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = ID_LINE.exec(lines[index]?.trim() ?? "");
    if (!match) {
      continue;
    }
    const [, provider = "", modelId = ""] = match;
    const id = `${provider}/${modelId}`;
    // The record, when there is one, runs from "{" to the next "}" line at
    // the left margin.
    let record: unknown;
    if (lines[index + 1]?.trim() === "{") {
      let end = index + 1;
      while (end < lines.length && lines[end] !== "}") {
        end += 1;
      }
      try {
        record = JSON.parse(lines.slice(index + 1, end + 1).join("\n"));
      } catch {
        record = undefined;
      }
      index = end;
    }
    if (seen.has(id) || stringField(record, "status") === "deprecated") {
      continue;
    }
    seen.add(id);
    const info = modelFromRecord(record, provider, modelId);
    models.push(info ?? { id, displayName: modelId, group: provider, source: "provider" });
  }
  return models;
}

/**
 * Models from `opencode api model.list` (OpenCode 2.x): `{ data: [...] }`
 * with one record per model. Returns [] when the stdout is not such an
 * answer — e.g. the 1.x server that has no such operation — so the caller
 * falls back to what else the tool said rather than failing the discovery.
 */
export function parseOpencodeApiModels(stdout: string): ModelInfo[] {
  // The tool may prefix a byte-order mark; stderr stays separate, so the
  // answer itself is JSON once that is gone.
  const cleaned = stdout.replace(/^\uFEFF/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const data = field(parsed, "data");
  const records = Array.isArray(data) ? data : Array.isArray(parsed) ? parsed : null;
  if (!records) {
    return [];
  }
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const info = modelFromRecord(record, "", "");
    if (!info || info.id === "/" || seen.has(info.id)) {
      continue;
    }
    seen.add(info.id);
    models.push(info);
  }
  return models;
}

/** The complete list of ids, with what the detail lists knew about each. */
export function mergeOpencodeModels(
  plain: readonly ModelInfo[],
  ...details: readonly (readonly ModelInfo[])[]
): ModelInfo[] {
  const known = new Map<string, ModelInfo>();
  for (const list of details) {
    for (const model of list) {
      known.set(model.id, model);
    }
  }
  return plain.map((model) => known.get(model.id) ?? model);
}
