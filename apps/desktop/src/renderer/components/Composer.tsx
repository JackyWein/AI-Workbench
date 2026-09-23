import { type DragEvent, type JSX, useEffect, useRef, useState } from "react";
import { FileText, Image, ListOrdered, Plus, Square, X } from "lucide-react";
import { attachmentKind, MAX_ATTACHMENT_BYTES, type MessageAttachment } from "@ai-workbench/shared";
import { layout } from "@ai-workbench/ui";
import { useWorkbench } from "../store/workbench.js";
import { ModelPicker } from "./ModelPicker.js";

/** Files one message carries at most; the same limit the main process keeps. */
const MAX_FILES = 20;

interface ComposerProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSend: (text: string, attachments: MessageAttachment[]) => void;
  readonly onCancel: () => void;
  /** What the box asks for, when it is not a reply to the session's model. */
  readonly placeholder?: string;
  /**
   * Whether files can go with the message; a reason when they cannot, shown
   * on the disabled button. Without it the button is not shown.
   */
  readonly attach?: { readonly supported: boolean; readonly reason?: string };
}

export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
  placeholder,
  attach,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<MessageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const setPaletteOpen = useWorkbench((state) => state.setPaletteOpen);
  const chooseAttachments = useWorkbench((state) => state.chooseAttachments);
  const canAttach = attach?.supported === true && !disabled;

  const add = (incoming: MessageAttachment[]): void => {
    const tooLarge = incoming.filter((file) => (file.size ?? 0) > MAX_ATTACHMENT_BYTES);
    const known = new Set(files.map((file) => file.path));
    const next = [
      ...files,
      ...incoming.filter(
        (file) => (file.size ?? 0) <= MAX_ATTACHMENT_BYTES && !known.has(file.path),
      ),
    ];
    setFiles(next.slice(0, MAX_FILES));
    const notes: string[] = [];
    if (tooLarge.length > 0) {
      notes.push(
        `${tooLarge.map((file) => file.name).join(", ")} ${tooLarge.length === 1 ? "is" : "are"} larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      );
    }
    if (next.length > MAX_FILES) {
      notes.push(`A message takes up to ${MAX_FILES} files.`);
    }
    setNote(notes.length > 0 ? notes.join(" ") : null);
  };

  const pick = async (): Promise<void> => {
    add(await chooseAttachments());
    inputRef.current?.focus();
  };

  const drop = (event: DragEvent<HTMLDivElement>): void => {
    setDragging(false);
    if (!canAttach || event.dataTransfer.files.length === 0) {
      return;
    }
    event.preventDefault();
    const dropped: MessageAttachment[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.workbench.pathForFile(file);
      // A folder, or something dragged from another app without a file
      // behind it, has no path to send.
      if (path) {
        dropped.push({ path, name: file.name, kind: attachmentKind(file.name), size: file.size });
      }
    }
    add(dropped);
  };

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
    onSend(value, files);
    setText("");
    setFiles([]);
    setNote(null);
    // The caret stays where the next message starts: back in the box.
    inputRef.current?.focus();
  };

  return (
    <div className="composer">
      <div
        className="composer__inner"
        data-dragging={dragging ? "true" : undefined}
        onDragOver={(event) => {
          if (canAttach && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {files.length > 0 ? (
          <ul className="composer__files" aria-label="Attached files">
            {files.map((file) => (
              <li key={file.path} className="file-chip" title={file.path}>
                {file.kind === "image" ? (
                  <Image size={13} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span className="file-chip__name">{file.name}</span>
                {file.size !== undefined ? (
                  <span className="file-chip__size">{formatSize(file.size)}</span>
                ) : null}
                <button
                  type="button"
                  className="file-chip__remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((entry) => entry.path !== file.path))}
                >
                  <X size={12} strokeWidth={2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {note ? (
          <p className="composer__note" role="status">
            {note}
          </p>
        ) : null}
        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? "Select a session to start"
              : files.length > 0
                ? "Say what to do with the files…"
                : (placeholder ?? "Reply…")
          }
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
          {attach ? (
            <button
              type="button"
              className="composer__iconbtn"
              disabled={!canAttach}
              onClick={() => void pick()}
              title={
                canAttach
                  ? "Attach images or files (or drop them here)"
                  : (attach.reason ?? "This session can't take files")
              }
              aria-label="Attach files"
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}
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

/** 1.2 MB, 340 KB, 12 B — enough to tell files apart. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
