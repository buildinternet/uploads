/**
 * Argument helpers shared by the stdio MCP tool set (./tools.ts) and the
 * remote worker's tool set (apps/mcp). Runtime-agnostic — usable from
 * Workers as well as Node.
 */
import { UploadsError } from "../errors.js";

export type ToolArgs = Record<string, unknown>;

export function usage(msg: string): never {
  throw new UploadsError(msg, "USAGE");
}

export function optString(args: ToolArgs, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") usage(`${name} must be a string`);
  return v;
}

export function optPosInt(args: ToolArgs, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    usage(`${name} must be a positive integer`);
  }
  return v;
}
