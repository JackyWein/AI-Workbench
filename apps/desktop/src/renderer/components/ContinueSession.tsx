import { useRef, useState, type JSX } from "react";
import type { ProviderSummary, Session } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { draftingProviders, type DraftChoice } from "../lib/draft-choice.js";
import { useWorkbench } from "../store/workbench.js";
import { DraftChoicePicker } from "./DraftChoicePicker.js";

export function ContinueSession({ session, providers, busy }: { readonly session: Session; readonly providers: ProviderSummary[]; readonly busy: boolean }): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null);
  const usable = draftingProviders(providers).filter((provider) => provider.metadata.id !== session.providerId);
  const [choice, setChoice] = useState<DraftChoice>({ providerId: "", modelId: "", effort: "" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.type !== "solo") return null;
  const fork = async (): Promise<void> => {
    setWorking(true); setError(null);
    try {
      const next = await invoke("session.fork", { sessionId: session.id, providerId: choice.providerId, ...(choice.modelId ? { modelId: choice.modelId } : {}), ...(choice.effort ? { reasoningEffort: choice.effort } : {}) });
      dialog.current?.close();
      await useWorkbench.getState().selectSession(next.id);
    } catch (problem) { setError(describeError(problem)); }
    finally { setWorking(false); }
  };
  return <>
    <button type="button" className="ghost-button" disabled={busy || usable.length === 0} title={usable.length ? "Copy this conversation to another tool" : "Connect another chat tool first"} onClick={() => {
      setChoice({ providerId: usable[0]?.metadata.id ?? "", modelId: "", effort: "" }); setError(null); dialog.current?.showModal();
    }}>Continue in…</button>
    <dialog ref={dialog} className="continuation-dialog" aria-labelledby="continue-title">
      <h2 id="continue-title">Continue in another tool</h2>
      <p>The new conversation keeps your history. Its first message includes up to 40 recent exchanges; the original conversation stays available. Earlier attached files remain in the copied history, but must be reattached if the new tool needs their contents.</p>
      <DraftChoicePicker usable={usable} value={choice} onChange={setChoice} label="Continue with" />
      {error ? <p role="alert">{error}</p> : null}
      <div className="view__actions">
        <button type="button" className="ghost-button" disabled={working} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="primary-button" disabled={working || !choice.providerId} onClick={() => void fork()}>{working ? "Copying…" : "Create conversation"}</button>
      </div>
    </dialog>
  </>;
}
