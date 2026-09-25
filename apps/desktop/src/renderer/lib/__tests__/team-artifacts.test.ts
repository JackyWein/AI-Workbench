import { describe, expect, it } from "vitest";
import {
  artifactLanguage,
  artifactReason,
  classifyArtifact,
  diffLineKind,
  diffStats,
  extractCodeContent,
} from "../team-artifacts.js";

function artifact(type: string, content: string | null) {
  return { type, content };
}

describe("classifyArtifact", () => {
  it("treats declared diffs as diffs", () => {
    expect(classifyArtifact(artifact("diff", "anything"))).toBe("diff");
  });

  it("treats declared code as code unless it is a unified diff", () => {
    expect(classifyArtifact(artifact("code", "const x = 1;"))).toBe("code");
    expect(
      classifyArtifact(
        artifact("code", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"),
      ),
    ).toBe("diff");
  });

  it("detects undeclared unified diffs by markers", () => {
    expect(
      classifyArtifact(artifact("report", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new")),
    ).toBe("diff");
    expect(classifyArtifact(artifact("doc", "just prose"))).toBe("other");
  });

  it("needs two diff markers to avoid single +/- false positives", () => {
    expect(classifyArtifact(artifact("doc", "+ one added line"))).toBe("other");
  });
});

describe("diffLineKind", () => {
  it("classifies hunk headers, file headers stay context", () => {
    expect(diffLineKind("@@ -1,3 +1,3 @@")).toBe("hunk");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("del");
    expect(diffLineKind("+++ b/file")).toBe("ctx");
    expect(diffLineKind("diff --git a/src/a.ts b/src/a.ts")).toBe("file");
    expect(diffLineKind("--- a/file")).toBe("ctx");
    expect(diffLineKind(" context")).toBe("ctx");
  });
});

describe("diffStats", () => {
  it("counts added/removed lines, not headers", () => {
    expect(diffStats("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+more\n ctx")).toEqual({
      added: 2,
      removed: 1,
    });
  });
});

describe("artifactReason", () => {
  it("returns the first non-empty reason field", () => {
    expect(artifactReason({ reason: "fixes the crash" })).toBe("fixes the crash");
    expect(artifactReason({ summary: "  wrapped query  " })).toBe("wrapped query");
    expect(artifactReason({})).toBeNull();
    expect(artifactReason({ reason: "   " })).toBeNull();
    expect(artifactReason({ reason: 42 })).toBeNull();
  });
});

describe("artifactLanguage", () => {
  it("prefers metadata, then file extension", () => {
    expect(artifactLanguage({ path: "a.ts", metadata: { language: "Python" } })).toBe("python");
    expect(artifactLanguage({ path: "src/app.tsx", metadata: {} })).toBe("tsx");
    expect(artifactLanguage({ path: null, metadata: {} })).toBe("");
    expect(artifactLanguage({ path: "Makefile", metadata: {} })).toBe("");
  });
});

describe("extractCodeContent", () => {
  it("unwraps one outer fence, leaves plain code alone", () => {
    expect(extractCodeContent("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(extractCodeContent("const x = 1;")).toBe("const x = 1;");
  });
});
