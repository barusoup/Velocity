import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { init } from "./storage";

document.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true },
);

// Tauri command failures are rejected promises.  A background operation (for
// example the automatic offline sync) must never turn an expected network
// failure into the webview's fatal "Unhandled Rejection" error page.  Feature
// code still owns its errors and should surface them where appropriate; this
// is the last-resort boundary for forgotten/background promises.
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  console.error("Unhandled background promise rejection", event.reason);
});

window.addEventListener("error", (event) => {
  // Keep ordinary runtime errors visible in the console without allowing a
  // browser/Tauri error overlay to replace the player UI.
  console.error("Unhandled runtime error", event.error ?? event.message);
});

async function boot() {
  // Start fetching the application graph while the backend hydrates
  // persisted state. App is still mounted only after init completes, so no
  // consumer can observe partially hydrated storage, but the two independent
  // startup costs no longer serialize behind one another.
  const appModule = import("./App");

  try {
    await init();
  } catch {
    // Silently continue — localStorage fallback is always available
  }

  // One-time migration: purge any persisted lyrics from bad regional providers
  // (Kugou / QQ / NetEase) cached before the clean-provider restriction.
  // Keeps the app from flashing stale poor LRC on first paint after update.
  try {
    const { purgeBadPersistedLyrics } = await import("./api");
    purgeBadPersistedLyrics();
  } catch {
    // best-effort
  }

  // Pre-warm daily recommendations in parallel with module loading if needed
  try {
    const { getSettings } = await import("./settings");
    const { needsDailyRecommendationRefresh, getCachedDailyRecommendations } = await import(
      "./taste-profile"
    );
    const settings = getSettings();
    if (
      settings.showHomeMenu &&
      settings.showHomeTodaysPicks &&
      needsDailyRecommendationRefresh() &&
      !getCachedDailyRecommendations()
    ) {
      const { generateDailyRecommendations } = await import("./utils/home-recommendations");
      void generateDailyRecommendations().catch(() => []);
    }
  } catch {
    // best-effort
  }

  const { default: App } = await appModule;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );

  // Startup auto-update runs in the Rust backend (see spawn_startup_updater in
  // src-tauri/src/main.rs) so it is not tied to the webview boot path.
}

boot();
