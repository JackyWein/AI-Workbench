import { memo, useEffect, useRef, useState, type JSX } from "react";
import type { ChatMessage } from "@ai-workbench/shared";
import { useWorkbench } from "../store/workbench.js";
import { MessageItem } from "./MessageItem.js";

interface ChatViewProps {
  readonly messages: ChatMessage[];
}

/**
 * How many messages stay mounted. A long chat would otherwise keep every DOM
 * node alive and re-resolve the whole list on each streamed token; older
 * messages page back in on demand, anchored at the bottom.
 */
const INITIAL_WINDOW = 100;
const PAGE_SIZE = 100;

/**
 * Earlier messages keep referential identity in the store (only the streaming
 * message is replaced per batch), so memo keeps them from re-rendering.
 */
const MemoMessageItem = memo(MessageItem);

export function ChatView({ messages }: ChatViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const scrollTick = useRef(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_WINDOW);

  const firstId = messages[0]?.id;
  // A different conversation reuses this mounted view; reset the window.
  useEffect(() => {
    setVisibleCount(INITIAL_WINDOW);
  }, [firstId]);

  const lastMessage = messages.at(-1);
  const lastLength = lastMessage?.content.length ?? 0;

  // Follow the stream, but stop following as soon as the user scrolls up.
  // The scroll lands on the next animation frame (one per delta batch), with
  // an instant jump: smooth scrolling would re-animate on every token.
  useEffect(() => {
    const container = containerRef.current;
    if (container && pinnedToBottom.current) {
      const frame = requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [messages.length, lastLength]);

  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visible = hiddenCount === 0 ? messages : messages.slice(hiddenCount);
  const sendMessage = useWorkbench((state) => state.sendMessage);
  const dayLabel = visible[0] ? dayLabelFor(visible[0].createdAt) : null;

  const retry = (message: ChatMessage): void => {
    if (message.role === "user" && message.content.trim().length > 0) {
      void sendMessage(message.content, message.attachments);
      return;
    }
    // A failed assistant turn retries the user turn before it, when there is one.
    const index = messages.findIndex((entry) => entry.id === message.id);
    for (let position = index - 1; position >= 0; position -= 1) {
      const candidate = messages[position];
      if (candidate?.role === "user" && candidate.content.trim().length > 0) {
        void sendMessage(candidate.content, candidate.attachments);
        return;
      }
    }
  };

  return (
    <div
      className="chat"
      ref={containerRef}
      role="log"
      aria-live="polite"
      aria-label="Messages"
      style={{ scrollBehavior: "auto" }}
      onScroll={() => {
        if (scrollTick.current) {
          return;
        }
        scrollTick.current = true;
        requestAnimationFrame(() => {
          scrollTick.current = false;
          const element = containerRef.current;
          if (!element) {
            return;
          }
          const distance =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          pinnedToBottom.current = distance < 48;
        });
      }}
    >
      <div className="chat__inner">
        {dayLabel ? <div className="day">{dayLabel}</div> : null}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="quiet-button"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            <span className="row__meta">
              Show {Math.min(PAGE_SIZE, hiddenCount)} earlier messages (
              {hiddenCount} hidden)
            </span>
          </button>
        ) : null}
        {visible.map((message) => (
          <MemoMessageItem
            key={message.id}
            message={message}
            streaming={message.status === "streaming"}
            onRetry={() => retry(message)}
          />
        ))}
      </div>
    </div>
  );
}

/** Day divider from a real timestamp: Today, Yesterday, or the date. */
function dayLabelFor(date: Date): string {
  const startOf = (value: Date): Date =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round(
    (startOf(new Date()).getTime() - startOf(date).getTime()) / 86_400_000,
  );
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
