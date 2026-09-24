import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppCrashBoundary } from "./components/ErrorBoundary.js";
import { reportRendererError } from "./lib/error-reporting.js";
import "./app.css";
import "./themes.css";
import { applyRememberedAppearance } from "./lib/themes.js";

applyRememberedAppearance();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Renderer root element is missing");
}

// Errors nobody handled are kept in the application log, not only in the
// developer tools, so a problem that happened is still readable afterwards.
window.addEventListener("error", (event) => {
  console.error("[renderer:error]", event.error ?? event.message);
  reportRendererError("window:error", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer:unhandledrejection]", event.reason);
  reportRendererError("window:unhandledrejection", event.reason);
});

createRoot(container).render(
  <StrictMode>
    <AppCrashBoundary>
      <App />
    </AppCrashBoundary>
  </StrictMode>,
);
