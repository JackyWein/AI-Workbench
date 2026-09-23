import type { ModelInfo } from "@ai-workbench/shared";
import { field, numberField, stringField } from "@ai-workbench/provider-cli";

/**
 * OpenCode's models, as `opencode models --verbose` prints them.
 *
 * Checked against OpenCode 1.18.32: each model is a line `provider/model`,
 * followed by its record as indented JSON — `name`, `providerID`,
 * `limit.context`, `status` and `variants`, the reasoning efforts
 * `--variant` takes. Only providers OpenCode can reach are listed: those
 * signed in, configured, given by an environment variable, and OpenCode's
 * own free models. Plain `opencode models` prints the id lines alone.
 *
 * Through a pipe, OpenCode loses the end of what it prints when it exits
 * (measured: 110–166 KB of 264 KB arrived, exit code 0), which only the long
 * verbose list reaches. So the plain list says which models there are, and
 * the verbose one only adds names, context sizes and efforts where its
 * records arrived.
 */

const ID_LINE = /^([^\s/{}[\]"]+)\/(\S+)$/;

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
    const name = stringField(record, "name");
    const context = numberField(record, "limit", "context");
    const variants = field(record, "variants");
    const efforts =
      typeof variants === "object" && variants !== null && !Array.isArray(variants)
        ? Object.keys(variants)
        : [];
    models.push({
      id,
      displayName: name ?? modelId,
      group: stringField(record, "providerID") ?? provider,
      ...(context !== undefined && context > 0 ? { contextWindow: Math.round(context) } : {}),
      ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
      source: "provider",
    });
  }
  return models;
}

/** The complete list of ids, with what the verbose list knew about each. */
export function mergeOpencodeModels(
  plain: readonly ModelInfo[],
  verbose: readonly ModelInfo[],
): ModelInfo[] {
  const known = new Map(verbose.map((model) => [model.id, model]));
  return plain.map((model) => known.get(model.id) ?? model);
}
