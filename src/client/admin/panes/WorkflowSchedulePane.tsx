import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toWikiSegment } from "../../wikiPath";

interface ScheduleSummary {
  id: string;
  label: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDetail: string | null;
  nextRunAt: number | null;
}

type ReviewQueueStatus = "pending" | "processing" | "done" | "error";

interface ReviewQueueItem {
  id: number;
  articleSlug: string;
  articleTitle: string;
  status: ReviewQueueStatus;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  verdict: string | null;
  passed: number | null;
  failed: number | null;
  resultJson: string | null;
  error: string | null;
}

interface ReviewResultItem {
  id: number;
  label: string;
  object: string;
  verdict: "pass" | "fail";
  reason: string;
  source: "deterministic" | "llm";
}

interface ReviewResultDetail {
  items: ReviewResultItem[];
  type: { suggestedType: string; verdict: "pass" | "fail"; reason: string; source: string } | null;
}

interface WorkflowSchedulesPayload {
  schedules: ScheduleSummary[];
  queue: ReviewQueueItem[];
}

interface WorkflowSchedulePaneProps {
  onNavigate: (slug: string) => void;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error || `request failed (${res.status})`);
  return payload;
}

function formatRelative(ms: number | null, now: number, suffix: string): string {
  if (ms === null) return "—";
  const deltaSec = Math.round((ms - now) / 1000);
  const abs = Math.abs(deltaSec);
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return deltaSec <= 0 ? `${unit} ago` : `in ${unit} ${suffix}`;
}

const STATUS_BADGE: Record<ReviewQueueStatus, "outline" | "secondary" | "default" | "destructive"> = {
  pending: "outline",
  processing: "default",
  done: "secondary",
  error: "destructive",
};

const VERDICT_BADGE: Record<string, "secondary" | "warn" | "destructive"> = {
  pass: "secondary",
  partial: "warn",
  fail: "destructive",
};

function QueueItemRow({
  item,
  onNavigate,
  dividerAbove,
}: {
  item: ReviewQueueItem;
  onNavigate: (slug: string) => void;
  /** Marks the first completed row after the pending/processing ones, so a
   *  heavier top border separates in-flight work from finished work. */
  dividerAbove: boolean;
}) {
  const [open, setOpen] = useState(false);
  let detail: ReviewResultDetail | null = null;
  if (item.resultJson) {
    try {
      detail = JSON.parse(item.resultJson) as ReviewResultDetail;
    } catch {
      detail = null;
    }
  }
  const expandable = Boolean(detail && (detail.items.length > 0 || detail.type));

  return (
    <>
      <TableRow className={dividerAbove ? "border-t-2 border-t-foreground/25" : undefined}>
        <TableCell className="max-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {expandable ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={open ? "Collapse details" : "Expand details"}
                onClick={() => setOpen((v) => !v)}
                className="size-5 shrink-0"
              >
                <ChevronDownIcon
                  className={open ? "" : "-rotate-90"}
                />
              </Button>
            ) : (
              <span className="inline-block size-5 shrink-0" />
            )}
            <a
              className="min-w-0 truncate font-medium text-[var(--link)]"
              href={`/wiki/${toWikiSegment(item.articleTitle)}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(item.articleSlug);
              }}
              title={item.articleTitle}
            >
              {item.articleTitle}
            </a>
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_BADGE[item.status]}>{item.status}</Badge>
        </TableCell>
        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
          {new Date(item.enqueuedAt).toLocaleTimeString()}
        </TableCell>
        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
          {item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : "—"}
        </TableCell>
        <TableCell>
          {item.verdict ? (
            <Badge variant={VERDICT_BADGE[item.verdict] ?? "outline"}>{item.verdict}</Badge>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {item.passed !== null || item.failed !== null
            ? `${item.passed ?? 0} passed · ${item.failed ?? 0} failed`
            : item.error
              ? item.error
              : "—"}
        </TableCell>
      </TableRow>
      {expandable ? (
        <TableRow>
          <TableCell colSpan={6} className="p-0">
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleContent>
                <div className="flex flex-col gap-1 bg-muted/30 px-3 py-2 text-xs">
                  {detail!.items.map((result) => (
                    <div key={result.id} className="flex flex-wrap items-baseline gap-2">
                      <Badge
                        variant={result.verdict === "pass" ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {result.verdict}
                      </Badge>
                      <span className="font-medium text-muted-foreground">{result.label}:</span>
                      <span className="min-w-0 flex-1 truncate">{result.object}</span>
                      <span className="text-muted-foreground">{result.reason}</span>
                    </div>
                  ))}
                  {detail!.type ? (
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge
                        variant={detail!.type.verdict === "pass" ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {detail!.type.verdict}
                      </Badge>
                      <span className="font-medium text-muted-foreground">type:</span>
                      <span className="min-w-0 flex-1 truncate">→ {detail!.type.suggestedType}</span>
                      <span className="text-muted-foreground">{detail!.type.reason}</span>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function WorkflowSchedulePane({ onNavigate }: WorkflowSchedulePaneProps) {
  const [data, setData] = useState<WorkflowSchedulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<WorkflowSchedulesPayload>("/api/admin/workflow-schedules"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to load workflow schedules");
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clock);
    };
  }, [load]);

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setBusyId(id);
      setError(null);
      try {
        await fetchJson(`/api/admin/workflow-schedules/${encodeURIComponent(id)}/enabled`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "failed to update schedule");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const runNow = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await fetchJson(`/api/admin/workflow-schedules/${encodeURIComponent(id)}/run-now`, {
          method: "POST",
        });
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "failed to run schedule");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const pendingCount = data?.queue.filter((item) => item.status === "pending" || item.status === "processing").length ?? 0;

  return (
    <Pane
      id="workflow-schedules"
      title="Workflow schedules"
      description="Recurring background workflows and the long-term ontology-review queue they drive."
      count={data ? `${pendingCount} queued` : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh workflow schedules"
          onClick={() => void load()}
        >
          <RefreshCwIcon />
        </Button>
      }
      wide
    >
      {error ? <p className="m-0 mb-3 text-sm text-destructive">{error}</p> : null}
      {!data ? (
        <p className="m-0 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>Interval</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.schedules.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell className="font-medium">{schedule.label}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    every {schedule.intervalMinutes}m
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      checked={schedule.enabled}
                      disabled={busyId === schedule.id}
                      onCheckedChange={(checked) => void toggleEnabled(schedule.id, checked === true)}
                      aria-label={`Enable ${schedule.label}`}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      {schedule.lastStatus ? (
                        <Badge
                          variant={
                            schedule.lastStatus === "error"
                              ? "destructive"
                              : schedule.lastStatus === "skipped"
                                ? "outline"
                                : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {schedule.lastStatus}
                        </Badge>
                      ) : null}
                      {formatRelative(schedule.lastRunAt, now, "")}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={schedule.lastDetail ?? undefined}>
                    {schedule.lastDetail ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(schedule.nextRunAt, now, "")}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Run ${schedule.label} now`}
                      disabled={busyId === schedule.id}
                      onClick={() => void runNow(schedule.id)}
                    >
                      <PlayIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {data.queue.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Enqueued</TableHead>
                  <TableHead>Run at</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.queue.map((item, index) => (
                  <QueueItemRow
                    key={item.id}
                    item={item}
                    onNavigate={onNavigate}
                    dividerAbove={index > 0 && index === pendingCount}
                  />
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="m-0 text-sm text-muted-foreground italic">
              Review queue is empty.
            </p>
          )}
        </div>
      )}
    </Pane>
  );
}
