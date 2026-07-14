/**
 * Background scheduler for long-term, recurring workflows — distinct from the
 * live generation queue (`liveRegistry.ts`), which is driven by user actions.
 * Currently drives the ontology-suggestion auto-review pipeline: one schedule
 * tops up a review queue with articles that have pending suggestions, another
 * drains it one article at a time. Both intervals (and the master enable
 * switch) are read live from `app.ontology_review` on every tick, so a config
 * change takes effect without a restart.
 */
import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { OntologyReviewConfig, PromptConfig } from "../types";
import {
  claimNextReview,
  completeReview,
  countActiveReviews,
  enqueueReviewTasks,
  failReview,
  reviewArticleSuggestions,
  type OntologyReviewCallInfo,
  type OntologyReviewResult,
  type OntologyVocabulary,
} from "../ontology";

const TICK_MS = 30_000;

export interface SchedulerDeps {
  db: DatabaseSync;
  logger: Logger;
  getConfig: () => OntologyReviewConfig;
  getLlm: () => LlmRouter;
  getPrompts: () => PromptConfig;
  getVocab: () => OntologyVocabulary;
  /** Fired after each reviewed article, so the caller can record a trace row
   *  and push a live update — mirrors `onOntologyExtracted` in index.ts. */
  onReview?: (slug: string, result: OntologyReviewResult, callInfo: OntologyReviewCallInfo) => void;
}

interface ScheduleRunOutcome {
  status: "ok" | "skipped" | "error";
  detail: string;
}

interface ScheduleDefinition {
  id: string;
  label: string;
  intervalMs: (config: OntologyReviewConfig) => number;
  run: (deps: SchedulerDeps) => Promise<ScheduleRunOutcome>;
}

