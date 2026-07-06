import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { init } from "./storage";

document.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true },
);

async function boot() {
  try {
    await init();
  } catch {
    // Silently continue — localStorage fallback is always available
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );

  // Startup auto-update runs in the Rust backend (see spawn_startup_updater in
  // src-tauri/src/main.rs) so it is not tied to the webview boot path.
}

boot();
