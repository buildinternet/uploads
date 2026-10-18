/** Preferences are optional: blocked or unavailable storage must not break a viewer. */
export function readViewerPreference(key: string): string | null {
  try {
    return localStorage.getItem(`uploads:viewer:${key}`);
  } catch {
    return null;
  }
}

export function saveViewerPreference(key: string, value: string): void {
  try {
    localStorage.setItem(`uploads:viewer:${key}`, value);
  } catch {
    // Keep the current page usable when storage is unavailable.
  }
}
