import { writeFile } from "node:fs/promises";

const [mode, path] = process.argv.slice(2);
const targets = await fetch("http://127.0.0.1:9231/json").then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.endsWith("/index.html") && !item.url.includes("/island/"));
if (!target) throw new Error("Main renderer target not found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const response = JSON.parse(event.data);
  const handle = pending.get(response.id);
  if (!handle) return;
  pending.delete(response.id);
  if (response.error) handle.reject(new Error(response.error.message)); else handle.resolve(response.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
try {
  let value;
  if (mode === "obsidian") {
    value = await evaluate("(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Obsidian'); button?.click(); return Boolean(button); })()");
  } else if (mode === "refresh") {
    value = await evaluate("(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh'); button?.click(); return Boolean(button); })()");
  } else if (mode === "theme-light") {
    value = await evaluate("(async () => { for(let i=0;i<3;i++){ const button=document.querySelector('.mode-toggle-button'); if(button?.dataset.mode==='light') break; button?.click(); await new Promise(r=>setTimeout(r,250)); } return document.documentElement.dataset.theme; })()");
  } else if (mode === "theme-dark") {
    value = await evaluate("(async () => { for(let i=0;i<3;i++){ const button=document.querySelector('.mode-toggle-button'); if(button?.dataset.mode==='dark') break; button?.click(); await new Promise(r=>setTimeout(r,250)); } return document.documentElement.dataset.theme; })()");
  } else if (mode === "maximize") {
    value = await evaluate("document.querySelector('button[aria-label=\"Maximize window\"]')?.click() ?? true");
  } else if (mode === "restore") {
    value = await evaluate("document.querySelector('button[aria-label=\"Restore window\"]')?.click() ?? true");
  } else if (mode === "state") {
    value = await evaluate("({ theme: document.documentElement.dataset.theme, titlebar: Boolean(document.querySelector('.titlebar')), heading: document.querySelector('.view__title')?.textContent, nodes: document.querySelectorAll('.memory-view__node').length, links: document.querySelectorAll('.memory-view__edge').length, storage: document.querySelector('.memory-view__summary-head strong')?.textContent, integration: document.querySelector('.memory-view__integration')?.textContent, controls: [...document.querySelectorAll('.titlebar__actions button')].map(b => b.getAttribute('aria-label')), window: { width: innerWidth, height: innerHeight } })");
  } else if (mode === "debug") {
    value = await evaluate("({ body: document.body.innerText.slice(0, 1000), url: location.href, ready: document.readyState })");
  } else if (mode === "probe") {
    value = await evaluate("Promise.all(['workspace.list','provider.list','settings.get','provider.getUsage','provider.getConfigs'].map(async channel => [channel, await Promise.race([window.workbench.invoke(channel, undefined).then(() => 'done', () => 'error'), new Promise(resolve => setTimeout(() => resolve('waiting'), 3000))])]))");
  } else if (mode === "memory-config") {
    value = await evaluate("window.workbench.invoke('mcp.list', undefined).then(rows => { const item=rows.find(row=>row.id==='obsidian-memory'); return item ? { command:item.command,args:item.args,cwd:item.cwd,envKeys:Object.keys(item.env) } : null })");
  } else if (mode === "screenshot") {
    const captured = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path, Buffer.from(captured.data, "base64"));
    value = path;
  } else throw new Error("Unknown mode");
  console.log(JSON.stringify(value));
} finally {
  socket.close();
}
