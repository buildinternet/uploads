/**
 * Isolated raw import of the CLI package's changeset-generated CHANGELOG.md.
 *
 * Kept in its own module so `changelog.ts`'s pure functions stay importable
 * from vitest without pulling in a Vite-only `?raw` import that vitest may
 * fail to resolve alongside the `astro:content` import.
 */
// Vite raw import — the monorepo checkout is present at build time.
import cliChangelogRaw from "../../../../packages/uploads/CHANGELOG.md?raw";

export { cliChangelogRaw };
