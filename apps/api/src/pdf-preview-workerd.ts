/**
 * Workerd-only PDFium startup.
 *
 * clawpdf's Emscripten glue treats `nodejs_compat` as Node and then
 * `createRequire(import.meta.url)`. Wrangler bundles that URL away, so the
 * Node branch throws. Hiding `process.versions.node` for the duration of
 * init, and presenting a WorkerGlobalScope, selects the worker branch.
 * The WASM module itself is a static import so Wrangler compiles it into
 * the API worker. This file is not imported by the MCP worker.
 */

import { createEngine, type PdfEngine } from "clawpdf";
import pdfiumWasm from "clawpdf/dist/vendor/pdfium.esm.wasm";

export function createBundledPdfEngine(maxRenderPixels: number): Promise<PdfEngine> {
  return withPdfiumWorkerEnv(() =>
    createEngine({
      maxRenderPixels,
      instantiateWasm(imports, receiveInstance) {
        const receive = receiveInstance as unknown as (
          instance: WebAssembly.Instance,
          module: WebAssembly.Module,
        ) => void;
        WebAssembly.instantiate(pdfiumWasm, imports)
          .then((instance) => {
            receive(instance, pdfiumWasm);
          })
          .catch((err: unknown) => {
            console.error({ event: "pdfium_instantiate_failed", err });
          });
        return {} as WebAssembly.Exports;
      },
    }),
  );
}

/** Emscripten only checks that this global exists. It never constructs it. */
function markerWorkerGlobalScope() {
  /* presence only */
}

async function withPdfiumWorkerEnv<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as typeof globalThis & {
    WorkerGlobalScope?: unknown;
    process?: NodeJS.Process;
  };
  const realProcess = g.process;
  const hadScope = "WorkerGlobalScope" in g;
  if (realProcess) {
    g.process = new Proxy(realProcess, {
      get(target, prop, receiver) {
        if (prop === "versions") {
          const versions = Reflect.get(target, "versions", receiver) as NodeJS.ProcessVersions;
          return { ...versions, node: undefined };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  if (!hadScope) {
    Object.defineProperty(g, "WorkerGlobalScope", {
      configurable: true,
      writable: true,
      value: markerWorkerGlobalScope,
    });
  }
  try {
    return await fn();
  } finally {
    if (realProcess) g.process = realProcess;
    if (!hadScope) delete g.WorkerGlobalScope;
  }
}
