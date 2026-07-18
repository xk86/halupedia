import { useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
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
import { cn } from "@/lib/utils";
import { toWikiSegment } from "../../wikiPath";
import {
  renderInlineMarkdown,
  renderOntologyValueHtml,
} from "../../../server/markdown";

// Maps a schedule id to the app-config path its interval lives at, so the
// interval can be edited inline here instead of only via the Config tab.
const INTERVAL_CONFIG_PATH: Record<string, string> = {
  "ontology_extract.enqueue":
    "ontology_review.extract_enqueue_interval_minutes",
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
  type: {
    suggestedType: string;
    verdict: "pass" | "fail";
    reason: string;
    source: string;
  } | null;
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
  const payload = (await res.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!res.ok)
    throw new Error(payload.error || `request failed (${res.status})`);
  return payload;
}

function formatRelative(
  ms: number | null,
  now: number,
  suffix: string,
): string {
  if (ms === null) return "—";
  const deltaSec = Math.round((ms - now) / 1000);
  const abs = Math.abs(deltaSec);
  const unit =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : `${Math.round(abs / 3600)}h`;
  return deltaSec <= 0 ? `${unit} ago` : `in ${unit} ${suffix}`;
}

function formatQueueTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsed(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

const STATUS_BADGE: Record<
  ReviewQueueStatus,
  "outline" | "secondary" | "default" | "destructive"
> = {
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

function QueueArticle({
  id,
  slug,
  title,
  onNavigate,
  detailControl,
}: {
  id: number;
  slug: string;
  title: string;
  onNavigate: (slug: string) => void;
  detailControl?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {detailControl}
      <div className="min-w-0 flex-1">
        <a
          className="block truncate font-medium text-[var(--link)]"
          href={`/wiki/${toWikiSegment(title)}`}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(slug);
          }}
          title={title}
        >
          {title}
        </a>
        <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
          #{id} · {slug}
        </span>
      </div>
    </div>
  );
}

function QueueTiming({
  enqueuedAt,
  runAtMs,
  finishedAt,
  estimated,
}: {
  enqueuedAt: number;
  runAtMs: number | null;
  finishedAt: number | null;
  estimated: boolean;
}) {
  const wait = runAtMs !== null ? formatElapsed(enqueuedAt, runAtMs) : null;
  const runtime =
    runAtMs !== null && finishedAt !== null
      ? formatElapsed(runAtMs, finishedAt)
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-0.5 font-mono text-[0.68rem] leading-tight text-muted-foreground tabular-nums">
      <span
        className="truncate"
        title={`Enqueued ${new Date(enqueuedAt).toLocaleString()}`}
      >
        queued {formatQueueTime(enqueuedAt)}
      </span>
      <span
        className="truncate"
        title={
          runAtMs === null
            ? undefined
            : `${estimated ? "Estimated run" : "Started"} ${new Date(runAtMs).toLocaleString()}`
        }
      >
        {estimated ? "est." : "started"} {formatQueueTime(runAtMs)}
        {wait ? ` · wait ${wait}` : ""}
      </span>
      {finishedAt !== null ? (
        <span
          className="truncate"
          title={`Finished ${new Date(finishedAt).toLocaleString()}`}
        >
          finished {formatQueueTime(finishedAt)}
          {runtime ? ` · ran ${runtime}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function QueueSectionHeader({
  title,
  note,
  total,
  pending,
  collapsed,
  onToggleCollapsed,
  onRunAll,
  runAllBusy,
  runAllDisabled,
}: {
  title: string;
  note?: string;
  total: number;
  pending: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRunAll: () => void;
  /** True only while this section's own run-all is in flight — drives the label. */
  runAllBusy: boolean;
  /** True while this or any other run-all is in flight, or there's nothing to run. */
  runAllDisabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
        <h3 className="m-0 text-sm font-medium">{title}</h3>
        {note ? (
          <span className="truncate text-xs text-muted-foreground">{note}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Badge variant="outline">{total} rows</Badge>
        <Badge variant={pending > 0 ? "default" : "secondary"}>
          {pending} open
        </Badge>
        <Button
          variant="outline"
          size="xs"
          disabled={runAllDisabled}
          onClick={onRunAll}
        >
          <StepForwardIcon data-icon="inline-start" />
          {runAllBusy ? "Running…" : "Run all"}
        </Button>
      </div>
    </div>
  );
}

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

/** One expanded review assertion: a verdict badge + label + the (possibly
 *  link-bearing) object on the first line, and the model's supporting reason
 *  wrapped underneath. Object/reason are rendered through the shared ontology
 *  markdown pipeline so `ref:`/`halu:` links resolve to wiki anchors, and both
 *  wrap instead of truncating so nothing clips on narrow screens. */
function ReviewDetailLine({
  verdict,
  label,
  objectHtml,
  reason,
}: {
  verdict: "pass" | "fail";
  label: string;
  objectHtml: string;
  reason: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <Badge variant={verdict === "pass" ? "secondary" : "destructive"}>
          {verdict}
        </Badge>
        <span className="font-medium text-muted-foreground">{label}:</span>
        <span
          className="min-w-0 break-words [&_a]:text-[var(--link)] [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: objectHtml }}
        />
      </div>
      {reason ? (
        <span
          className="break-words text-muted-foreground [&_a]:text-[var(--link)] [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(reason) }}
        />
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
  const expandable = Boolean(
    detail && (detail.items.length > 0 || detail.type),
  );

  return (
    <>
      <TableRow
        className={
          dividerAbove ? "border-t-2 border-t-foreground/25" : undefined
        }
      >
        <TableCell className="min-w-0">
          <QueueArticle
            id={item.id}
            slug={item.articleSlug}
            title={item.articleTitle}
            onNavigate={onNavigate}
            detailControl={
              expandable ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={open ? "Collapse details" : "Expand details"}
                  onClick={() => setOpen((v) => !v)}
                >
                  <ChevronDownIcon className={cn(!open && "-rotate-90")} />
                </Button>
              ) : undefined
            }
          />
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_BADGE[item.status]}>{item.status}</Badge>
        </TableCell>
        <TableCell className="min-w-0">
          <QueueTiming
            enqueuedAt={item.enqueuedAt}
            runAtMs={runAtMs}
            finishedAt={item.finishedAt}
            estimated={item.status === "pending" && runAtMs !== null}
          />
        </TableCell>
        <TableCell className="min-w-0">
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <div className="flex items-center gap-1">
              {item.verdict ? (
                <Badge variant={VERDICT_BADGE[item.verdict] ?? "outline"}>
                  {item.verdict}
                </Badge>
              ) : null}
              {item.passed !== null ? (
                <span className="text-xs text-muted-foreground">
                  {item.passed} passed
                </span>
              ) : null}
              {item.failed !== null ? (
                <span className="text-xs text-muted-foreground">
                  {item.failed} failed
                </span>
              ) : null}
            </div>
            {item.error ? (
              <span
                className="block max-w-full truncate text-xs text-destructive"
                title={item.error}
              >
                {item.error}
              </span>
            ) : null}
            {!item.verdict &&
            item.passed === null &&
            item.failed === null &&
            !item.error
              ? "—"
              : null}
          </div>
        </TableCell>
      </TableRow>
      {expandable ? (
        <TableRow>
          <TableCell colSpan={4} className="p-0">
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleContent>
                <div className="flex flex-col gap-1.5 bg-muted/30 px-3 py-2 text-xs">
                  {detail!.items.map((result) => (
                    <ReviewDetailLine
                      key={result.id}
                      verdict={result.verdict}
                      label={result.label}
                      objectHtml={renderOntologyValueHtml(result.object)}
                      reason={result.reason}
                    />
                  ))}
                  {detail!.type ? (
                    <ReviewDetailLine
                      verdict={detail!.type.verdict}
                      label="type"
                      objectHtml={`→ ${renderOntologyValueHtml(
                        detail!.type.suggestedType,
                      )}`}
                      reason={detail!.type.reason}
                    />
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

const EXTRACT_STATUS_BADGE: Record<
  ExtractQueueStatus,
  "outline" | "secondary" | "default" | "destructive"
> = {
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
    <TableRow
      className={dividerAbove ? "border-t-2 border-t-foreground/25" : undefined}
    >
      <TableCell className="min-w-0">
        <QueueArticle
          id={item.id}
          slug={item.articleSlug}
          title={item.articleTitle}
          onNavigate={onNavigate}
        />
      </TableCell>
      <TableCell>
        <Badge variant={EXTRACT_STATUS_BADGE[item.status]}>{item.status}</Badge>
      </TableCell>
      <TableCell className="min-w-0">
        <QueueTiming
          enqueuedAt={item.enqueuedAt}
          runAtMs={runAtMs}
          finishedAt={item.finishedAt}
          estimated={item.status === "pending" && runAtMs !== null}
        />
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          {item.called !== null ? (
            <Badge variant={item.called ? "default" : "outline"}>
              {item.called ? "LLM called" : "Cache hit"}
            </Badge>
          ) : null}
          <span
            className={cn(
              "block max-w-full truncate text-xs text-muted-foreground",
              item.error && "text-destructive",
            )}
            title={item.error ?? item.reason ?? undefined}
          >
            {item.error ?? item.reason ?? "—"}
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function WorkflowSchedulePane({
  onNavigate,
}: WorkflowSchedulePaneProps) {
  const [data, setData] = useState<WorkflowSchedulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [extractCollapsed, setExtractCollapsed] = useState(false);
  const [reviewCollapsed, setReviewCollapsed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(
        await fetchJson<WorkflowSchedulesPayload>(
          "/api/admin/workflow-schedules",
        ),
      );
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to load workflow schedules",
      );
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
        await fetchJson(
          `/api/admin/workflow-schedules/${encodeURIComponent(id)}/enabled`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          },
        );
        await load();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "failed to update schedule",
        );
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
        await fetchJson(
          `/api/admin/workflow-schedules/${encodeURIComponent(id)}/run-now`,
          {
            method: "POST",
          },
        );
        await load();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "failed to run schedule",
        );
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
        setError(
          cause instanceof Error ? cause.message : "failed to save interval",
        );
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // Fires `run-now` for a schedule id `count` times in sequence and reloads.
  // Bounded by the count observed when the button was clicked — new work
  // enqueued mid-run isn't swept up, so this can't turn into a runaway loop.
  const runScheduleTimes = useCallback(
    async (scheduleId: string, count: number) => {
      for (let i = 0; i < count; i++) {
        await fetchJson(
          `/api/admin/workflow-schedules/${encodeURIComponent(scheduleId)}/run-now`,
          { method: "POST" },
        );
      }
    },
    [],
  );

  const [runningAll, setRunningAll] = useState(false);
  const runAllQueued = useCallback(async () => {
    const extractCount =
      data?.extractQueue.filter(
        (item) => item.status === "pending" || item.status === "processing",
      ).length ?? 0;
    const reviewCount =
      data?.queue.filter(
        (item) => item.status === "pending" || item.status === "processing",
      ).length ?? 0;
    if (extractCount === 0 && reviewCount === 0) return;
    setRunningAll(true);
    setError(null);
    try {
      // Extraction drains first: review depends on it, so draining review
      // first would just leave articles skipped until the next pass.
      await runScheduleTimes("ontology_extract.run", extractCount);
      await runScheduleTimes("ontology_review.run", reviewCount);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to run all queued items",
      );
    } finally {
      setRunningAll(false);
    }
  }, [data, load, runScheduleTimes]);

  const [runningExtract, setRunningExtract] = useState(false);
  const runAllExtractQueue = useCallback(async () => {
    const count =
      data?.extractQueue.filter(
        (item) => item.status === "pending" || item.status === "processing",
      ).length ?? 0;
    if (count === 0) return;
    setRunningExtract(true);
    setError(null);
    try {
      await runScheduleTimes("ontology_extract.run", count);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to run all queued extractions",
      );
    } finally {
      setRunningExtract(false);
    }
  }, [data, load, runScheduleTimes]);

  const [runningReview, setRunningReview] = useState(false);
  const runAllReviewQueue = useCallback(async () => {
    const count =
      data?.queue.filter(
        (item) => item.status === "pending" || item.status === "processing",
      ).length ?? 0;
    if (count === 0) return;
    setRunningReview(true);
    setError(null);
    try {
      await runScheduleTimes("ontology_review.run", count);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to run all queued reviews",
      );
    } finally {
      setRunningReview(false);
    }
  }, [data, load, runScheduleTimes]);

  const pendingCount =
    data?.queue.filter(
      (item) => item.status === "pending" || item.status === "processing",
    ).length ?? 0;

  // The run schedule fires at a fixed cadence, so a pending item's estimated
  // run time is just the schedule's next-run time plus its position in the
  // queue times the interval — the queue is already returned in run order.
  const runSchedule =
    data?.schedules.find((s) => s.id === "ontology_review.run") ?? null;
  const intervalMs = (runSchedule?.intervalMinutes ?? 5) * 60_000;
  let pendingIndex = 0;
  const queueWithRunAt = (data?.queue ?? []).map((item) => {
    let runAtMs: number | null = item.startedAt;
    if (item.status === "pending") {
      runAtMs =
        runSchedule?.nextRunAt != null
          ? runSchedule.nextRunAt + pendingIndex * intervalMs
          : null;
      pendingIndex += 1;
    }
    return { item, runAtMs };
  });

  const extractRunSchedule =
    data?.schedules.find((s) => s.id === "ontology_extract.run") ?? null;
  const extractIntervalMs = (extractRunSchedule?.intervalMinutes ?? 5) * 60_000;
  const extractPendingCount =
    data?.extractQueue.filter(
      (item) => item.status === "pending" || item.status === "processing",
    ).length ?? 0;
  let extractPendingIndex = 0;
  const extractQueueWithRunAt = (data?.extractQueue ?? []).map((item) => {
    let runAtMs: number | null = item.startedAt;
    if (item.status === "pending") {
      runAtMs =
        extractRunSchedule?.nextRunAt != null
          ? extractRunSchedule.nextRunAt +
            extractPendingIndex * extractIntervalMs
          : null;
      extractPendingIndex += 1;
    }
    return { item, runAtMs };
  });

  const queueMoreBoth = useCallback(async () => {
    setBusyId("ontology_extract.enqueue");
    setError(null);
    try {
      await fetchJson(
        "/api/admin/workflow-schedules/ontology_extract.enqueue/run-now",
        { method: "POST" },
      );
      await fetchJson(
        "/api/admin/workflow-schedules/ontology_review.enqueue/run-now",
        { method: "POST" },
      );
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
            disabled={
              (extractPendingCount === 0 && pendingCount === 0) ||
              runningAll ||
              runningExtract ||
              runningReview ||
              busyId !== null
            }
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
      {error ? (
        <p className="m-0 mb-3 text-sm text-destructive">{error}</p>
      ) : null}
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
                  <TableCell className="font-medium">
                    {schedule.label}
                  </TableCell>
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
                      onCheckedChange={(checked) =>
                        void toggleEnabled(schedule.id, checked === true)
                      }
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
                  <TableCell
                    className="max-w-64 truncate text-xs text-muted-foreground"
                    title={schedule.lastDetail ?? undefined}
                  >
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
            <QueueSectionHeader
              title="Extraction queue"
              note="runs before review"
              total={data.extractQueue.length}
              pending={extractPendingCount}
              collapsed={extractCollapsed}
              onToggleCollapsed={() => setExtractCollapsed((v) => !v)}
              onRunAll={() => void runAllExtractQueue()}
              runAllBusy={runningExtract}
              runAllDisabled={
                extractPendingCount === 0 ||
                runningExtract ||
                runningReview ||
                runningAll
              }
            />
            {!extractCollapsed ? (
              data.extractQueue.length > 0 ? (
                <Table
                  containerClassName="rounded-lg border border-border"
                  className="min-w-[42rem] table-fixed text-xs [&_td]:px-2 [&_td]:py-1.5 [&_th]:h-7 [&_th]:px-2"
                >
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[15%]" />
                    <col className="w-[30%]" />
                    <col className="w-[21%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Article</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Timing</TableHead>
                      <TableHead>Outcome</TableHead>
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
              )
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <QueueSectionHeader
              title="Review queue"
              total={data.queue.length}
              pending={pendingCount}
              collapsed={reviewCollapsed}
              onToggleCollapsed={() => setReviewCollapsed((v) => !v)}
              onRunAll={() => void runAllReviewQueue()}
              runAllBusy={runningReview}
              runAllDisabled={
                pendingCount === 0 ||
                runningExtract ||
                runningReview ||
                runningAll
              }
            />
            {!reviewCollapsed ? (
              data.queue.length > 0 ? (
                <Table
                  containerClassName="rounded-lg border border-border"
                  className="min-w-[42rem] table-fixed text-xs [&_td]:px-2 [&_td]:py-1.5 [&_th]:h-7 [&_th]:px-2"
                >
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[15%]" />
                    <col className="w-[30%]" />
                    <col className="w-[21%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Article</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Timing</TableHead>
                      <TableHead>Outcome</TableHead>
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
              )
            ) : null}
          </div>
        </div>
      )}
    </Pane>
  );
}
