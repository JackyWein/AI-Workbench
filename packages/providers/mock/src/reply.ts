/**
 * Deterministic reply text for the mock provider. Deterministic output keeps
 * tests meaningful and makes streaming behaviour reproducible.
 */
export function buildMockReply(
  prompt: string,
  modelId: string,
  attachments: ReadonlyArray<{ readonly kind: "file" | "image"; readonly path: string }> = [],
): string {
  const trimmed = prompt.trim();
  const subject = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  const files =
    attachments.length === 0
      ? []
      : [
          `You attached ${attachments.length === 1 ? "1 file" : `${attachments.length} files`}: ${attachments
            .map((entry) => `${fileName(entry.path)} (${entry.kind})`)
            .join(", ")}.`,
          "",
        ];

  return [
    `Mock response from ${modelId}.`,
    "",
    `You asked: ${subject}`,
    "",
    ...files,
    "This provider is a local simulation. It streams text in chunks, reports",
    "usage from its own counters and can simulate tool calls and failures, so",
    "the whole application path can be exercised without contacting a real",
    "provider or spending quota.",
  ].join("\n");
}

/** Splits text into stream chunks while preserving all whitespace. */
export function chunkText(text: string, chunkSize = 3): string[] {
  const tokens = text.match(/\s+|\S+/g) ?? [];
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += chunkSize) {
    chunks.push(tokens.slice(index, index + chunkSize).join(""));
  }
  return chunks;
}

/** The last part of a path, whichever separator it uses. */
function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
