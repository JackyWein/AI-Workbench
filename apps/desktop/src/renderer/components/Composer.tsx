import { type JSX, useEffect, useRef, useState } from "react";
import { ListOrdered, Plus, Square } from "lucide-react";
import { layout } from "@ai-workbench/ui";
import { useWorkbench } from "../store/workbench.js";
import { ModelPicker } from "./ModelPicker.js";

interface ComposerProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  /** What the box asks for, when it is not a reply to the session's model. */
  readonly placeholder?: string;
}

export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
  placeholder,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const setPaletteOpen = useWorkbench((state) => state.setPaletteOpen);

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
          placeholder={disabled ? "Select a session to start" : (placeholder ?? "Reply…")}
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
          <button
            type="button"
            className="composer__iconbtn"
            disabled
            title="Attachments aren't supported yet"
            aria-label="Attach (not supported yet)"
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="composer__iconbtn"
            onClick={() => setPaletteOpen(true)}
            title="Commands (Ctrl+K)"
            aria-label="Open commands"
          >
            <ListOrdered size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <ModelPicker />
          {busy ? (
            <button type="button" className="ghost-button" onClick={onCancel}>
              <Square size={12} strokeWidth={2} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              onClick={submit}
              disabled={disabled || text.trim().length === 0}
            >
              Send <kbd className="kbd kbd--on-accent">↵</kbd>
            </button>
          )}
        </div>
        <div className="composer__hint">
          Enter to send · Shift+Enter newline · Esc stops the run
        </div>
      </div>
    </div>
  );
}
