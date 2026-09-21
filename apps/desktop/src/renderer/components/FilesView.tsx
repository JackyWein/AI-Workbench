import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import type { DirectoryEntry, FileContents } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";

interface FilesViewProps {
  readonly sessionId: string;
  readonly onError: (message: string) => void;
}

/** Read-only workspace browser bounded to the session directory (spec §27). */
export function FilesView({ sessionId, onError }: FilesViewProps): JSX.Element {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [selected, setSelected] = useState<FileContents | null>(null);
  // Guards async loads against fast navigation: only the latest request may
  // write its result. Stale answers are dropped.
  const requestRef = useRef(0);

  const load = useCallback(
    async (next: string): Promise<void> => {
      const token = ++requestRef.current;
      try {
        const result = await invoke("files.list", { sessionId, path: next });
        if (requestRef.current !== token) {
          return;
        }
        setEntries(result);
        setPath(next);
      } catch (error) {
        if (requestRef.current !== token) {
          return;
        }
        onError(describeError(error));
      }
    },
    [sessionId, onError],
  );

  useEffect(() => {
    setSelected(null);
    void load("");
    // A session switch unmounts (keyed by session id), but the guard above
    // also drops answers that arrive after a newer request started.
  }, [load]);

  const open = async (entry: DirectoryEntry): Promise<void> => {
    if (entry.kind === "directory") {
      setSelected(null);
      await load(entry.path);
      return;
    }
    const token = ++requestRef.current;
    try {
      const contents = await invoke("files.read", { sessionId, path: entry.path });
      if (requestRef.current !== token) {
        return;
      }
      setSelected(contents);
    } catch (error) {
      if (requestRef.current !== token) {
        return;
      }
      onError(describeError(error));
    }
  };

  const segments = path.split("/").filter(Boolean);

  return (
    <div className="files">
      <div className="files__list">
        <nav className="files__breadcrumb" aria-label="Folder">
          <button type="button" className="files__crumb" onClick={() => void load("")}>
            Workspace
          </button>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`}>
              <ChevronRight size={11} strokeWidth={1.75} aria-hidden="true" />
              <button
                type="button"
                className="files__crumb"
                onClick={() => void load(segments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>

        {entries.length === 0 ? (
          <p className="files__empty">This folder is empty</p>
        ) : (
          <ul className="files__entries">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="files__entry"
                  aria-selected={selected?.path === entry.path}
                  onClick={() => void open(entry)}
                >
                  {entry.kind === "directory" ? (
                    <Folder size={13} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <File size={13} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <span className="row__text">{entry.name}</span>
                  {entry.kind === "file" ? (
                    <span className="row__meta">{formatSize(entry.size)}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="files__preview">
        {selected === null ? (
          <p className="files__empty">Select a file to preview it</p>
        ) : selected.binary ? (
          <p className="files__empty">
            {selected.path} is a binary file ({formatSize(selected.size)})
          </p>
        ) : (
          <>
            <p className="files__preview-head">
              {selected.path}
              {selected.truncated ? " · showing the beginning only" : ""}
            </p>
            <pre className="files__code">{selected.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
