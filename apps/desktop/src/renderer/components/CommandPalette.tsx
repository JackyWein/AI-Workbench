import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { useWorkbench } from "../store/workbench.js";

interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly run: () => void | Promise<void>;
}

/**
 * Command palette (spec §81). It is the keyboard path to everything the
 * sidebar and header expose, so no action depends on pointing at the right
 * pixel.
 */
export function CommandPalette(): JSX.Element | null {
  const open = useWorkbench((state) => state.paletteOpen);
  const setOpen = useWorkbench((state) => state.setPaletteOpen);
  const workspaces = useWorkbench((state) => state.workspaces);
  const sessions = useWorkbench((state) => state.sessions);
  const providers = useWorkbench((state) => state.providers);
  const settings = useWorkbench((state) => state.settings);
  const activeSessionId = useWorkbench((state) => state.activeSessionId);

  const store = useWorkbench;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const state = store.getState();
    const list: Command[] = [
      {
        id: "session.new",
        label: "New session",
        group: "Session",
        run: () => state.createSession({ name: `Session ${sessions.length + 1}` }),
      },
      {
        id: "workspace.new",
        label: "New workspace from folder",
        group: "Workspace",
        run: async () => {
          const path = await state.chooseDirectory();
          if (path) {
            const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
            await state.createWorkspace(name, path);
          }
        },
      },
      {
        id: "view.providers",
        label: "Open providers",
        group: "Go to",
        run: () => state.setView("providers"),
      },
      {
        id: "view.settings",
        label: "Open settings",
        group: "Go to",
        run: () => state.setView("settings"),
      },
      {
        id: "usage.refresh",
        label: "Refresh provider usage",
        group: "Providers",
        run: () => state.refreshUsage(),
      },
      {
        id: "theme.toggle",
        label: `Switch theme to ${settings.theme === "dark" ? "light" : "dark"}`,
        group: "Appearance",
        run: () =>
          state.updateSettings({
            theme: settings.theme === "dark" ? "light" : "dark",
          }),
      },
    ];

    if (activeSessionId) {
      list.push({
        id: "session.cancel",
        label: "Stop the current response",
        group: "Session",
        run: () => state.cancel(),
      });
    }

    for (const workspace of workspaces) {
      list.push({
        id: `workspace.${workspace.id}`,
        label: `Switch to workspace: ${workspace.name}`,
        group: "Workspace",
        run: () => state.selectWorkspace(workspace.id),
      });
    }

    for (const session of sessions) {
      list.push({
        id: `session.${session.id}`,
        label: `Switch to session: ${session.name}`,
        group: "Session",
        run: () => state.selectSession(session.id),
      });
    }

    if (activeSessionId) {
      for (const provider of providers) {
        list.push({
          id: `provider.${provider.metadata.id}`,
          label: `Use provider: ${provider.metadata.displayName}`,
          group: "Providers",
          run: () =>
            state.updateSession({
              id: activeSessionId,
              providerId: provider.metadata.id,
            }),
        });
        for (const model of provider.models) {
          list.push({
            id: `model.${provider.metadata.id}.${model.id}`,
            label: `Use model: ${model.displayName}`,
            group: "Models",
            run: () =>
              state.updateSession({
                id: activeSessionId,
                providerId: provider.metadata.id,
                modelId: model.id,
              }),
          });
        }
      }
    }

    return list;
  }, [store, workspaces, sessions, providers, settings.theme, activeSessionId]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return commands.slice(0, 12);
    }
    return commands
      .filter((command) => command.label.toLowerCase().includes(needle))
      .slice(0, 20);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) {
    return null;
  }

  const run = async (command: Command | undefined): Promise<void> => {
    if (!command) {
      return;
    }
    setOpen(false);
    await command.run();
  };

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette" aria-modal="true">
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder="Search commands"
          aria-label="Search commands"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              void run(results[index]);
            }
          }}
        />

        {results.length === 0 ? (
          <p className="palette__empty">No matching command</p>
        ) : (
          <ul className="palette__list" role="listbox" aria-label="Commands">
            {results.map((command, position) => (
              <li key={command.id}>
                <button
                  type="button"
                  className="palette__item"
                  role="option"
                  aria-selected={position === index}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => void run(command)}
                >
                  <span className="row__text">{command.label}</span>
                  <span className="palette__group">{command.group}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
