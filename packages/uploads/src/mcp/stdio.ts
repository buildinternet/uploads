/** Stdio transport for the MCP server core (Node-only; the core itself is runtime-agnostic). */
import { createInterface } from "node:readline";
import type { McpServer } from "./server.js";

async function writeStdout(text: string): Promise<void> {
  if (!process.stdout.write(text)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

/** Serve the MCP protocol on stdin/stdout; resolves when stdin ends. */
export async function serveStdio(server: McpServer): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const out = await server.handleLine(line);
    if (out !== undefined) await writeStdout(out + "\n");
  }
}
