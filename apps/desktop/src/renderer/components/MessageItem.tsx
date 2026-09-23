import { type JSX, useState } from "react";
import { Check, ChevronRight, Copy, RotateCcw, Square } from "lucide-react";
import type { ChatMessage, ToolCallRecord } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";

interface MessageItemProps {
  readonly message: ChatMessage;
  readonly streaming: boolean;
  readonly onRetry?: (text: string) => void;
}

/**
 * One turn, rendered as a document rather than a bubble (spec §79). Tool calls
 * are collapsed to a single line until the user opens them. Code fences get
 * line numbers and a copy control; hover actions stay faint until needed.
 */
export function MessageItem({ message, streaming, onRetry }: MessageItemProps): JSX.Element {
  const isAssistant = message.role === "assistant";
  const cancel = useWorkbench((state) => state.cancel);
  const [copied, setCopied] = useState(false);

  const copyBody = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard denial is not worth an error surface on a quiet action.
    }
  };

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
        <MessageBody content={message.content} role={message.role} />
      ) : streaming ? (
        <div className="message__body">
          <span className="caret" aria-hidden="true" />
        </div>
      ) : null}

      {streaming ? (
        <div className="message__streamrow">
          <span className="caret" aria-hidden="true" />
          <span className="row__meta">Responding…</span>
          <button type="button" className="stopchip" onClick={() => void cancel()}>
            <Square size={10} strokeWidth={2} aria-hidden="true" />
            Stop
          </button>
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

      <div className="message__actions">
        <button
          type="button"
          className="icon-button"
          onClick={() => void copyBody()}
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied" : "Copy message"}
        >
          {copied ? (
            <Check size={13} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Copy size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
        {message.role === "user" || message.status === "failed" ? (
          <button
            type="button"
            className="icon-button"
            onClick={() => onRetry?.(message.content)}
            title="Retry"
            aria-label="Retry this message"
            disabled={message.content.trim().length === 0}
          >
            <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Plain prose with fenced code rendered as numbered blocks (presentation only). */
function MessageBody({
  content,
  role,
}: {
  readonly content: string;
  readonly role: ChatMessage["role"];
}): JSX.Element {
  const parts = splitFences(content);
  return (
    <div className="message__body">
      {parts.map((part, index) =>
        part.kind === "code" ? (
          <CodeBlock key={index} lang={part.lang} code={part.code} />
        ) : role === "user" ? (
          <span key={index} className="bubble">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}

type FencePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly code: string };

function splitFences(content: string): FencePart[] {
  const parts: FencePart[] = [];
  const pattern = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) {
      parts.push({ kind: "text", text: content.slice(last, match.index) });
    }
    parts.push({
      kind: "code",
      lang: match[1] ?? "",
      code: (match[2] ?? "").replace(/\n$/, ""),
    });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    parts.push({ kind: "text", text: content.slice(last) });
  }
  if (parts.length === 0) {
    parts.push({ kind: "text", text: content });
  }
  return parts;
}

function CodeBlock({ lang, code }: { readonly lang: string; readonly code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Same as above: a quiet action stays quiet.
    }
  };
  return (
    <div className="codeblock">
      <div className="codeblock__head">
        <span className="codeblock__lang">{lang || "code"}</span>
        <button
          type="button"
          className="quiet-button codeblock__copy"
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="codeblock__pre">
        {lines.map((line, index) => (
          <span key={index} className="codeblock__line">
            <span className="codeblock__no" aria-hidden="true">
              {index + 1}
            </span>
            <span>{line || " "}</span>
          </span>
        ))}
      </pre>
    </div>
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
          className="tool-call__chevron"
          data-open={open}
        />
        <span>{toolCall.name}</span>
        {toolCall.summary ? <span>· {toolCall.summary}</span> : null}
        {toolCall.state === "running" ? (
          <span className="tool-call__state" data-state="running">
            · running
          </span>
        ) : null}
        {toolCall.state === "completed" ? (
          <span className="tool-call__state" data-state="done">
            ✓ done
          </span>
        ) : null}
        {toolCall.state === "failed" ? (
          <span className="tool-call__state" data-state="failed">
            ! failed
          </span>
        ) : null}
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
