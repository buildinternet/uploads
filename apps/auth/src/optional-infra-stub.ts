/**
 * Build-time stub for `@better-auth/infra`'s OPTIONAL dynamic imports.
 *
 * `@better-auth/infra` 0.4.x lazily `import()`s `@better-auth/scim` and
 * `@better-auth/sso` to power SCIM provisioning and SAML SSO. This worker
 * configures neither (see the `dash()` plugin in src/auth.ts — that's the only
 * infra feature we use), and neither package is installed. The Workers bundler
 * can't leave a bare dynamic import unresolved, so wrangler.jsonc `alias`es
 * both specifiers to this module.
 *
 * Because infra only reaches those imports when SCIM/SSO is actually
 * configured, this code never runs at runtime. The throwing proxy is
 * defence-in-depth: if a future change ever wires up SCIM/SSO without
 * installing the real packages, any access here fails loudly instead of
 * silently yielding `undefined`.
 */
const unsupported = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then") return undefined; // keep `await import(...)` well-behaved
      throw new Error(
        `@better-auth/infra optional module (SCIM/SSO) is not bundled in uploads-auth ` +
          `(accessed "${String(prop)}"). Neither feature is configured for this worker.`,
      );
    },
  },
);

export default unsupported;
