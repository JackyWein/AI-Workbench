import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderEvent } from "@ai-workbench/shared";
import { createId } from "./ids.js";
import type { ProviderManager } from "./provider-manager.js";

export interface OneTurnRequest {
  readonly providerId: string;
  readonly modelId?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly prompt: string;
  /** How long the answer may take before it is given up. */
  readonly timeoutMs?: number;
}

export interface OneTurnAnswer {
  readonly text: string;
  /** What the tool said went wrong, when it did. */
  readonly failure: string | null;
  /** The model that answered, when the tool said or one was chosen. */
  readonly modelId?: string;
}

/**
 * Asks one of the person's own tools a single question, read-only, in an
 * empty folder of the application's, and returns the answer. Nothing it
 * might do reaches the person's files; the folder is removed afterwards.
 */
export async function askOnce(
  providers: ProviderManager,
  request: OneTurnRequest,
  scratchDirectory: string,
): Promise<OneTurnAnswer> {
  const adapter = providers.get(request.providerId);
  if (!adapter) {
    throw new Error("That provider is not available.");
  }
  const sessionId = createId("ask");
  const folder = join(scratchDirectory, sessionId);
  await mkdir(folder, { recursive: true });
  const info = await adapter.createSession({
    sessionId,
    workingDirectory: folder,
    ...(request.modelId ? { modelId: request.modelId } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    permissionMode: "readOnly",
  });
  const modelId = info.modelId ?? request.modelId;
  const handle = {
    sessionId,
    providerSessionId: info.providerSessionId,
    ...(modelId ? { modelId } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    permissionMode: "readOnly" as const,
  };
  let text = "";
  let failure: string | null = null;
  const timer = setTimeout(
    () => void adapter.cancel(handle).catch(() => undefined),
    request.timeoutMs ?? 4 * 60_000,
  );
  try {
    for await (const event of adapter.sendMessage(handle, { text: request.prompt })) {
      const typed = event as ProviderEvent;
      if (typed.type === "text_delta") {
        text += typed.text;
      } else if (typed.type === "message" && text === "") {
        text = typed.text;
      } else if (typed.type === "error") {
        failure = typed.error.message;
      }
    }
  } finally {
    clearTimeout(timer);
    await adapter.destroySession(handle).catch(() => undefined);
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  return { text, failure, ...(modelId ? { modelId } : {}) };
}
