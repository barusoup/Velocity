import { invoke } from "@tauri-apps/api/core";

const VELOCITY_PREFIX = "velocity-";
let _initialized = false;

function isVelocityKey(key: string): boolean {
  return key.startsWith(VELOCITY_PREFIX);
}

export async function init(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  try {
    const data = await invoke<Record<string, string>>("load_all_user_data");
    for (const [key, value] of Object.entries(data)) {
      localStorage.setItem(key, value);
    }
  } catch {
    // File doesn't exist yet — first run
  }
}

export function getItem(key: string): string | null {
  return localStorage.getItem(key);
}

export function setItem(key: string, value: string): void {
  localStorage.setItem(key, value);
  if (isVelocityKey(key)) {
    invoke("write_user_data", { key, data: value }).catch(() => {});
  }
}

export function removeItem(key: string): void {
  localStorage.removeItem(key);
  if (isVelocityKey(key)) {
    invoke("delete_user_data", { key }).catch(() => {});
  }
}

export async function clearAll(): Promise<void> {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isVelocityKey(k)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  await invoke("clear_all_user_data_backend");
}
