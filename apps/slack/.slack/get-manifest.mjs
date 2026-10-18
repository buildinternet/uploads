// Slack CLI `get-manifest` hook: prints the checked-in manifest. The CLI
// appends flags like --source=…, which this script ignores.
import { readFileSync } from "node:fs";

process.stdout.write(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
