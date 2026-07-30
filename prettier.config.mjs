/**
 * Prettier is used only for `*.astro` — oxfmt has no Astro parser.
 * Keep option values aligned with `.oxfmtrc.json` so mixed edits feel consistent.
 *
 * Known prettier-plugin-astro limits (work around in source, don't widen ignore):
 * - `define:vars` inside a JSX-conditional expression fails to parse — hoist the
 *   script to top level and early-return.
 * - Function bodies / `=>` inside a JSX-conditional `<script>` fail — extract
 *   logic to a `.ts` module and keep an import-only shell in the `.astro` file.
 * - `<!-- prettier-ignore -->` can corrupt markup under this plugin — use
 *   explicit `{" "}` for intentional spaces instead of relying on ignore.
 */
/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-astro"],
  overrides: [
    {
      files: "*.astro",
      options: {
        parser: "astro",
      },
    },
  ],
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: "always",
  endOfLine: "lf",
};
