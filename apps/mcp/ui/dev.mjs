import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const server = await createServer({
  root: fileURLToPath(new URL(".", import.meta.url)),
  configFile: false,
  envDir: false,
  plugins: [tailwindcss()],
  server: { host: "127.0.0.1", port: 4320, strictPort: true },
});
await server.listen();
console.log("Fixture-only UI preview: http://127.0.0.1:4320/preview.html");
