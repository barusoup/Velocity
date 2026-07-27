import { version } from "../package.json";

const VERSION_KEY = "velocity-app-version";

export function isAppVersionChanged(): boolean {
  try {
    const stored = localStorage.getItem(VERSION_KEY);
    if (stored !== version) {
      localStorage.setItem(VERSION_KEY, version);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
