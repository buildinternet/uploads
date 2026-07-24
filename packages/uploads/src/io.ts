/** Backpressure-aware stdout helpers shared by the CLI commands and the stdio MCP transport. */

export async function writeStdout(text: string): Promise<void> {
  if (!process.stdout.write(text)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

export async function writeJson(value: unknown): Promise<void> {
  await writeStdout(JSON.stringify(value, null, 2) + "\n");
}

/** Reads stdin to end as UTF-8 (the `--flag -` convention). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
