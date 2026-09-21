import { type JSX, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Square } from "lucide-react";
import { layout } from "@ai-workbench/ui";

interface ComposerProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
}

export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to the max height defined by the tokens.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, layout.composerMaxHeight)}px`;
  }, [text]);

  const submit = (): void => {
    const value = text.trim();
    if (!value || busy || disabled) {
      return;
    }
    onSend(value);
    setText("");
    // The caret stays where the next message starts: back in the box.
    inputRef.current?.focus();
  };

  return (
    <div className="composer">
      <div className="composer__inner">
        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "Select a session to start" : "Send a message"}
          aria-label="Message"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              // An IME commit also arrives as Enter; it must not send.
              if (event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer__actions">
          <span className="composer__hint">
            Enter to send · Shift+Enter for a new line
          </span>
          {busy ? (
            <button type="button" className="ghost-button" onClick={onCancel}>
              <Square size={12} strokeWidth={2} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={submit}
              disabled={disabled || text.trim().length === 0}
            >
              <CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
