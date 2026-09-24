import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Boxes,
  CircleDot,
  Folder,
  MessageSquare,
  Sun,
  Tag,
  Terminal,
} from "lucide-react";
import type { IslandWidgetId, ModelInfo, ProviderSummary } from "@ai-workbench/shared";
import { THEMES } from "../lib/themes.js";
import { useWorkbench } from "../store/workbench.js";

const ISLAND_WIDGET_LABELS: Record<IslandWidgetId, string> = {
  needsAttention: "Needs attention",
  agentQuestion: "Agent question",
  activeAgents: "Active agents",
  teamProgress: "Team progress",
  providerUsage: "Usage",
  completedWork: "Completed work",
  errors: "Errors",
  connectionHealth: "Connection health",
  idle: "Idle",
};

function islandWidgetLabel(widget: IslandWidgetId): string {
  return ISLAND_WIDGET_LABELS[widget];
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  /** Shown in place of the group and searched with the label, e.g. a model's tool. */
  readonly detail?: string;
  readonly run: () => void | Promise<void>;
}

/**
 * Where a model entry comes from, in a few words: its tool, the upstream
 * provider the tool groups it under, and whether the name is one the tool
 * reported, one shipped with the application, or one the person added.
 */
function modelDetail(provider: ProviderSummary, model: ModelInfo): string {
  const parts = [provider.metadata.displayName];
  if (model.group && model.group.toLowerCase() !== provider.metadata.displayName.toLowerCase()) {
    parts.push(model.group);
  }
  if (model.source === "user") {
    parts.push("added by you");
  } else if (model.source === "profile") {
    parts.push("built-in name");
  }
  return parts.join(" · ");
}

/**
 * Command palette (spec §81). It is the keyboard path to everything the
 * sidebar and header expose, so no action depends on pointing at the right
 * pixel.
 */
