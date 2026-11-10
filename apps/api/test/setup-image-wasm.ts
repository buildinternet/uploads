// The worker entry registers the image module; tests that skip the entry
// still need it for pHash, posters and PDF previews.
import { installImageWasm } from "../src/image-wasm-install";

installImageWasm();
