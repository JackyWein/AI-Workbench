/**
 * Deterministic reply text for the mock provider. Deterministic output keeps
 * tests meaningful and makes streaming behaviour reproducible.
 */
export function buildMockReply(prompt: string, modelId: string): string {
  const trimmed = prompt.trim();
  const subject = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;

  return [
    `Mock response from ${modelId}.`,
    "",
    `You asked: ${subject}`,
    "",
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
