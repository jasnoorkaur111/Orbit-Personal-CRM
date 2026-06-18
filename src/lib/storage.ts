// Safe localStorage wrappers — Safari private mode + locked-down storage
// throw SecurityError on access. Every direct localStorage usage in the app
// should go through these.

export function getStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

export function setStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function removeStorage(key: string): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export function getStorageJSON<T>(key: string, fallback: T): T {
  const raw = getStorage(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
