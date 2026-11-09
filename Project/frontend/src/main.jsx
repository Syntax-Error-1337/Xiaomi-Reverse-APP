import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
// Console-only global beacon (no backend change): render crashes are caught by
// ErrorBoundary; these listeners surface async/event-handler errors for debugging.
window.addEventListener("error", (e) => console.error("[pressid-error]", e?.error || e?.message));
window.addEventListener("unhandledrejection", (e) => console.error("[pressid-rejection]", e?.reason));

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const notify = () => window.dispatchEvent(new Event("pressid-sw-update"));
        if (reg.waiting) notify();
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) notify();
          });
        });
      })
      .catch(() => {});
  });
}
