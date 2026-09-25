import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "@ai-workbench/test-support";
import { createDatabase, runMigrations, type DatabaseHandle } from "@ai-workbench/database";
import { MockProviderAdapter } from "@ai-workbench/provider-mock";
import { createNullLogger } from "../logger.js";
import { ProviderManager } from "../provider-manager.js";
import { TeamTemplateDraftError, draftTeamTemplate, parseTeamTemplateDraft } from "../team-template-drafter.js";
import { TeamTemplateService } from "../team-template-service.js";

describe("reading a drafted team template", () => {
  const good = {
    name: "Reviewers",
    summary: "Two eyes on every change",
    leadIndex: 0,
    members: [
      { name: "Lead", role: "leads", instructions: "Plan." },
      { name: "Reviewer", role: "reviews", instructions: "Review.", providerId: "claude-code" },
    ],
  };

  it("takes a template bare, fenced or with words around it, without tool choices", () => {
    for (const answer of [
      JSON.stringify(good),
      "```json\n" + JSON.stringify(good, null, 2) + "\n```",
      "Here is the team:\n" + JSON.stringify(good) + "\nEnjoy.",
    ]) {
      const draft = parseTeamTemplateDraft(answer);
      expect(draft.name).toBe("Reviewers");
      expect(draft.members.map((member) => member.name)).toEqual(["Lead", "Reviewer"]);
      expect(draft.members[1]).not.toHaveProperty("providerId");
    }
  });

  it("refuses a draft that does not hold up, and says why", () => {
    expect(() => parseTeamTemplateDraft("I would suggest a lead and a builder.")).toThrow(TeamTemplateDraftError);
    expect(() => parseTeamTemplateDraft("{ name: 'no quotes' }")).toThrow(/not valid JSON/);
    expect(() => parseTeamTemplateDraft(JSON.stringify({ ...good, members: [] }))).toThrow(
      /members — A team needs at least one member/,
    );
    expect(() => parseTeamTemplateDraft(JSON.stringify({ ...good, leadIndex: 5 }))).toThrow(/lead must be one of the members/);
  });
});

describe("team templates of the person's own", () => {
  let directory: string;
  let database: DatabaseHandle;
  let providers: ProviderManager;
  let templates: TeamTemplateService;

  beforeEach(async () => {
    directory = await makeTempDirectory("team-templates-");
    database = createDatabase({ file: join(directory, "test.db") });
    await runMigrations(database.client);
    providers = new ProviderManager({ logger: createNullLogger(), stateDirectory: join(directory, "providers") });
    await providers.register(new MockProviderAdapter({ chunkDelayMs: 0, startupDelayMs: 0 }));
    templates = new TeamTemplateService({ db: database.db });
  });

  afterEach(async () => {
    await providers.dispose();
    database.close();
    await removeTempDirectory(directory);
  });

  it("drafts a template on the chosen tool without storing it, and stores it on save", async () => {
    const draft = await draftTeamTemplate(
      providers,
      { providerId: "mock", modelId: "mock-fast", request: "builds and tests small games" },
      join(directory, "scratch"),
    );
    expect(draft.members.map((member) => member.name)).toEqual(["Lead", "Builder", "Tester", "Reviewer"]);
    expect(draft.modelId).toBe("mock-fast");
    expect(await templates.list()).toEqual([]);

    const saved = await templates.save(draft);
    const listed = await templates.list();
    expect(listed.map((template) => template.id)).toEqual([saved.id]);
    expect(listed[0]?.members).toHaveLength(4);

    const renamed = await templates.save({ ...saved, name: "Game team" });
    expect(renamed.id).toBe(saved.id);
    expect((await templates.list())[0]?.name).toBe("Game team");

    expect(await templates.delete(saved.id)).toBe(true);
    expect(await templates.list()).toEqual([]);
    expect(await templates.delete(saved.id)).toBe(false);
  });

  it("refuses to store a template that does not hold up", async () => {
    await expect(templates.save({ name: "Empty", summary: "", leadIndex: 0, members: [] })).rejects.toThrow();
    expect(await templates.list()).toEqual([]);
  });
});
