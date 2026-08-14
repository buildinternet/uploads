import { Surface, Progress } from "@uploads/ui";

/** Two stacked quota meters — the shape of a workspace usage panel. */
export function Default() {
  return (
    <Surface style={{ padding: 28, width: 380 }}>
      <div className="ul-progress">
        <Progress label="Storage" detail="3.2 GB of 25 GB" value={3.2} max={25} />
        <Progress label="Uploads this month" detail="420 of 10,000" value={420} max={10000} />
      </div>
    </Surface>
  );
}

/** The fill bands: quiet below 85%, warm near the cap, accent when full. */
export function Levels() {
  return (
    <Surface style={{ padding: 28, width: 380 }}>
      <div className="ul-progress">
        <Progress label="Bandwidth" detail="12 GB of 100 GB" value={12} max={100} />
        <Progress label="Storage" detail="22.4 GB of 25 GB" value={22.4} max={25} />
        <Progress label="Seats" detail="5 of 5" value={5} max={5} />
      </div>
    </Surface>
  );
}

/** Percentage mode — omit `max` and the bar reads 0–100. */
export function Percentage() {
  return (
    <Surface style={{ padding: 28, width: 380 }}>
      <Progress label="Upload progress" detail="68%" value={68} />
    </Surface>
  );
}
