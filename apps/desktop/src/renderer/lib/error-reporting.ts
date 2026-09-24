/**
 * Hands an error the interface caught to the main process, which keeps it in
 * the application log and a crash report. Before this, renderer errors only
 * reached the developer tools and were gone once the window closed.
 *
 * Reporting must never become a failure of its own: it is best-effort,
 * bounded, and silent when the bridge is not there (tests, the island).
 */
const MAX_PER_MINUTE = 20;
let recent: number[] = [];
/** The same error repeating every frame is kept once. */
let lastSignature = "";

export function reportRendererError(source: string, error: unknown, componentStack?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const signature = `${source}|${message}|${stack?.split("\n")[1] ?? ""}`;
  if (signature === lastSignature) {
    return;
  }
  const now = Date.now();
  recent = recent.filter((at) => now - at < 60_000);
  if (recent.length >= MAX_PER_MINUTE) {
    return;
  }
  recent.push(now);
  lastSignature = signature;

  try {
    const bridge = (window as { workbench?: { invoke?: unknown } }).workbench;
    if (!bridge || typeof bridge.invoke !== "function") {
      return;
    }
    void window.workbench
      .invoke("app.reportError", {
        source: source.slice(0, 120),
        message: message.slice(0, 4000),
        ...(stack ? { stack: stack.slice(0, 20_000) } : {}),
        ...(componentStack ? { componentStack: componentStack.slice(0, 20_000) } : {}),
      })
      .catch(() => undefined);
  } catch {
    // Nothing more to do: the console already has it.
  }
}
