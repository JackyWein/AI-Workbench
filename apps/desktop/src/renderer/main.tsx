import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./app.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Renderer root element is missing");
}

// Global renderer catch so an unhandled rejection never freezes silently:
// it surfaces as a toast via console + store error where possible.
window.addEventListener("error", (event) => {
  console.error("[renderer:error]", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer:unhandledrejection]", event.reason);
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
