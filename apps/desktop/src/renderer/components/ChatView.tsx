import { type JSX, useEffect, useRef } from "react";
import type { ChatMessage } from "@ai-workbench/shared";
import { MessageItem } from "./MessageItem.js";

interface ChatViewProps {
  readonly messages: ChatMessage[];
}

export function ChatView({ messages }: ChatViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const lastMessage = messages.at(-1);
  const lastLength = lastMessage?.content.length ?? 0;

  // Follow the stream, but stop following as soon as the user scrolls up.
  useEffect(() => {
    const container = containerRef.current;
    if (container && pinnedToBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages.length, lastLength]);

  return (
    <div
      className="chat"
      ref={containerRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        const distance =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        pinnedToBottom.current = distance < 48;
      }}
    >
      <div className="chat__inner">
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            streaming={message.status === "streaming"}
          />
        ))}
      </div>
    </div>
  );
}
