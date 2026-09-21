import { type JSX, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatMessage, ToolCallRecord } from "@ai-workbench/shared";

interface MessageItemProps {
  readonly message: ChatMessage;
  readonly streaming: boolean;
}

/**
 * One turn, rendered as a document rather than a bubble (spec §79). Tool calls
 * are collapsed to a single line until the user opens them.
 */
export function MessageItem({ message, streaming }: MessageItemProps): JSX.Element {
  const isAssistant = message.role === "assistant";

  return (
    <article className="message" data-role={message.role} data-status={message.status}>
      <div className="message__meta">
        <span>{isAssistant ? modelLabel(message) : "You"}</span>
        <time dateTime={message.createdAt.toISOString()}>
          {message.createdAt.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>

      {message.toolCalls.map((toolCall) => (
        <ToolCallBlock key={toolCall.id} toolCall={toolCall} />
      ))}

      {message.content ? (
        <div className="message__body">
          {message.content}
          {streaming ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      ) : streaming ? (
        <div className="message__body">
          <span className="caret" aria-hidden="true" />
        </div>
      ) : null}

      {message.status === "cancelled" ? (
        <p className="message__note">Stopped</p>
      ) : null}
      {message.status === "failed" ? (
        <p className="message__note" data-tone="error">
          {message.error ?? "The provider reported an error"}
        </p>
      ) : null}
    </article>
  );
}

function ToolCallBlock({ toolCall }: { readonly toolCall: ToolCallRecord }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="tool-call">
      <button
        type="button"
        className="tool-call__summary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform var(--duration-fast) var(--easing-standard)",
          }}
        />
        <span>{toolCall.name}</span>
        {toolCall.summary ? <span>· {toolCall.summary}</span> : null}
        {toolCall.state === "running" ? <span>· running</span> : null}
      </button>
      {open ? (
        <div className="tool-call__body">
          {JSON.stringify({ input: toolCall.input, output: toolCall.output }, null, 2)}
        </div>
      ) : null}
    </div>
  );
}

function modelLabel(message: ChatMessage): string {
  return message.modelId ?? message.providerId ?? "Assistant";
}
