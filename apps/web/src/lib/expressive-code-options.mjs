/**
 * Expressive Code presentation for the site's fenced code blocks.
 *
 * The palette is dark by construction (see packages/ui/src/tokens.css), so a
 * single dark theme is configured rather than a light/dark pair — `vitesse-dark`
 * is the theme the hand-rolled `<Code>` YAML example on /docs/comment-config
 * already used, so highlighting stays continuous across the migration.
 *
 * `styleOverrides` maps Expressive Code's own settings onto the site's design
 * tokens (panel surface, hairline border, mono face, meta type size) so a code
 * block reads as the same primitive the old `.cmd` / `.block` markup produced.
 * Frames are off by default: the docs pages showed bare panels, not terminal
 * chrome. `.doc` rules in DocsLayout.astro add the `$ ` prompt back for `bash`
 * blocks and hide the copy button on `ansi` (terminal output) blocks.
 *
 * @type {import("astro-expressive-code").AstroExpressiveCodeOptions}
 */
export const expressiveCodeOptions = {
  themes: ["vitesse-dark"],
  // The site has one theme; no media query or class selector to switch on.
  useDarkModeMediaQuery: false,
  defaultProps: {
    frame: "none",
    // Fenced blocks in the docs are short; wrapping beats a hidden scroll
    // region for prose-width commands with long flags.
    wrap: false,
    // One-line commands stay bare panels, but terminal output gets the full
    // terminal chrome so example output reads as a distinct artifact, not a
    // flat text box. Config/file examples opt into an editor frame per-fence
    // with `title="…" frame="code"`.
    overridesByLang: {
      ansi: { frame: "terminal" },
    },
  },
  styleOverrides: {
    borderColor: "var(--line)",
    borderRadius: "var(--radius-md)",
    borderWidth: "1px",
    codeBackground: "var(--panel)",
    codeFontFamily: "var(--mono)",
    codeFontSize: "var(--text-meta)",
    codeLineHeight: "1.6",
    codePaddingBlock: "12px",
    codePaddingInline: "14px",
    uiFontFamily: "var(--sans)",
    uiFontSize: "var(--text-micro)",
    focusBorder: "var(--accent)",
    frames: {
      shadowColor: "transparent",
      editorActiveTabIndicatorTopColor: "var(--accent)",
      editorActiveTabBackground: "var(--panel)",
      editorTabBarBackground: "var(--bg)",
      terminalBackground: "var(--panel)",
      terminalTitlebarBackground: "var(--bg)",
      terminalTitlebarForeground: "var(--muted)",
      terminalTitlebarBorderBottomColor: "var(--line)",
      inlineButtonBorder: "var(--line)",
      inlineButtonForeground: "var(--accent)",
      inlineButtonBackgroundActiveOpacity: "0.2",
      inlineButtonBackgroundHoverOrFocusOpacity: "0.12",
      tooltipSuccessBackground: "var(--green)",
      tooltipSuccessForeground: "var(--bg)",
    },
  },
};
