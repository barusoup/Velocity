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

  // Fire-and-forget: check the public repo for a newer signed build and, if
  // found, download + install + relaunch. See src/updater.ts. Never blocks the
  // UI and never throws into the boot path.
  void import("./updater").then((m) => m.checkForUpdateAndApply()).catch(() => {});
}

boot();
