import { type ClipboardEvent, type DragEvent, type JSX, useEffect, useRef, useState } from "react";
import { FileText, Image, ListOrdered, Plus, Square, X } from "lucide-react";
import { attachmentKind, MAX_ATTACHMENT_BYTES, type MessageAttachment } from "@ai-workbench/shared";
import { layout } from "@ai-workbench/ui";
import { useWorkbench } from "../store/workbench.js";
import { describeError, invoke } from "../lib/client.js";
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
   * Key the unsent text is kept under (usually the session id). Switching the
   * key restores that key's draft, so tabbing between sessions never loses
   * what was typed. Without it the box stays local-only.
   */
  readonly draftKey?: string | null;
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
  draftKey,
  attach,
}: ComposerProps): JSX.Element {
  const storedDraft = useWorkbench((state) =>
    draftKey ? (state.drafts[draftKey] ?? "") : "",
  );
  const setDraft = useWorkbench((state) => state.setDraft);
  const clearDraft = useWorkbench((state) => state.clearDraft);
  const [text, setText] = useState(storedDraft);
  const [files, setFiles] = useState<MessageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftKeyRef = useRef(draftKey ?? null);
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

  /**
   * Pictures from the clipboard (screenshots, copied images) have no file
   * path, so `pathForFile` is empty for them and they are staged through
   * `session.savePastedImage`. Plain text pastes through untouched: only a
   * clipboard that actually carries an image is intercepted, and co-pasted
   * text is inserted at the caret.
   */
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!canAttach) {
      return;
    }
    const transfer = event.clipboardData;
    if (!transfer) {
      return;
    }
    const images: File[] = [];
    for (const file of Array.from(transfer.files)) {
      if (file.type.startsWith("image/")) {
        images.push(file);
      }
    }
    // Some Electron/Chrome versions expose a screenshot only via items.
    if (images.length === 0 && transfer.items) {
      for (const item of Array.from(transfer.items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            images.push(file);
          }
        }
      }
    }
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    const pastedText = transfer.getData("text/plain");
    if (pastedText) {
      const input = inputRef.current;
      if (input) {
        const start = input.selectionStart ?? text.length;
        const end = input.selectionEnd ?? text.length;
        setText(`${text.slice(0, start)}${pastedText}${text.slice(end)}`);
      } else {
        setText((current) => `${current}${pastedText}`);
      }
    }
    const direct: MessageAttachment[] = [];
    const staged: File[] = [];
    for (const file of images) {
      const path = window.workbench.pathForFile(file);
      if (path) {
        const name = file.name || "pasted-image.png";
        direct.push({ path, name, kind: attachmentKind(name), size: file.size });
      } else {
        staged.push(file);
      }
    }
    if (direct.length > 0) {
      add(direct);
    }
    if (staged.length === 0) {
      return;
    }
    void (async () => {
      const saved: MessageAttachment[] = [];
      for (const file of staged) {
        const mime = normalizePastedMime(file.type);
        if (!mime) {
          setNote("That picture is not a supported format. PNG, JPEG, GIF and WebP work.");
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
        } catch {
          setNote("The pasted picture could not be read.");
          continue;
        }
        if (bytes.byteLength === 0) {
          continue;
        }
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          setNote(
            `The pasted picture is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
          );
          continue;
        }
        try {
          const attachment = await invoke("session.savePastedImage", {
            mimeType: mime,
            dataBase64: encodeBase64(bytes),
            ...(file.name ? { fileName: file.name } : {}),
          });
          saved.push(attachment);
        } catch (error) {
          setNote(describeError(error));
        }
      }
      if (saved.length > 0) {
        // Functional update: `add` closes over `files`, so a direct paste
        // attachment added above would be lost when this resolves later.
        setFiles((current) => {
          const known = new Set(current.map((file) => file.path));
          const fresh = saved.filter((file) => !known.has(file.path));
          return [...current, ...fresh].slice(0, MAX_FILES);
        });
      }
      inputRef.current?.focus();
    })();
  };

  // A new draft key (another session) swaps the box to that key's text;
  // the previous key's text already lives in the store via the effect below.
  useEffect(() => {
    const key = draftKey ?? null;
    if (key !== draftKeyRef.current) {
      draftKeyRef.current = key;
      setText(key ? (useWorkbench.getState().drafts[key] ?? "") : "");
      setFiles([]);
      setNote(null);
    }
  }, [draftKey]);

  // Every keystroke lands in the per-session store (mirrored to
  // localStorage), so leaving the session never loses it.
  useEffect(() => {
    if (!draftKey) {
      return;
    }
    // Skip the write when the store already holds this text (e.g. it just
    // fed us on a key swap); otherwise each restore would rewrite storage.
    if (useWorkbench.getState().drafts[draftKey] !== text) {
      setDraft(draftKey, text);
    }
  }, [draftKey, text, setDraft]);

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
    if (draftKey) {
      clearDraft(draftKey);
    }
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
          onPaste={paste}
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

/** Only the picture formats the tools read; "image/jpg" is a common alias. */
function normalizePastedMime(
  mimeType: string,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (mimeType === "image/png") {
    return "image/png";
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return "image/jpeg";
  }
  if (mimeType === "image/gif") {
    return "image/gif";
  }
  if (mimeType === "image/webp") {
    return "image/webp";
  }
  return null;
}

/** Base64 without blowing the stack on multi-megabyte screenshots. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
