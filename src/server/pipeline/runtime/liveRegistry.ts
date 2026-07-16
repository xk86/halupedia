/**
 * In-memory index of pipeline runs that are currently pending or executing.
 *
 * This is the *live* counterpart to the durable trace DB (`trace.ts`): the
 * trace DB is the source of truth for "what happened, ever" (including
 * pending/running rows — see `recordRunPending`/`recordRunStarted`), while
 * this registry is the fast, in-process view used to render the admin
 * dashboard and the per-article live status stream without hitting SQLite
 * on every poll.
 *
 * Every entry here corresponds 1:1 to a `pipeline_runs` row. The registry
 * is populated exclusively by `queueWorkflow` (see `graph.ts`) — there is no
 * way to run a workflow without an entry appearing here, which is what
 * makes "forgot to wire up visibility" structurally impossible.
 */

export interface LiveLlmView {
  node: string;
  reasoning?: string;
  response?: string;
}

export interface LiveRunEntry {
  runId: string;
  workflow: string;
  slug?: string;
  title?: string;
  /** Set when this run was spawned as a known follow-up of another run
   *  (e.g. post-process after generate). */
  parentRunId?: string;
  /** Free-text: what decided to run this workflow ("http", "post_process_auto",
   *  "image_auto", "maintenance", ...). */
  origin?: string;
  queuedAt: number;
  startedAt?: number;
  phase: string;
  state: "queued" | "processing" | "llm";
  reasoning?: string;
  llmViews: Map<string, LiveLlmView>;
  /** Host currently (or most recently) serving this run's LLM calls. Set as
   *  soon as the scheduler assigns a host, before the request is sent. */
  hostId?: string;
}

export interface LiveRunSnapshot {
  runId: string;
  workflow: string;
  slug?: string;
  title?: string;
  parentRunId?: string;
  origin?: string;
  queuedAt: number;
  startedAt?: number;
  queuedMs: number;
  activeMs: number;
  phase: string;
  state: "queued" | "processing" | "llm";
  reasoning?: string;
  views: LiveLlmView[];
  hostId?: string;
}

const LIVE_REASONING_TAIL_CHARS = 4_000;

/** Lifecycle events a subscriber (e.g. the per-article live stream) can react
 *  to without polling the registry. */
export type LiveRunChange =
  | { kind: "begin" | "phase" | "done"; entry: LiveRunEntry };

export class LiveRunRegistry {
  private readonly entries = new Map<string, LiveRunEntry>();
  private readonly bySlug = new Map<string, Set<string>>();
  private readonly listeners = new Set<(change: LiveRunChange) => void>();

  /** Subscribe to every begin/phase-change/done event across all runs. Used
   *  to push `type: "workflow"` events onto a slug's live NDJSON stream. */
  onChange(cb: (change: LiveRunChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(kind: LiveRunChange["kind"], entry: LiveRunEntry): void {
    for (const cb of this.listeners) {
      try {
        cb({ kind, entry });
      } catch {
        // Listener failures must never break workflow execution.
      }
    }
  }

  beginRun(opts: {
    runId: string;
    workflow: string;
    slug?: string;
    title?: string;
    parentRunId?: string;
    origin?: string;
    queuedAt?: number;
  }): LiveRunEntry {
    const entry: LiveRunEntry = {
      runId: opts.runId,
      workflow: opts.workflow,
      slug: opts.slug,
      title: opts.title,
      parentRunId: opts.parentRunId,
      origin: opts.origin,
      queuedAt: opts.queuedAt ?? Date.now(),
      phase: "starting",
      state: "queued",
      llmViews: new Map(),
    };
    this.entries.set(entry.runId, entry);
    if (entry.slug) {
      if (!this.bySlug.has(entry.slug)) this.bySlug.set(entry.slug, new Set());
      this.bySlug.get(entry.slug)!.add(entry.runId);
    }
    this.emit("begin", entry);
    return entry;
  }

  /** Called once a run's gate clears and node execution actually begins. */
  markStarted(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.startedAt = Date.now();
    entry.state = "processing";
    this.emit("phase", entry);
  }

  /** Called at the start of every node — mirrors `onNode` in `graph.ts`. */
  setPhase(runId: string, nodeName: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.phase = nodeName;
    entry.state = nodeName.startsWith("llm.") ? "llm" : "processing";
    this.emit("phase", entry);
  }

  /** Called as soon as the LLM scheduler assigns a host to this run's next
   *  call — before the request is sent, so concurrent runs are attributable
   *  to a host while still in flight. */
  setHost(runId: string, hostId: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.hostId = hostId;
    this.emit("phase", entry);
  }

  /** Streams live chain-of-thought / response text into a node's live view. */
  recordLlmUpdate(runId: string, update: { node: string; reasoning?: string; response?: string }): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    const current = entry.llmViews.get(update.node) ?? { node: update.node };
    entry.llmViews.set(update.node, {
      ...current,
      ...(update.reasoning !== undefined ? { reasoning: tail(update.reasoning) } : {}),
      ...(update.response !== undefined ? { response: tail(update.response) } : {}),
    });
    if (update.reasoning !== undefined) entry.reasoning = tail(update.reasoning);
  }

  /** Removes the entry once the run has settled (its terminal trace row is
   *  already written by the caller via `recorder.recordRun`). */
  done(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    this.entries.delete(runId);
    if (entry.slug) {
      const set = this.bySlug.get(entry.slug);
      set?.delete(runId);
      if (set && set.size === 0) this.bySlug.delete(entry.slug);
    }
    this.emit("done", entry);
  }

  get(runId: string): LiveRunEntry | undefined {
    return this.entries.get(runId);
  }

  getBySlug(slug: string): LiveRunEntry[] {
    const ids = this.bySlug.get(slug);
    if (!ids) return [];
    return [...ids].map((id) => this.entries.get(id)).filter((e): e is LiveRunEntry => !!e);
  }

  /** All live entries, oldest first — the shape the admin dashboard renders. */
  snapshot(): LiveRunSnapshot[] {
    const now = Date.now();
    return [...this.entries.values()]
      .sort((a, b) => (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt))
      .map((entry) => ({
        runId: entry.runId,
        workflow: entry.workflow,
        slug: entry.slug,
        title: entry.title,
        parentRunId: entry.parentRunId,
        origin: entry.origin,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        queuedMs: Math.max(0, (entry.startedAt ?? now) - entry.queuedAt),
        activeMs: entry.startedAt ? Math.max(0, now - entry.startedAt) : 0,
        phase: entry.phase,
        state: entry.state,
        reasoning: entry.reasoning,
        views: [...entry.llmViews.values()],
        hostId: entry.hostId,
      }));
  }
}

function tail(text: string): string {
  return text.length > LIVE_REASONING_TAIL_CHARS ? `…${text.slice(-LIVE_REASONING_TAIL_CHARS)}` : text;
}

// ─── Process-wide singleton ──────────────────────────────────────────────────
//
// One registry per process, shared by every `queueWorkflow` call regardless
// of which route triggered it. This is what lets a route simply call
// `queueWorkflow` with no extra wiring and still show up on the dashboard.

let singleton: LiveRunRegistry | null = null;

export function getLiveRunRegistry(): LiveRunRegistry {
  if (!singleton) singleton = new LiveRunRegistry();
  return singleton;
}
