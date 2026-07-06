import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Silently checks the configured updater endpoint for a newer release and, if
 * one exists, downloads + installs it and restarts the app. Called once on
 * startup (see src/main.tsx). Failures are swallowed so a missing network or a
 * transient manifest error never blocks the app from opening.
 */
export async function checkForUpdateAndApply(): Promise<void> {
  try {
    const update: Update | null = await check();
    if (!update) return;

    // No UI — the spec is "check on startup, restart automatically, no user
    // action required." Download the signed bundle, verify its signature
    // (handled by the updater plugin against the embedded public key), install,
    // and relaunch. The user simply sees the window come back on the new build.
    await update.downloadAndInstall();
    // Windows NSIS install exits the process before this returns.
    await relaunch();
  } catch (error) {
    // Keep failures out of the UI, but leave a breadcrumb for debugging.
    console.warn("[updater] automatic update failed:", error);
  }
}