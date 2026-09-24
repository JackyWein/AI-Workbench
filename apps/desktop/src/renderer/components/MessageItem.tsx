import { type JSX, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, FileText, Image, RotateCcw, Square } from "lucide-react";
import type { ChatMessage, ProviderSummary, ToolCallRecord } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown.js";

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
  const providers = useWorkbench((state) => state.providers);
  const [copied, setCopied] = useState(false);
  const author = isAssistant ? authorOf(message, providers) : null;

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
        <span>{author ? author.name : "You"}</span>
        {author?.model ? <span className="message__model">{author.model}</span> : null}
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

      {message.attachments.length > 0 ? (
        <ul className="message__files" aria-label="Attached files">
          {message.attachments.map((file) => (
            <li key={file.path} className="file-chip" title={file.name}>
              {file.kind === "image" ? (
                <Image size={13} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
              )}
              <span className="file-chip__name">{file.name}</span>
            </li>
          ))}
        </ul>
      ) : null}

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
export function MessageBody({
  content,
  role,
}: {
  readonly content: string;
  readonly role: ChatMessage["role"];
}): JSX.Element {
  // What the person typed is shown as typed; answers are Markdown.
  if (role === "user") {
    return (
      <div className="message__body">
        <span className="bubble">{content}</span>
      </div>
    );
  }
  return <AnswerBody content={content} />;
}

function AnswerBody({ content }: { readonly content: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div className="message__body md">
      <Blocks blocks={blocks} />
    </div>
  );
}

function Blocks({ blocks }: { readonly blocks: readonly Block[] }): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

function BlockView({ block }: { readonly block: Block }): JSX.Element {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="md__p">
          <Inlines nodes={block.content} />
        </p>
      );
    case "heading":
      return (
        <p className="md__heading" data-level={Math.min(block.level, 4)} role="heading" aria-level={block.level}>
          <Inlines nodes={block.content} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} data-task={item.checked === null ? undefined : item.checked}>
          {item.checked === null ? null : (
            <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} aria-hidden="true" />
          )}
          <Inlines nodes={item.content} />
          {item.children.length > 0 ? <Blocks blocks={item.children} /> : null}
        </li>
      ));
      return block.ordered ? (
        <ol className="md__list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md__list">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="md__quote">
          <Blocks blocks={block.blocks} />
        </blockquote>
      );
    case "rule":
      return <hr className="md__rule" />;
    case "table":
      return (
        <div className="md__table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return <CodeBlock lang={block.lang} code={block.code} />;
  }
}

function Inlines({ nodes }: { readonly nodes: readonly Inline[] }): JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <span key={index}>{node.text}</span>;
          case "break":
            return <br key={index} />;
          case "code":
            return (
              <code key={index} className="md__code">
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index}>
                <Inlines nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.children} />
              </em>
            );
          case "del":
            return (
              <del key={index}>
                <Inlines nodes={node.children} />
              </del>
            );
          case "link":
            // Opens in the browser: the window hands http(s) links to it and
            // refuses everything else.
            return (
              <a key={index} className="md__link" href={node.href} target="_blank" rel="noreferrer" title={node.href}>
                <Inlines nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
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

/** Who answered, by the names the tool gives itself and its model. */
function authorOf(
  message: ChatMessage,
  providers: readonly ProviderSummary[],
): { name: string; model: string | null } {
  const provider = providers.find((entry) => entry.metadata.id === message.providerId);
  const model = provider?.models.find((entry) => entry.id === message.modelId);
  if (!provider) {
    return { name: message.modelId ?? message.providerId ?? "Assistant", model: null };
  }
  return {
    name: provider.metadata.displayName,
    model: model?.displayName ?? message.modelId ?? null,
  };
}
