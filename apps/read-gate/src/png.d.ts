/** Wrangler `Data` rule: an imported PNG is its bytes. */
declare module "*.png" {
  const bytes: ArrayBuffer;
  export default bytes;
}
