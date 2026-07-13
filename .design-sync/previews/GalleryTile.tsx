import { Surface, GalleryTile, Badge } from "@uploads/ui";

// Inline SVG data-URIs so the previews are fully self-contained (no network).
const shot = (label: string, bg: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'><rect width='320' height='200' fill='${bg}'/><rect x='16' y='16' width='288' height='28' rx='5' fill='#232327'/><rect x='16' y='60' width='180' height='12' rx='3' fill='#2c2c31'/><rect x='16' y='84' width='240' height='12' rx='3' fill='#2c2c31'/><text x='16' y='180' fill='#b794ff' font-family='monospace' font-size='13'>${label}</text></svg>`,
  );

/** A single hosted screenshot tile with metadata and a visibility badge. */
export function Default() {
  return (
    <Surface style={{ padding: 28, width: 300 }}>
      <GalleryTile
        name="dashboard-before.png"
        src={shot("before", "#0d0d0f")}
        meta="248 KB · 1440×900"
        trailing={
          <Badge tone="ok" dot>
            public
          </Badge>
        }
      />
    </Surface>
  );
}

/** A gallery grid — the /g page for a workspace. */
export function Grid() {
  return (
    <Surface style={{ padding: 28, width: 560 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <GalleryTile
          name="dashboard-before.png"
          src={shot("before", "#0d0d0f")}
          meta="248 KB"
          trailing={<Badge tone="ok">png</Badge>}
        />
        <GalleryTile
          name="dashboard-after.png"
          src={shot("after", "#101014")}
          meta="262 KB"
          trailing={<Badge tone="accent">png</Badge>}
        />
      </div>
    </Surface>
  );
}

/** The placeholder state when no thumbnail is available. */
export function NoImage() {
  return (
    <Surface style={{ padding: 28, width: 300 }}>
      <GalleryTile name="build-log.txt" meta="12 KB · text" trailing={<Badge>txt</Badge>} />
    </Surface>
  );
}
