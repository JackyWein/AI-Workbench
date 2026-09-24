import { type JSX, useEffect, useMemo, useState } from "react";
import { BookOpen, FolderOpen, Network, RefreshCw } from "lucide-react";
import type { IpcOutput } from "@ai-workbench/shared";
import { describeError, invoke } from "../lib/client.js";
import { useWorkbench } from "../store/workbench.js";

type Overview = NonNullable<IpcOutput<"memory.inspect">>;
type Vault = Overview["vault"];

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? "KB" : bytes < 1024 ** 3 ? "MB" : "GB";
  const divisor = unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toFixed(bytes / divisor >= 10 ? 1 : 2)} ${unit}`;
}

interface Point { x: number; y: number }

/** Deterministic force layout for the bounded local graph. */
function graphLayout(vault: Vault): Map<string, Point> {
  const nodes = vault.nodes;
  const count = nodes.length;
  const points = nodes.map((_, index) => {
    const angle = index * 2.399963;
    const radius = 18 * Math.sqrt(index + 1);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  const indexes = new Map(nodes.map((node, index) => [node.path, index]));
  const pairs = vault.edges.flatMap((edge) => {
    const from = indexes.get(edge.from);
    const to = indexes.get(edge.to);
    return from === undefined || to === undefined ? [] : [[from, to] as const];
  });
  for (let step = 0; step < 75; step++) {
    for (let a = 0; a < count; a++) {
      const left = points[a];
      if (!left) continue;
      left.vx -= left.x * 0.006;
      left.vy -= left.y * 0.006;
      for (let b = a + 1; b < count; b++) {
        const right = points[b];
        if (!right) continue;
        const dx = left.x - right.x;
        const dy = left.y - right.y;
        const distance2 = Math.max(64, dx * dx + dy * dy);
        const force = 1100 / distance2;
        const distance = Math.sqrt(distance2);
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        left.vx += fx; left.vy += fy;
        right.vx -= fx; right.vy -= fy;
      }
    }
    for (const [from, to] of pairs) {
      const left = points[from];
      const right = points[to];
      if (!left || !right) continue;
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 35) * 0.012;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      left.vx += fx; left.vy += fy;
      right.vx -= fx; right.vy -= fy;
    }
    for (const point of points) {
      point.vx *= 0.72; point.vy *= 0.72;
      point.x += point.vx; point.y += point.vy;
    }
  }
  if (count === 0) return new Map();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(800 / Math.max(1, maxX - minX), 430 / Math.max(1, maxY - minY), 2);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return new Map(nodes.map((node, index) => [node.path, {
    x: 450 + ((points[index]?.x ?? 0) - centerX) * scale,
    y: 260 + ((points[index]?.y ?? 0) - centerY) * scale,
  }]));
}

export function ObsidianView(): JSX.Element {
  const chooseMemoryVault = useWorkbench((state) => state.chooseMemoryVault);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke("memory.inspect", undefined);
      setOverview(result);
      if (selected && !result?.vault.nodes.some((node) => node.path === selected)) setSelected(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); /* The vault is rescanned on entry or Refresh. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vault = overview?.vault;
  const positions = useMemo(() => vault ? graphLayout(vault) : new Map<string, Point>(), [vault]);
  const shown = useMemo(() => vault?.nodes.filter((node) =>
    `${node.title} ${node.path}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [], [vault, query]);
  const active = vault?.nodes.find((node) => node.path === selected) ?? null;
  const connected = selected ? vault?.edges.filter((edge) => edge.from === selected || edge.to === selected) ?? [] : [];

  const choose = async (): Promise<void> => {
    if (await chooseMemoryVault()) await refresh();
  };

  return (
    <div className="view">
      <div className="view__inner memory-view">
        <header className="view__header">
          <div className="view__heading">
            <h1 className="view__title">Obsidian memory</h1>
            <p className="view__lede">Your shared Markdown vault, indexed locally for agents and Obsidian.</p>
          </div>
          <div className="view__actions">
            <button type="button" className="ghost-button" onClick={() => void choose()}>
              <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
              {vault ? "Change vault" : "Choose vault"}
            </button>
            <button type="button" className="ghost-button" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={13} strokeWidth={1.75} className={loading ? "spin" : undefined} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </header>

        {error ? <p className="memory-view__error" role="alert">{error}</p> : null}
        {!vault && !loading ? (
          <div className="memory-view__empty">
            <Network size={25} strokeWidth={1.3} aria-hidden="true" />
            <h2>Choose a vault to see its memory map</h2>
            <p>The app will count local files and draw links between Markdown notes. No model request is needed.</p>
          </div>
        ) : null}
        {!vault && loading ? <p className="view__empty" role="status">Reading vault…</p> : null}
        {vault ? (
          <>
            <section className="memory-view__summary" aria-label="Vault storage">
              <div className="memory-view__summary-head">
                <div>
                  <span className="memory-view__eyebrow">Indexed storage</span>
                  <strong>{size(vault.totalBytes)}</strong>
                </div>
                <span className="memory-view__path" title={vault.path}>{vault.path}</span>
              </div>
              <div className="memory-view__storage" role="img" aria-label={`${size(vault.noteBytes)} in notes and ${size(vault.otherBytes)} in other files`}>
                <span style={{ width: `${vault.totalBytes ? vault.noteBytes / vault.totalBytes * 100 : 0}%` }} />
              </div>
              <div className="memory-view__facts">
                <span><BookOpen size={13} strokeWidth={1.7} aria-hidden="true" /> {vault.noteCount.toLocaleString()} notes · {size(vault.noteBytes)}</span>
                <span>{vault.otherCount.toLocaleString()} other files · {size(vault.otherBytes)}</span>
              </div>
              {vault.truncated ? <p className="field__description">The scan stopped at 20,000 files; sizes and counts shown are indexed totals.</p> : null}
            </section>

            <section className="memory-view__graph-section">
              <div className="memory-view__section-head">
                <div>
                  <h2>Note graph</h2>
                  <p>Connections come from Obsidian [[wiki links]] in the indexed notes.</p>
                </div>
                <span>{vault.nodes.length} nodes · {vault.edges.length} links</span>
              </div>
              <div className="memory-view__graph-layout">
                <div className="memory-view__graph">
                  {vault.nodes.length === 0 ? <p>No Markdown notes in this vault yet.</p> : (
                    <svg viewBox="0 0 900 520" role="img" aria-label="Graph of linked Markdown notes">
                      {vault.edges.map((edge, index) => {
                        const from = positions.get(edge.from), to = positions.get(edge.to);
                        return from && to ? <line key={`${edge.from}:${edge.to}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                          className={selected && (edge.from === selected || edge.to === selected) ? "memory-view__edge memory-view__edge--active" : "memory-view__edge"} /> : null;
                      })}
                      {vault.nodes.map((node) => {
                        const point = positions.get(node.path);
                        if (!point) return null;
                        return <g key={node.path} className={selected === node.path ? "memory-view__node memory-view__node--active" : "memory-view__node"}
                          onClick={() => setSelected(node.path)} tabIndex={0} role="button" aria-label={`Select ${node.title}`}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.path); } }}>
                          <circle cx={point.x} cy={point.y} r={selected === node.path ? 9 : 5.5} />
                          <title>{node.title}</title>
                          {selected === node.path ? <text x={point.x + 13} y={point.y + 4}>{node.title}</text> : null}
                        </g>;
                      })}
                    </svg>
                  )}
                </div>
                <aside className="memory-view__notes" aria-label="Indexed notes">
                  <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a note…" aria-label="Find a note" />
                  {active ? <div className="memory-view__selected"><strong>{active.title}</strong><span>{active.path}</span><small>{size(active.bytes)} · {connected.length} links</small></div> :
                    <p className="memory-view__hint">Select a note to inspect its links.</p>}
                  <div className="memory-view__list">
                    {shown.map((node) => <button key={node.path} type="button" aria-current={selected === node.path} onClick={() => setSelected(node.path)} title={node.path}>
                      <span>{node.title}</span><small>{size(node.bytes)}</small>
                    </button>)}
                    {shown.length === 0 ? <p>No matching notes.</p> : null}
                  </div>
                </aside>
              </div>
              {vault.graphTruncated ? <p className="field__description">The graph shows up to 180 notes and 500 links. Storage counts cover all indexed files.</p> : null}
            </section>
            <p className="memory-view__integration" data-state={overview.antigravity.state}>
              Antigravity: {overview.antigravity.detail} Its global MCP configuration also applies outside AI Workbench.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