const SCHEDULES: ScheduleDefinition[] = [
  {
    id: "ontology_review.enqueue",
    label: "Ontology review: enqueue",
    intervalMs: (config) => config.enqueue_interval_minutes * 60_000,
    run: async (deps) => {
      const active = countActiveReviews(deps.db);
      if (active > 0) return { status: "skipped", detail: `${active} already queued` };
      const added = enqueueReviewTasks(deps.db, deps.getConfig().enqueue_batch);
      return { status: "ok", detail: added > 0 ? `enqueued ${added} article(s)` : "nothing to enqueue" };
    },
  },
  {
    id: "ontology_review.run",
    label: "Ontology review: run",
    intervalMs: (config) => config.run_interval_minutes * 60_000,
    run: async (deps) => {
      const claimed = claimNextReview(deps.db);
      if (!claimed) return { status: "skipped", detail: "queue empty" };
      let callInfo: OntologyReviewCallInfo | undefined;
      try {
        const result = await reviewArticleSuggestions(deps.db, claimed.articleSlug, {
          llm: deps.getLlm(),
          prompts: deps.getPrompts(),
          vocab: deps.getVocab(),
          logger: deps.logger,
          keyMaxWords: deps.getConfig().key_max_words,
          onReviewed: (_slug, info) => {
            callInfo = info;
          },
        });
        completeReview(deps.db, claimed.id, {
          verdict: result.verdict,
          passed: result.passed,
          failed: result.failed,
          detail: result,
        });
        if (callInfo) deps.onReview?.(claimed.articleSlug, result, callInfo);
        return {
          status: "ok",
          detail: `${claimed.articleSlug}: ${result.verdict} (${result.passed} passed, ${result.failed} failed)`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failReview(deps.db, claimed.id, message);
        return { status: "error", detail: `${claimed.articleSlug}: ${message}` };
      }
    },
  },
];

interface ScheduleRow {
  id: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDetail: string | null;
  nextRunAt: number | null;
}

function getScheduleRow(db: DatabaseSync, id: string): ScheduleRow | null {
  const row = prepared(
    db,
    `SELECT id, enabled, last_run_at AS lastRunAt, last_status AS lastStatus,
            last_detail AS lastDetail, next_run_at AS nextRunAt
       FROM scheduled_workflows WHERE id = ?`,
  ).get(id) as (Omit<ScheduleRow, "enabled"> & { enabled: number }) | undefined;
  return row ? { ...row, enabled: row.enabled === 1 } : null;
}

function seedScheduleRows(db: DatabaseSync): void {
  const now = Date.now();
  for (const def of SCHEDULES) {
    prepared(
      db,
      `INSERT OR IGNORE INTO scheduled_workflows (id, enabled, next_run_at, updated_at)
       VALUES (?, 1, ?, ?)`,
    ).run(def.id, now, now);
  }
}

function recordScheduleRun(db: DatabaseSync, id: string, startedAt: number, outcome: ScheduleRunOutcome, intervalMs: number): void {
  prepared(
    db,
    `UPDATE scheduled_workflows
        SET last_run_at = ?, last_status = ?, last_detail = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(startedAt, outcome.status, outcome.detail, startedAt + intervalMs, Date.now(), id);
}

async function runSchedule(def: ScheduleDefinition, deps: SchedulerDeps): Promise<void> {
  const startedAt = Date.now();
  let outcome: ScheduleRunOutcome;
  try {
    outcome = await def.run(deps);
  } catch (err) {
    outcome = { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  recordScheduleRun(deps.db, def.id, startedAt, outcome, def.intervalMs(deps.getConfig()));
  const event = outcome.status === "error" ? "scheduler.error" : outcome.status === "skipped" ? "scheduler.skip" : "scheduler.tick";
  const log = outcome.status === "error" ? deps.logger.warn.bind(deps.logger) : deps.logger.info.bind(deps.logger);
  log(event, { schedule: def.id, status: outcome.status, detail: outcome.detail, duration_ms: Date.now() - startedAt });
}

export interface ScheduleSummary {
  id: string;
  label: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDetail: string | null;
  nextRunAt: number | null;
}

/** Schedule state for the admin Monitoring view — reads only, no controller
 *  needed, so this works even before/independent of `startScheduler`. */
export function listSchedules(db: DatabaseSync, config: OntologyReviewConfig): ScheduleSummary[] {
  return SCHEDULES.map((def) => {
    const row = getScheduleRow(db, def.id);
    return {
      id: def.id,
      label: def.label,
      intervalMinutes: Math.max(1, Math.round(def.intervalMs(config) / 60_000)),
      enabled: row?.enabled ?? true,
      lastRunAt: row?.lastRunAt ?? null,
      lastStatus: row?.lastStatus ?? null,
      lastDetail: row?.lastDetail ?? null,
      nextRunAt: row?.nextRunAt ?? null,
    };
  });
}

export function setScheduleEnabled(db: DatabaseSync, id: string, enabled: boolean): boolean {
  if (!SCHEDULES.some((def) => def.id === id)) return false;
  const res = prepared(
    db,
    `UPDATE scheduled_workflows SET enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, Date.now(), id);
  return Number(res.changes) > 0;
}

export interface SchedulerController {
  /** Run one schedule immediately, bypassing its next-run gate (but not the
   *  re-entrancy guard — a schedule already mid-run is left alone). */
  runNow(id: string): Promise<void>;
  stop(): void;
}

export function startScheduler(deps: SchedulerDeps): SchedulerController {
  seedScheduleRows(deps.db);
  const running = new Set<string>();

  const tick = () => {
    const config = deps.getConfig();
    if (!config.enabled) return;
    const now = Date.now();
    for (const def of SCHEDULES) {
      if (running.has(def.id)) continue;
      const row = getScheduleRow(deps.db, def.id);
      if (!row?.enabled) continue;
      if ((row.nextRunAt ?? 0) > now) continue;
      running.add(def.id);
      void runSchedule(def, deps).finally(() => running.delete(def.id));
    }
  };

  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  return {
    async runNow(id) {
      const def = SCHEDULES.find((d) => d.id === id);
      if (!def) throw new Error(`unknown schedule: ${id}`);
      if (running.has(id)) return;
      running.add(id);
      try {
        await runSchedule(def, deps);
      } finally {
        running.delete(id);
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}
