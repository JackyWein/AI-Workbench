import { describe, expect, it } from "vitest";
import {
  TEAM_TEMPLATE_FORMAT,
  exportTeamTemplates,
  parseTeamTemplateImport,
  type TeamTemplateContent,
} from "../domain/team-template.js";

const pair: TeamTemplateContent = {
  name: "Pair",
  summary: "Two people",
  leadIndex: 1,
  members: [
    { name: "Builder", role: "builds", instructions: "Build it." },
    { name: "Lead", role: "leads", instructions: "Lead it.", providerId: "claude-code", modelId: "opus" },
  ],
};

describe("team templates as JSON", () => {
  it("exports their content and imports it back unchanged", () => {
    const text = exportTeamTemplates([pair]);
    expect(JSON.parse(text).format).toBe(TEAM_TEMPLATE_FORMAT);
    expect(text).not.toContain("createdAt");
    const back = parseTeamTemplateImport(text);
    expect(back.errors).toEqual([]);
    expect(back.templates).toEqual([pair]);
  });

  it("takes a single template or a list, filling what is left out", () => {
    const single = parseTeamTemplateImport(JSON.stringify({ name: "Solo", members: [{ name: "Only" }] }));
    expect(single.templates).toEqual([
      { name: "Solo", summary: "", leadIndex: 0, members: [{ name: "Only", role: "", instructions: "" }] },
    ]);
    expect(parseTeamTemplateImport(JSON.stringify([pair, pair])).templates).toHaveLength(2);
  });

  it("names every template that does not hold up, and why, and keeps the rest", () => {
    const result = parseTeamTemplateImport(
      JSON.stringify({
        format: TEAM_TEMPLATE_FORMAT,
        templates: [pair, { name: "Nobody", members: [] }, { name: "Lost lead", members: [{ name: "A" }], leadIndex: 3 }],
      }),
    );
    expect(result.templates.map((template) => template.name)).toEqual(["Pair"]);
    expect(result.errors).toEqual([
      '"Nobody": members — A team needs at least one member',
      '"Lost lead": leadIndex — The lead must be one of the members',
    ]);
    expect(parseTeamTemplateImport("not json")).toEqual({ templates: [], errors: ["The file is not JSON."] });
  });
});