export function CommandPalette(): JSX.Element | null {
  const open = useWorkbench((state) => state.paletteOpen);
  const setOpen = useWorkbench((state) => state.setPaletteOpen);
  const initialQuery = useWorkbench((state) => state.paletteQuery);
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
    // Every run reads the store when it executes, never when the list is
    // built, so a command kept open across state changes cannot act stale.
    const list: Command[] = [
      {
        id: "session.new",
        label: "New session",
        group: "Session",
        run: () => {
          const state = store.getState();
          void state.createSession({ name: `Session ${state.sessions.length + 1}` });
        },
      },
      {
        id: "workspace.new",
        label: "New workspace from folder",
        group: "Workspace",
        run: async () => {
          const state = store.getState();
          const path = await state.chooseDirectory();
          if (path) {
            const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
            await state.createWorkspace(name, path);
          }
        },
      },
      {
        id: "panel.terminal",
        label: "Open terminal",
        group: "Workspace",
        run: () => store.getState().setWorkspaceTab("terminal"),
      },
      {
        id: "panel.files",
        label: "Open files",
        group: "Workspace",
        run: () => store.getState().setWorkspaceTab("files"),
      },
      {
        id: "panel.changes",
        label: "Open changes",
        group: "Workspace",
        run: () => store.getState().setWorkspaceTab("changes"),
      },
      {
        id: "view.agents",
        label: "Show agents in terminals (Ctrl+Shift+A)",
        group: "Go to",
        run: () => store.getState().setWorkspaceMode("terminals"),
      },
      {
        id: "view.chat",
        label: "Show clean conversation (Ctrl+Shift+A)",
        group: "Go to",
        run: () => store.getState().setWorkspaceMode("chat"),
      },
      {
        id: "view.providers",
        label: "Open providers",
        group: "Go to",
        run: () => store.getState().setView("providers"),
      },
      {
        id: "view.usage",
        label: "Open usage",
        group: "Go to",
        run: () => store.getState().setView("usage"),
      },
      {
        id: "view.settings",
        label: "Open settings",
        group: "Go to",
        run: () => store.getState().setView("settings"),
      },
      {
        id: "usage.refresh",
        label: "Refresh provider usage",
        group: "Providers",
        run: () => {
          void store.getState().refreshUsage();
        },
      },
      // Every theme is one command away: "theme" lists them all.
      ...THEMES.filter((theme) => theme.id !== settings.theme).map((theme) => ({
        id: `theme.${theme.id}`,
        label: `Theme: ${theme.name}`,
        group: "Appearance",
        run: () => {
          void store.getState().updateSettings({ theme: theme.id });
        },
      })),
    ];

    // Reasoning effort lives here now that the header is crumbs + pills: only
    // the active tool's own options appear, and Default clears back to none.
    if (activeSessionId) {
      const activeSession = sessions.find((entry) => entry.id === activeSessionId);
      const activeProvider = providers.find(
        (entry) => entry.metadata.id === activeSession?.providerId,
      );
      for (const option of activeProvider?.metadata.effortOptions ?? []) {
        list.push({
          id: `effort.${option}`,
          label: `Reasoning effort: ${option}`,
          group: "Session",
          run: () => {
            void store.getState().setSessionRuntime({ reasoningEffort: option });
          },
        });
      }
      if ((activeProvider?.metadata.effortOptions ?? []).length > 0) {
        list.push({
          id: "effort.default",
          label: "Reasoning effort: default",
          group: "Session",
          run: () => {
            void store.getState().setSessionRuntime({ reasoningEffort: null });
          },
        });
      }
    }

    // The Status Island is reachable from the keyboard as well as by click
    // and scroll (spec §81, §100).
    const island = settings.statusIsland;
    list.push(
      {
        id: "island.toggle",
        label: island.enabled ? "Hide Status Island" : "Show Status Island",
        group: "Status Island",
        run: () => {
          const state = store.getState();
          void state.setIslandPreferences({ enabled: !state.settings.statusIsland.enabled });
        },
      },
      {
        id: "island.cycle",
        label: "Cycle Status Island widget",
        group: "Status Island",
        run: () => {
          void store.getState().cycleIslandWidget(1);
        },
      },
    );
    if (island.pinnedWidget !== null) {
      list.push({
        id: "island.automatic",
        label: "Status Island: automatic",
        group: "Status Island",
        run: () => {
          void store.getState().pinIslandWidget(null);
        },
      });
    }
    for (const widget of island.enabledWidgets) {
      if (widget === island.pinnedWidget) {
        continue;
      }
      list.push({
        id: `island.pin.${widget}`,
        label: `Pin Status Island: ${islandWidgetLabel(widget)}`,
        group: "Status Island",
        run: () => {
          void store.getState().pinIslandWidget(widget);
        },
      });
    }

    if (activeSessionId) {
      list.push({
        id: "session.cancel",
        label: "Stop the current response",
        group: "Session",
        run: () => {
          void store.getState().cancel();
        },
      });
    }

    for (const workspace of workspaces) {
      list.push({
        id: `workspace.${workspace.id}`,
        label: `Switch to workspace: ${workspace.name}`,
        group: "Workspace",
        run: () => {
          void store.getState().selectWorkspace(workspace.id);
        },
      });
    }

    for (const session of sessions) {
      list.push({
        id: `session.${session.id}`,
        label: `Switch to session: ${session.name}`,
        group: "Session",
        run: () => {
          void store.getState().selectSession(session.id);
        },
      });
    }

    if (activeSessionId) {
      for (const provider of providers) {
        list.push({
          id: `provider.${provider.metadata.id}`,
          label: `Use provider: ${provider.metadata.displayName}`,
          group: "Providers",
          run: () => {
            const state = store.getState();
            const id = state.activeSessionId;
            if (id) {
              void state.updateSession({
                id,
                providerId: provider.metadata.id,
              });
            }
          },
        });
        if (!provider.capabilities.supported.includes("modelSelection")) {
          continue;
        }
        // Always one choice, even when the tool reported no models: its own
        // default, which is what runs when no model is named.
        list.push({
          id: `model.${provider.metadata.id}.default`,
          label: `Use model: ${provider.metadata.displayName} default`,
          group: "Models",
          run: () => {
            const state = store.getState();
            const id = state.activeSessionId;
            if (id) {
              void state.updateSession({ id, providerId: provider.metadata.id, modelId: null });
            }
          },
        });
        for (const model of provider.models) {
          list.push({
            id: `model.${provider.metadata.id}.${model.id}`,
            label: `Use model: ${model.displayName}`,
            group: "Models",
            detail: modelDetail(provider, model),
            run: () => {
              const state = store.getState();
              const id = state.activeSessionId;
              if (id) {
                void state.updateSession({
                  id,
                  providerId: provider.metadata.id,
                  modelId: model.id,
                });
              }
            },
          });
        }
        // Why the list is short, said where the list is used, and a way to
        // ask the tool again — for tools that report their models at all.
        const discovers =
          provider.modelsNote !== null || provider.models.some((model) => model.source === "provider");
        if (!discovers) {
          continue;
        }
        list.push({
          id: `models.rescan.${provider.metadata.id}`,
          label: provider.modelsNote
            ? `Detect models again: ${provider.metadata.displayName} (${provider.modelsNote.slice(0, 90)})`
            : `Detect models again: ${provider.metadata.displayName}`,
          group: "Models",
          run: () => store.getState().rescanModels(provider.metadata.id),
        });
      }
    }

    // Last on purpose: the palette lists only its first commands until
    // something is typed, and this must not push any of those out of view.
    list.push({
      id: "view.connections",
      label: "Open SSH connections",
      group: "Go to",
      run: () => {
        store.getState().setView("settings");
        // The connections live in a group of Settings; land on it rather than
        // on the top of a long screen.
        window.requestAnimationFrame(() =>
          document
            .querySelector('.setting-group[aria-label="Connections"]')
            ?.scrollIntoView({ block: "start" }),
        );
      },
    });

    return list;
  }, [
    store,
    workspaces,
    sessions,
    providers,
    settings.theme,
    settings.statusIsland,
    activeSessionId,
  ]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return commands.slice(0, 12);
    }
    // Session > action ordering is the registry order; the filter only
    // narrows, never re-ranks, so the grammar stays stable while typing.
    return commands
      .filter((command) =>
        `${command.label} ${command.detail ?? ""}`.toLowerCase().includes(needle),
      )
      .slice(0, 20);
  }, [commands, query]);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, Command[]>();
    for (const command of results) {
      const list = byGroup.get(command.group);
      if (list) {
        list.push(command);
      } else {
        byGroup.set(command.group, [command]);
        order.push(command.group);
      }
    }
    return order.map((group) => ({ group, items: byGroup.get(group) ?? [] }));
  }, [results]);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open, initialQuery]);

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
    >      <div className="palette" role="dialog" aria-label="Command palette" aria-modal="true">
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
            {grouped.map((section) => (
              <li key={section.group}>
                <p className="palette__grouphead">
                  {section.group}
                  <span className="palette__count">{section.items.length}</span>
                </p>
                <ul>
                  {section.items.map((command) => {
                    const position = results.indexOf(command);
                    return (
                      <li key={command.id}>
                        <button
                          type="button"
                          className="palette__item"
                          role="option"
                          aria-selected={position === index}
                          onMouseEnter={() => setIndex(position)}
                          onClick={() => void run(command)}
                        >
                          <span className="palette__icon" aria-hidden="true">
                            <GroupIcon group={command.group} />
                          </span>
                          <span className="row__text">
                            <Highlight label={command.label} needle={query.trim()} />
                          </span>
                          <span className="palette__group">{command.detail ?? command.group}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd className="kbd">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> run
          </span>
          <span>
            <kbd className="kbd">esc</kbd> dismiss
          </span>
        </div>
      </div>
    </div>
  );
}

function GroupIcon({ group }: { readonly group: string }): JSX.Element {
  const size = 14;
  const width = { strokeWidth: 1.75 } as const;
  switch (group) {
    case "Session":
      return <MessageSquare size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Workspace":
      return <Folder size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Go to":
      return <ArrowRight size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Providers":
      return <Boxes size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Models":
      return <Tag size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Appearance":
      return <Sun size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    case "Status Island":
      return <CircleDot size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
    default:
      return <Terminal size={size} strokeWidth={width.strokeWidth} aria-hidden="true" />;
  }
}

/** Bold accent match for the typed substring; plain text when there is none. */
function Highlight({
  label,
  needle,
}: {
  readonly label: string;
  readonly needle: string;
}): JSX.Element {
  const position = needle.length === 0 ? -1 : label.toLowerCase().indexOf(needle.toLowerCase());
  if (position < 0) {
    return <>{label}</>;
  }
  return (
    <>
      {label.slice(0, position)}
      <mark className="palette__mark">{label.slice(position, position + needle.length)}</mark>
      {label.slice(position + needle.length)}
    </>
  );
}
