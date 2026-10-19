/**
 * The operator "Models" view (`/admin/models`): which OpenRouter model the
 * Slack app's mention agent runs. Reads and writes
 * `/admin-ui/models/slack-agent`; the picker lists models from
 * `/admin-ui/models/agent-options` (image input + tool calls, with prices).
 * uploads-slack reads the setting on each mention, so a save applies to the
 * next one.
 */
import { useMemo, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Skeleton } from "@uploads/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@uploads/ui/components/ui/table";
import "@uploads/ui/styles.css";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import { errMessage, makeAdminApi, type AgentModelOption } from "../../lib/admin-api";
import { ADMIN_BTN } from "../../lib/admin-ui";
import { lastUpdatedLabel } from "../../lib/workspace-screenshots";
import { INPUT_TEXT } from "./field-classes";
import { useAdminResource } from "./use-admin-resource";

export interface AdminModelsProps {
  apiOrigin: string;
}

/** Rows shown at once; the filter narrows the rest. */
const ROWS = 40;

function price(n: number | null): string {
  if (n === null) return "—";
  return n === 0 ? "free" : `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`;
}

function SlackAgentModel({ apiOrigin }: AdminModelsProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const setting = useAdminResource(() => api.getSlackAgentModel(), [api]);
  const options = useAdminResource(() => api.listAgentModelOptions(), [api]);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = setting.data;
  const byId = useMemo(
    () => new Map((options.data ?? []).map((o) => [o.id, o] as const)),
    [options.data],
  );
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = options.data ?? [];
    const hits = q
      ? all.filter((o) => o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
      : all;
    return hits.slice(0, ROWS);
  }, [filter, options.data]);

  async function save(model: string | null) {
    setSaving(true);
    setStatus(null);
    try {
      setting.setData(await api.saveSlackAgentModel(model));
      setStatus("Saved. The next mention uses it.");
    } catch (err) {
      setStatus(errMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  const currentOption = current ? byId.get(current.model) : undefined;
  const typed = filter.trim();
  const canUseTyped = typed.includes("/") && typed !== current?.model;

  return (
    <section className="grid gap-3 min-w-0" aria-labelledby="slack-agent-heading">
      <div className="grid gap-1 max-w-2xl">
        <h3
          id="slack-agent-heading"
          className="m-0 text-(length:--text-meta) font-semibold text-foreground"
        >
          Slack mention agent
        </h3>
        <p className="m-0 text-body text-(length:--text-micro) leading-[1.55] text-pretty">
          Answers @uploads.sh mentions in Slack. It needs a model that takes images and tool calls.
          Each mention runs a few calls, so input price matters most.
        </p>
      </div>

      {setting.error ? (
        <p className="m-0 text-destructive text-(length:--text-micro)">
          Couldn't load the setting.
        </p>
      ) : !current ? (
        <Skeleton className="h-12 w-full max-w-xl" />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-(length:--text-micro)">
          <code className="font-mono text-foreground">{current.model}</code>
          {current.isDefault ? (
            <Badge variant="secondary">Default</Badge>
          ) : (
            <span className="text-muted-foreground">
              Set by {current.updatedBy}
              {current.updatedAt ? `, ${lastUpdatedLabel(current.updatedAt, new Date())}` : ""}
            </span>
          )}
          {currentOption ? (
            <span className="text-muted-foreground tabular-nums">
              {price(currentOption.inputPerMillion)} in · {price(currentOption.outputPerMillion)}{" "}
              out per 1M tokens
            </span>
          ) : null}
          {!current.isDefault ? (
            <button
              type="button"
              className={ADMIN_BTN}
              disabled={saving}
              onClick={() => void save(null)}
            >
              Use default ({current.defaultModel})
            </button>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          id="slack-agent-model-filter"
          className={`${INPUT_TEXT} w-full max-w-sm`}
          placeholder="Filter, or type a model id like openai/gpt-6-luna"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter models"
        />
        {canUseTyped ? (
          <button
            type="button"
            className={ADMIN_BTN}
            disabled={saving}
            onClick={() => void save(typed)}
          >
            Use {typed}
          </button>
        ) : null}
        {status ? (
          <span className="text-(length:--text-micro) text-muted-foreground" role="status">
            {status}
          </span>
        ) : null}
      </div>

      {options.error ? (
        <p className="m-0 text-destructive text-(length:--text-micro)">
          Couldn't load OpenRouter's model list. You can still type a model id above.
        </p>
      ) : !options.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Input / 1M</TableHead>
                <TableHead className="text-right">Output / 1M</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((o: AgentModelOption) => (
                <TableRow key={o.id}>
                  <TableCell className="min-w-0">
                    <div className="grid">
                      <span className="text-foreground">{o.name}</span>
                      <code className="font-mono text-(length:--text-micro) text-muted-foreground">
                        {o.id}
                      </code>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {price(o.inputPerMillion)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {price(o.outputPerMillion)}
                  </TableCell>
                  <TableCell className="text-right">
                    {o.id === current?.model ? (
                      <Badge variant="secondary">In use</Badge>
                    ) : (
                      <button
                        type="button"
                        className={ADMIN_BTN}
                        disabled={saving}
                        onClick={() => void save(o.id)}
                      >
                        Use
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="m-0 mt-2 text-(length:--text-micro) text-muted-foreground">
            {options.data.length} models take images and tool calls, cheapest input first
            {shown.length < options.data.length ? `; showing ${shown.length}` : ""}. Prices are
            OpenRouter's list prices.
          </p>
        </div>
      )}
    </section>
  );
}

export function AdminModels(props: AdminModelsProps) {
  return (
    <IslandErrorBoundary>
      <SlackAgentModel {...props} />
    </IslandErrorBoundary>
  );
}
