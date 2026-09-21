import { memo, useEffect, useRef, useState, type JSX } from "react";
import type { ChatMessage } from "@ai-workbench/shared";
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
          />
        ))}
      </div>
    </div>
  );
}
