import { describe, expect, it } from "vitest";
import {
  effortsOf,
  mergeOpencodeModels,
  parseOpencodeApiModels,
  parseOpencodeModels,
} from "../models.js";

/** Shaped like `opencode models --verbose` of OpenCode 1.18.32. */
const verbose = [
  "opencode/big-pickle",
  "{",
  '  "id": "big-pickle",',
  '  "providerID": "opencode",',
  '  "name": "Big Pickle",',
  '  "status": "active",',
  '  "limit": { "context": 200000 },',
  '  "variants": { "low": {}, "high": {} }',
  "}",
  "standin/old",
  "{",
  '  "status": "deprecated",',
  '  "variants": {}',
  "}",
].join("\n");

/** Shaped like `opencode api model.list` of OpenCode 2.0.15. */
const api = JSON.stringify({
  data: [
    {
      id: "space-bunny-free",
      modelID: "space-bunny-free",
      providerID: "opencode",
      name: "Space Bunny Free",
      status: "active",
      limit: { context: 1048576 },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
    },
    {
      id: "plain-model",
      modelID: "plain-model",
      providerID: "aihubmix",
      name: "Plain Model",
      status: "active",
      limit: { context: 1000 },
      variants: [],
    },
  ],
});

describe("OpenCode model details", () => {
  it("reads 1.x efforts from the variants map", () => {
    const models = parseOpencodeModels(verbose);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "opencode/big-pickle",
      displayName: "Big Pickle",
      reasoningEfforts: ["low", "high"],
    });
  });

  it("reads 2.x efforts from the variants array", () => {
    expect(effortsOf({ variants: [{ id: "low" }, { id: "max" }] })).toEqual(["low", "max"]);
    expect(effortsOf({ variants: ["low", "low", " high ", ""] })).toEqual(["low", "high"]);
    expect(effortsOf({ variants: { low: {}, high: {} } })).toEqual(["low", "high"]);
    expect(effortsOf({ variants: [] })).toEqual([]);
    expect(effortsOf({})).toEqual([]);
  });

  it("parses the 2.x api answer with efforts only where the tool reports them", () => {
    const models = parseOpencodeApiModels(api);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "opencode/space-bunny-free",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(models[1]?.reasoningEfforts).toBeUndefined();
  });

  it("ignores what is not a model list instead of failing discovery", () => {
    expect(parseOpencodeApiModels("not json")).toEqual([]);
    expect(parseOpencodeApiModels('{"error":"nope"}')).toEqual([]);
  });

  it("tolerates the byte-order mark the tool prefixes", () => {
    expect(parseOpencodeApiModels(`\uFEFF${api}`)).toHaveLength(2);
  });

  it("merges the plain list with both detail sources, api winning", () => {
    const plain = parseOpencodeModels("opencode/space-bunny-free\naihubmix/plain-model\n");
    const models = mergeOpencodeModels(plain, [], parseOpencodeApiModels(api));
    expect(models).toHaveLength(2);
    expect(models[0]?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.reasoningEfforts).toBeUndefined();
  });
});
