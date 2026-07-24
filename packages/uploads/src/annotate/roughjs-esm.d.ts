/**
 * roughjs's package.json "exports"/"types" don't resolve the bundled ESM
 * entry point under Node's ESM resolution, so we import the concrete file
 * directly (`roughjs/bundled/rough.esm.js`) and declare its shape here,
 * typed against roughjs's own `bundled/rough.d.ts`.
 */
declare module "roughjs/bundled/rough.esm.js" {
  import rough from "roughjs/bundled/rough.js";
  export default rough;
}
