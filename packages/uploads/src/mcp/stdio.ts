/** Stdio transport for the MCP server core (Node-only; the core itself is runtime-agnostic). */
import { createInterface } from "node:readline";
import { writeStdout } from "../io.js";
import type { McpServer } from "./server.js";

/** Serve the MCP protocol on stdin/stdout; resolves when stdin ends. */
export async function serveStdio(server: McpServer): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const out = await server.handleLine(line);
    if (out !== undefined) await writeStdout(out + "\n");
  }
}
