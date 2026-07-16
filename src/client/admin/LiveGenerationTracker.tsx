import { useEffect, useMemo, useState } from "react";
import { Activity, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toWikiSegment } from "../wikiPath";
import { useLlmAdmin } from "./panes/LlmHostsPane";

interface QueueItem {
  slug: string;
  title: string;
  seq: number;
  queuedAt: number;
  startedAt?: number;
  waiting: number;
  workflow?: string;
  phase?: string;
  state?: "queued" | "processing" | "llm";
  hostId?: string;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(
    2,
    "0",
  )}`;
}

function phaseLabel(phase?: string): string {
  return phase
    ? phase.replace(/^[^.]+\./, "").replaceAll("_", " ")
    : "starting";
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

export function LiveGenerationTracker({
  items,
  onNavigate,
}: {
  items: QueueItem[];
  onNavigate: (slug: string) => void;
}) {
  const { data } = useLlmAdmin();
  const hosts = data?.hosts ?? [];
  const now = useNow(items.length > 0);

  const activeItems = useMemo(
    () => items.filter((item) => item.state !== "queued"),
    [items],
  );
  const queuedItems = useMemo(
    () => items.filter((item) => item.state === "queued"),
    [items],
  );
  const waitingClients = useMemo(
    () => items.reduce((sum, item) => sum + item.waiting, 0),
    [items],
  );

  return (
    <aside
      data-testid="live-generation-tracker"
      className="min-w-0 xl:sticky xl:top-3 xl:self-start"
    >
      <Card size="sm" className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-(--card-spacing)">
          <div className="flex min-w-0 items-center gap-2">
            <Activity aria-hidden className="text-muted-foreground" />
            <div className="min-w-0">
              <CardTitle>Live generation</CardTitle>
              <CardDescription>
                Hosts, active work, and waiting demand.
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant={activeItems.length ? "default" : "secondary"}>
              {activeItems.length} active
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-(--card-spacing)">
          <section aria-labelledby="tracker-hosts">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3
                id="tracker-hosts"
                className="m-0 flex items-center gap-1.5 text-xs font-semibold"
              >
                <Server aria-hidden />
                Hosts
              </h3>
              <span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">
                {hosts.length} configured
              </span>
            </div>
            <Table
              containerClassName="rounded-md border border-border"
              className="text-[0.7rem] [&_td]:px-2 [&_td]:py-1.5 [&_th]:h-7 [&_th]:px-2"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Load</TableHead>
                  <TableHead className="text-right">Queue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hosts.length ? (
                  hosts.map((host) => (
                    <TableRow key={host.id}>
                      <TableCell className="font-mono">
                        <span
                          className="mr-1"
                          aria-label={host.online ? "online" : "offline"}
                        >
                          {host.online ? "●" : "○"}
                        </span>
                        {host.id}
                      </TableCell>
                      <TableCell
                        className="max-w-28 truncate font-mono"
                        title={
                          host.activeJobs?.[0]?.model ??
                          host.models?.join(", ") ??
                          undefined
                        }
                      >
                        {host.activeJobs?.[0]?.model ?? host.models?.[0] ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {host.active}/{host.max_in_flight}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {host.queued}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-muted-foreground italic"
                    >
                      Host status unavailable.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>

          <section aria-labelledby="tracker-active">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="tracker-active" className="m-0 text-xs font-semibold">
                Active generation
              </h3>
              <span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">
                {waitingClients} waiting clients
              </span>
            </div>
            {activeItems.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {activeItems.map((active) => (
                  <li
                    key={`${active.slug}:${active.seq}`}
                    className="rounded-md border border-border"
                  >
                    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] text-xs [&_dd]:m-0 [&_dd]:truncate [&_dd]:border-b [&_dd]:border-border [&_dd]:px-2 [&_dd]:py-1.5 [&_dd]:text-right [&_dt]:border-r [&_dt]:border-b [&_dt]:border-border [&_dt]:px-2 [&_dt]:py-1.5 [&_dt]:text-muted-foreground [&>*:nth-last-child(-n+2)]:border-b-0">
                      <dt>Article</dt>
                      <dd>
                        <a
                          href={`/wiki/${toWikiSegment(active.title)}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onNavigate(toWikiSegment(active.title));
                          }}
                        >
                          {active.title}
                        </a>
                      </dd>
                      <dt>Workflow</dt>
                      <dd className="font-mono">
                        {active.workflow ?? "article"}
                      </dd>
                      <dt>Phase</dt>
                      <dd className="font-mono">{phaseLabel(active.phase)}</dd>
                      <dt>Host</dt>
                      <dd className="font-mono">{active.hostId ?? "—"}</dd>
                      <dt>Elapsed</dt>
                      <dd className="font-mono tabular-nums">
                        {formatElapsed(
                          now - (active.startedAt ?? active.queuedAt),
                        )}
                      </dd>
                    </dl>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground italic">
                No active generation.
              </p>
            )}
          </section>

          <section aria-labelledby="tracker-queue">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="tracker-queue" className="m-0 text-xs font-semibold">
                Queued jobs
              </h3>
              <Badge variant="secondary">{queuedItems.length} queued</Badge>
            </div>
            {queuedItems.length ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {queuedItems.slice(0, 6).map((item) => (
                  <li
                    key={`${item.slug}:${item.seq}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
                  >
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">
                      {formatElapsed(now - item.queuedAt)}
                    </span>
                    <span className="col-span-2 truncate font-mono text-[0.68rem] text-muted-foreground">
                      {item.workflow ?? "article"} · {phaseLabel(item.phase)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-xs text-muted-foreground italic">
                No queued jobs.
              </p>
            )}
          </section>
        </CardContent>
      </Card>
    </aside>
  );
}
