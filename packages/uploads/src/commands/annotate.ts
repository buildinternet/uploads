import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, dirname } from "node:path";
import sharp from "sharp";
import {
  expandFlagAliases,
  extractDashValue,
  flagInt,
  flagString,
  parseCommandArgs,
  UsageError,
} from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { readStdin, writeJson, writeStdout } from "../io.js";

const ANNOTATE_HELP = `uploads annotate <image> --spec <file|-> [options]

Bake hand-drawn boxes, arrows, labels, freeform strokes, and redactions onto
an existing image. image is a path to a local PNG/JPEG file. The spec is a
JSON document (see the annotate-screenshots skill for the full format);
pass a file path or "-" to read it from stdin.

Selector-bearing specs (annotations that point at a CSS selector instead of
pixel coordinates) are rejected here — selectors can only be resolved
against a live page, via "uploads screenshot --annotate".

Options:
  --spec <file|->    JSON annotation spec (required)
  -o, --out <file>   Output PNG path (default: <stem>.annotated.png next to the image)
  --seed <n>         Fix the rough.js seed for deterministic sketchy rendering (default: 7)
  --format human|json  Output format (default: human)

Exit codes: 0 ok · 1 invalid spec · 2 usage.

Examples:
  uploads annotate ./shot.png --spec ./callouts.json
  cat ./callouts.json | uploads annotate ./shot.png --spec -
  uploads annotate ./shot.png --spec ./callouts.json --out ./shot.marked.png
`;

function defaultOutPath(imagePath: string): string {
  const ext = extname(imagePath);
  const stem = ext ? basename(imagePath, ext) : basename(imagePath);
  return join(dirname(imagePath), `${stem}.annotated.png`);
}

export async function runAnnotate(
  args: string[],
  help = false,
  /** Injectable for tests — avoids depending on a real stdin stream. */
  readStdinImpl: () => Promise<string> = readStdin,
): Promise<number> {
  if (help) {
    writeCommandHelp(ANNOTATE_HELP);
    return 0;
  }
  const { args: preArgs, dash: specFromDash } = extractDashValue(
    expandFlagAliases(args, { "-o": "--out" }),
    "--spec",
  );

  const parsed = parseCommandArgs(preArgs);
  if (parsed.help) {
    writeCommandHelp(ANNOTATE_HELP);
    return 0;
  }

  const imagePath = parsed.positionals[0];
  if (!imagePath) {
    throw new UsageError("annotate requires an image path", {
      example: "uploads annotate ./shot.png --spec ./callouts.json",
    });
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("annotate takes exactly one image argument");
  }

  const specArg = specFromDash ? "-" : flagString(parsed.flags, "--spec");
  if (!specArg) {
    throw new UsageError("--spec is required (a file path or - for stdin)");
  }
  const outFlag = flagString(parsed.flags, "--out");
  const seed = flagInt(parsed.flags, "--seed", "--seed");
  const format = flagString(parsed.flags, "--format");
  if (format && format !== "human" && format !== "json") {
    throw new UsageError(`invalid --format: ${format} (use human or json)`);
  }
  const wantJson = format === "json";

  let specText: string;
  if (specArg === "-") {
    specText = await readStdinImpl();
  } else {
    try {
      specText = readFileSync(specArg, "utf8");
    } catch (err) {
      throw new UsageError(
        `could not read --spec ${specArg}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { validateSpec, hasSelectors, renderAnnotations, clampReport, AnnotateSpecError } =
    await import("../annotate/index.js");

  let specJson: unknown;
  try {
    specJson = JSON.parse(specText);
  } catch (err) {
    await writeStdout("");
    process.stderr.write(
      `spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  let spec: Awaited<ReturnType<typeof validateSpec>>;
  try {
    spec = validateSpec(specJson);
  } catch (err) {
    if (err instanceof AnnotateSpecError) {
      for (const e of err.errors) {
        const prefix = e.index === null ? "spec" : `annotations[${e.index}]`;
        process.stderr.write(`${prefix}: ${e.message}\n`);
      }
      return 1;
    }
    throw err;
  }

  if (hasSelectors(spec)) {
    throw new UsageError(
      'annotate works on pixels; selectors need "uploads screenshot --annotate" (live page required)',
    );
  }

  const image = readFileSync(imagePath);
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const warnings = clampReport(spec, width, height);
  for (const w of warnings) process.stderr.write(`${w}\n`);

  const rendered = await renderAnnotations(image, spec, seed !== undefined ? { seed } : undefined);
  const outPath = outFlag ?? defaultOutPath(imagePath);
  writeFileSync(outPath, rendered);

  if (wantJson) {
    await writeJson({ out: outPath, width, height, warnings });
  } else {
    await writeStdout(`${outPath}\n`);
  }

  return 0;
}
