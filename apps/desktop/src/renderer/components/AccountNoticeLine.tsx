import type { JSX } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { ChatMessage } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { formatWhen, useNow } from "../lib/usage.js";

/**
 * The application's own line in a chat when an account reached its limit:
 * where the chat went on, or why it stopped and when the limit resets. The
 * offer to go on on another account is a button only while it is the latest
 * thing in the chat.
 */
export function AccountNoticeLine({
  message,
  latest,
}: {
  readonly message: ChatMessage;
  readonly latest: boolean;
}): JSX.Element | null {
  const continueOnAccount = useWorkbench((state) => state.continueOnAccount);
  const busy = useWorkbench((state) => state.busy[message.sessionId] ?? false);
  const now = useNow(60_000);
  const notice = message.notice;
  if (!notice) {
    return null;
  }
  const resetsAt = notice.resetsAt;
  // The tool's own words, kept short; the whole text is in the tooltip.
  const said = notice.reason.trim().replace(/[.\s]+$/, "");
  const reason = said.length > 140 ? `${said.slice(0, 139)}…` : said;

  return (
    <div className="chat-notice" role="note" data-state={notice.state}>
      <ArrowLeftRight size={13} strokeWidth={1.75} aria-hidden="true" className="chat-notice__icon" />
      <p className="chat-notice__text">
        {message.content}
        {reason ? (
          <span className="chat-notice__detail" title={notice.reason}>
            {" "}
            {notice.tool} said: “{reason}”.
          </span>
        ) : null}
        {resetsAt ? (
          <span className="chat-notice__detail">
            {" "}
            {resetsAt.getTime() > now ? `Resets ${formatWhen(resetsAt, now)}.` : `Reset ${formatWhen(resetsAt, now)}.`}
          </span>
        ) : null}
        {notice.carried ? (
          <span className="chat-notice__detail">
            {" "}
            {notice.carried === "native"
              ? `${notice.tool}'s own conversation moved along.`
              : "The conversation so far went along."}
          </span>
        ) : null}
      </p>
      {notice.state === "offered" && notice.to && latest ? (
        <button
          type="button"
          className="ghost-button chat-notice__action"
          disabled={busy}
          onClick={() => void continueOnAccount(message.sessionId)}
        >
          Continue on {notice.to.label}
        </button>
      ) : null}
    </div>
  );
}
