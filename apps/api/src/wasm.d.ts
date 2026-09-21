/** Wrangler compiles `*.wasm` imports to a WebAssembly.Module. */
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
