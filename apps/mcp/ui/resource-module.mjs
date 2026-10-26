import { createHash } from "node:crypto";

// A family freezes the tools the UI may call. Add a family for incompatible changes,
// including new UI tool calls that an older chat's trusted catalog may not contain.
const compatibility = "c1";

export function resourceModule(html) {
  const buildHash = createHash("sha256").update(html, "utf8").digest("hex");
  const prefix = `ui://uploads/media/${compatibility}/`;
  const metadata = {
    buildHash,
    legacyBuildHash: createHash("sha256")
      .update(html.replace("<html", '<html data-uploads-tool-catalog="staged-v1"'), "utf8")
      .digest("hex"),
    compatibility,
    resourceUri: `${prefix}${buildHash}.html`,
    resourceTemplate: `${prefix}{buildHash}.html`,
  };
  return (
    Object.entries(metadata)
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
      .join("\n") + `\nexport default ${JSON.stringify(html)};\n`
  );
}
