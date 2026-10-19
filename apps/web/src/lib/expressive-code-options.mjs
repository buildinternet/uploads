/**
 * Expressive Code presentation for the site's fenced code blocks.
 *
 * Two themes, renamed to `dark` and `light` so they follow the same
 * `data-theme` attribute the rest of the site uses. `vitesse-dark` stays the
 * base (no selector) so a block renders dark before the theme script runs.
 * The media query is off: an explicit Dark choice must not flip back to light
 * because the OS prefers light.
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
  themes: ["vitesse-dark", "vitesse-light"],
  useDarkModeMediaQuery: false,
  customizeTheme: (theme) => {
    theme.name = theme.type === "light" ? "light" : "dark";
  },
  defaultProps: {
    frame: "none",
    // Commands and config stay on one line each, so a wrapped flag never
    // reads as a new line of input; keep them short enough to fit the measure.
    wrap: false,
    // One-line commands stay bare panels, but terminal output gets the full
    // terminal chrome so example output reads as a distinct artifact, not a
    // flat text box. Output wraps: real output carries long storage URLs, and
    // a hidden scroll region hides the part worth reading. Config/file
    // examples opt into an editor frame per-fence with `title="…" frame="code"`.
    overridesByLang: {
      ansi: { frame: "terminal", wrap: true },
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
