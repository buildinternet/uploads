/** Fit avoids enlarging narrow screenshots; only a saved full-width choice opts in. */
export type ImagePreviewMode = "fit" | "full";

export function resolvePreviewMode(saved: string | null): ImagePreviewMode {
  return saved === "full" ? "full" : "fit";
}
