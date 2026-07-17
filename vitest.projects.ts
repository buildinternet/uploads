import { defineConfig } from "vitest/config";

// Unified test runner for the whole monorepo. Each workspace package is a
// Vitest "project" so the entire suite runs in a single process with one shared
// worker pool — instead of N serial `pnpm --filter … test` invocations, each
// paying its own pnpm-resolution + Vitest cold-start. The glob auto-discovers
// any package that gains tests, so new suites can't silently fall out of CI the
// way apps/web, packages/email, and packages/errors previously did.
//
// Filename is deliberately NOT `vitest.config.ts`: Vitest searches parent
// directories for a config, so a root `vitest.config.ts` would hijack every
// per-package `pnpm --filter <pkg> test` run (documented in AGENTS.md) and try
// to resolve these repo-root globs against the package's cwd. Only `pnpm test`
// at the root loads this file, via `--config vitest.projects.ts`; per-package
// runs are unaffected and keep using Vitest defaults, as before.
//
// Packages carry no per-package Vitest config and rely on defaults (node
// environment, TS via esbuild); resolving each project against its own root
// keeps workspace-package imports (e.g. `@uploads/api/workspace`) working.
//
// Note: `apps/mcp` imports `@buildinternet/uploads` from its built `dist/`, so
// the root `pretest` script builds that package before this runner starts.
export default defineConfig({
  test: {
    // Negation excludes stray files (e.g. `apps/README.md`) that the directory
    // globs would otherwise match — Vitest treats a matched *file* as a project
    // config and errors when it isn't one.
    projects: ["apps/*", "packages/*", "!**/*.md"],
  },
});
