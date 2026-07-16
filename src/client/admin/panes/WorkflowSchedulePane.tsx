import { useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ListPlusIcon,
  PlayIcon,
  RefreshCwIcon,
  StepForwardIcon,
} from "lucide-react";

import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toWikiSegment } from "../../wikiPath";

// Maps a schedule id to the app-config path its interval lives at, so the
// interval can be edited inline here instead of only via the Config tab.
const INTERVAL_CONFIG_PATH: Record<string, string> = {
  "ontology_extract.enqueue": "ontology_review.extract_enqueue_interval_minutes",
  "ontology_extract.run": "ontology_review.extract_run_interval_minutes",
  "ontology_review.enqueue": "ontology_review.enqueue_interval_minutes",
  "ontology_review.run": "ontology_review.run_interval_minutes",
};

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

type ExtractQueueStatus = "pending" | "processing" | "done" | "error";

interface ExtractQueueItem {
  id: number;
  articleSlug: string;
  articleTitle: string;
  status: ExtractQueueStatus;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  called: boolean | null;
  reason: string | null;
  error: string | null;
}

interface WorkflowSchedulesPayload {
  schedules: ScheduleSummary[];
  queue: ReviewQueueItem[];
  extractQueue: ExtractQueueItem[];
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

function IntervalEditor({
  schedule,
  busy,
  onSave,
}: {
  schedule: ScheduleSummary;
  busy: boolean;
  onSave: (id: string, minutes: number) => void;
}) {
  const [value, setValue] = useState(String(schedule.intervalMinutes));
  // Pick up the saved value once it round-trips through a reload; don't
  // clobber the field while the operator is mid-edit and unsaved.
  useEffect(() => {
    setValue(String(schedule.intervalMinutes));
  }, [schedule.intervalMinutes]);

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const dirty = valid && Math.floor(parsed) !== schedule.intervalMinutes;

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={1}
        step={1}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-16"
        aria-label={`${schedule.label} interval minutes`}
      />
      <span className="text-xs text-muted-foreground">min</span>
      {dirty ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Save ${schedule.label} interval`}
          disabled={busy}
          onClick={() => onSave(schedule.id, Math.floor(parsed))}
        >
          <CheckIcon />
        </Button>
      ) : null}
    </div>
  );
}

function QueueItemRow({
  item,
  runAtMs,
  onNavigate,
  dividerAbove,
}: {
  item: ReviewQueueItem;
  /** Actual run start for processing/done/error rows; an estimated future
   *  time (derived from the run schedule's cadence) for pending rows. */
  runAtMs: number | null;
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
          {runAtMs !== null ? new Date(runAtMs).toLocaleTimeString() : "—"}
          {item.status === "pending" && runAtMs !== null ? (
            <span className="ml-1 text-muted-foreground/70">(est.)</span>
          ) : null}
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

const EXTRACT_STATUS_BADGE: Record<ExtractQueueStatus, "outline" | "secondary" | "default" | "destructive"> = {
  pending: "outline",
  processing: "default",
  done: "secondary",
  error: "destructive",
};

function ExtractQueueItemRow({
  item,
  runAtMs,
  onNavigate,
  dividerAbove,
}: {
  item: ExtractQueueItem;
  runAtMs: number | null;
  onNavigate: (slug: string) => void;
  dividerAbove: boolean;
}) {
  return (
    <TableRow className={dividerAbove ? "border-t-2 border-t-foreground/25" : undefined}>
      <TableCell className="max-w-0">
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
      </TableCell>
      <TableCell>
        <Badge variant={EXTRACT_STATUS_BADGE[item.status]}>{item.status}</Badge>
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
        {new Date(item.enqueuedAt).toLocaleTimeString()}
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
        {runAtMs !== null ? new Date(runAtMs).toLocaleTimeString() : "—"}
        {item.status === "pending" && runAtMs !== null ? (
          <span className="ml-1 text-muted-foreground/70">(est.)</span>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {item.error ?? item.reason ?? "—"}
        {item.called !== null ? (item.called ? " (called)" : " (cached)") : ""}
      </TableCell>
    </TableRow>
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

  const saveInterval = useCallback(
    async (id: string, minutes: number) => {
      const path = INTERVAL_CONFIG_PATH[id];
      if (!path) {
        // No config path mapped for this schedule id — without this guard the
        // save would silently no-op and the field would snap back to its old
        // value on the next reload, with no indication anything went wrong.
        setError(`No config mapping for schedule "${id}"; interval not saved.`);
        return;
      }
      setBusyId(id);
      setError(null);
      try {
        await fetchJson("/api/admin/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ path, value: minutes }] }),
        });
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "failed to save interval");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const [runningAll, setRunningAll] = useState(false);
  const runAllQueued = useCallback(async () => {
    const extractCount =
      data?.extractQueue.filter((item) => item.status === "pending" || item.status === "processing").length ?? 0;
    const reviewCount =
      data?.queue.filter((item) => item.status === "pending" || item.status === "processing").length ?? 0;
    if (extractCount === 0 && reviewCount === 0) return;
    setRunningAll(true);
    setError(null);
    try {
      // Bounded by the counts observed when the button was clicked — new work
      // enqueued mid-run isn't swept up, so this can't turn into a runaway loop.
      // Extraction drains first: review depends on it, so draining review
      // first would just leave articles skipped until the next pass.
      for (let i = 0; i < extractCount; i++) {
        await fetchJson("/api/admin/workflow-schedules/ontology_extract.run/run-now", {
          method: "POST",
        });
      }
      for (let i = 0; i < reviewCount; i++) {
        await fetchJson("/api/admin/workflow-schedules/ontology_review.run/run-now", {
          method: "POST",
        });
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to run all queued items");
    } finally {
      setRunningAll(false);
    }
  }, [data, load]);

  const pendingCount = data?.queue.filter((item) => item.status === "pending" || item.status === "processing").length ?? 0;

  // The run schedule fires at a fixed cadence, so a pending item's estimated
  // run time is just the schedule's next-run time plus its position in the
  // queue times the interval — the queue is already returned in run order.
  const runSchedule = data?.schedules.find((s) => s.id === "ontology_review.run") ?? null;
  const intervalMs = (runSchedule?.intervalMinutes ?? 5) * 60_000;
  let pendingIndex = 0;
  const queueWithRunAt = (data?.queue ?? []).map((item) => {
    let runAtMs: number | null = item.startedAt;
    if (item.status === "pending") {
      runAtMs = runSchedule?.nextRunAt != null ? runSchedule.nextRunAt + pendingIndex * intervalMs : null;
      pendingIndex += 1;
    }
    return { item, runAtMs };
  });

  const extractRunSchedule = data?.schedules.find((s) => s.id === "ontology_extract.run") ?? null;
  const extractIntervalMs = (extractRunSchedule?.intervalMinutes ?? 5) * 60_000;
  const extractPendingCount =
    data?.extractQueue.filter((item) => item.status === "pending" || item.status === "processing").length ?? 0;
  let extractPendingIndex = 0;
  const extractQueueWithRunAt = (data?.extractQueue ?? []).map((item) => {
    let runAtMs: number | null = item.startedAt;
    if (item.status === "pending") {
      runAtMs = extractRunSchedule?.nextRunAt != null ? extractRunSchedule.nextRunAt + extractPendingIndex * extractIntervalMs : null;
      extractPendingIndex += 1;
    }
    return { item, runAtMs };
  });

  const queueMoreBoth = useCallback(async () => {
    setBusyId("ontology_extract.enqueue");
    setError(null);
    try {
      await fetchJson("/api/admin/workflow-schedules/ontology_extract.enqueue/run-now", { method: "POST" });
      await fetchJson("/api/admin/workflow-schedules/ontology_review.enqueue/run-now", { method: "POST" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to queue more");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  return (
    <Pane
      id="workflow-schedules"
      title="Workflow schedules"
      description="Recurring background workflows and the long-term ontology-extraction and review queues they drive."
      count={data ? `${extractPendingCount + pendingCount} queued` : undefined}
      actions={
        <>
          <Button
            variant="outline"
            size="xs"
            disabled={busyId !== null || runningAll}
            onClick={() => void queueMoreBoth()}
          >
            <ListPlusIcon data-icon="inline-start" />
            Queue more
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={(extractPendingCount === 0 && pendingCount === 0) || runningAll || busyId !== null}
            onClick={() => void runAllQueued()}
          >
            <StepForwardIcon data-icon="inline-start" />
            {runningAll ? "Running…" : "Run all queued"}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workflow schedules"
            onClick={() => void load()}
          >
            <RefreshCwIcon />
          </Button>
        </>
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
                    <IntervalEditor
                      schedule={schedule}
                      busy={busyId === schedule.id}
                      onSave={(id, minutes) => void saveInterval(id, minutes)}
                    />
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

          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-sm font-medium text-muted-foreground">
              Extraction queue (runs before review)
            </h3>
            {data.extractQueue.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Article</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Enqueued</TableHead>
                    <TableHead>Run at</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extractQueueWithRunAt.map(({ item, runAtMs }, index) => (
                    <ExtractQueueItemRow
                      key={item.id}
                      item={item}
                      runAtMs={runAtMs}
                      onNavigate={onNavigate}
                      dividerAbove={index > 0 && index === extractPendingCount}
                    />
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="m-0 text-sm text-muted-foreground italic">
                Extraction queue is empty.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-sm font-medium text-muted-foreground">Review queue</h3>
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
                  {queueWithRunAt.map(({ item, runAtMs }, index) => (
                    <QueueItemRow
                      key={item.id}
                      item={item}
                      runAtMs={runAtMs}
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
        </div>
      )}
    </Pane>
  );
}
