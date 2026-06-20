import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Pane } from "../Pane";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ERROR_BOX } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Shared chrome for the LLM admin cards (formerly the llm-card* CSS family).
// --rule-strong is intentionally undefined upstream, so these borders render
// transparent — preserved verbatim to keep the existing look.
const LLM_CARD =
  "my-2 mx-0 bg-input-surface px-[0.8rem] py-[0.7rem] [border:1px_solid_var(--rule-strong)]";
const LLM_CARD_HEAD =
  "mb-2 flex items-center gap-[0.8rem] font-mono text-[0.85rem]";
const LLM_CARD_GRID =
  "mb-2 grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-[0.8rem] gap-y-2";
const LLM_FIELD =
  "flex flex-col gap-[0.2rem] font-mono text-[0.72rem] uppercase opacity-85 [&_input]:normal-case";
const LLM_FIELD_WIDE = `${LLM_FIELD} col-[1/-1]`;

interface HostInfo {
  id: string;
  base_url: string;
  api_key: string;
  max_in_flight: number;
  pref: number;
  blacklist: string[];
  online: boolean;
  active: number;
  queued: number;
  activeJobs: DispatchJob[];
  queuedJobs: DispatchJob[];
  models: string[] | null;
}

interface DispatchJob {
  id: number;
  role: string;
  model: string;
  preferredHosts: string[];
  candidates: string[];
  tried: string[];
  enqueuedAt: number;
  queuedMs: number;
  startedAt?: number;
  runningMs?: number;
  hostId?: string;
  workflow?: string;
  slug?: string;
  title?: string;
  node?: string;
}

interface RoleInfo {
  hosts: string[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_k?: number | null;
  top_p?: number | null;
  min_p?: number | null;
  enabled?: boolean;
  candidates: string[];
}

type RoleKey = "heavy" | "light" | "images" | "embeddings";

interface LlmConfigResponse {
  hosts: HostInfo[];
  roles: Record<RoleKey, RoleInfo | null>;
  imageGeneration: ImageGenerationInfo;
}

interface ImageGenerationInfo {
  enabled: boolean;
  autoGenerateForNewArticles: boolean;
  autoGenerateForFeaturedArticle: boolean;
  autoPresetMultipass: boolean;
  backend: "openai" | "ollama";
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    size: string;
    quality: string;
    outputFormat: string;
    outputCompression: number;
    timeoutMs: number;
  };
  ollama: {
    baseUrl: string;
    model: string;
    width: number;
    height: number;
    steps: number;
    timeoutMs: number;
  };
}

const ROLE_ORDER: RoleKey[] = ["heavy", "light", "images", "embeddings"];
const ROLE_LABEL: Record<RoleKey, string> = {
  heavy: "heavy (llm.chat)",
  light: "light (llm.light)",
  images: "images (llm.images)",
  embeddings: "embeddings (llm.embeddings)",
};

function LlmHostsPaneComponent() {
  const [data, setData] = useState<LlmConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Polled once a second; only re-render when the payload actually changes so an
  // idle hosts pane doesn't reconcile every second.
  const lastJson = useRef<string>("");
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/llm");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.text();
      setError(null);
      if (json === lastJson.current) return;
      lastJson.current = json;
      setData(JSON.parse(json) as LlmConfigResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(interval);
  }, [load]);

  const send = useCallback(
    async (label: string, url: string, method: string, body: unknown) => {
      setBusy(label);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        await load();
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const hostIds = useMemo(() => (data?.hosts ?? []).map((h) => h.id), [data]);
  const hostModels = useMemo(() => {
    const map: Record<string, string[] | null> = {};
    for (const h of data?.hosts ?? []) map[h.id] = h.models;
    return map;
  }, [data]);

  return (
    <Pane
      id="llm-hosts"
      title="LLM Hosts & Roles"
      count={`${data?.hosts.length ?? 0} hosts`}
      wide
    >
      {error && <div className={ERROR_BOX}>{error}</div>}
      {!data ? (
        <p className="sb-copy">Loading…</p>
      ) : (
        <div>
          <h4 className="sb-copy">Hosts</h4>
          <p className="sb-copy opacity-70">
            Each host has its own queue (depth = <code>max_in_flight</code>).
            Lower <code>pref</code> wins when a request spills to a fallback.
            Blacklisted models are excluded at probe.
          </p>
          {data.hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              busy={busy}
              onSave={(patch) =>
                send(
                  `host:${h.id}`,
                  `/api/admin/llm/host/${encodeURIComponent(h.id)}`,
                  "PUT",
                  patch,
                )
              }
            />
          ))}
          <AddHostForm
            busy={busy}
            onAdd={(body) =>
              send("add-host", "/api/admin/llm/host", "POST", body)
            }
          />

          <h4 className="sb-copy mt-[18px]">Roles</h4>
          <p className="sb-copy opacity-70">
            The <code>images</code> role describes existing images for captions
            and sidebars. New article image generation is configured separately
            below.
          </p>
          {ROLE_ORDER.map((role) => {
            const info = data.roles[role];
            if (!info) return null;
            return (
              <RoleCard
                key={role}
                role={role}
                info={info}
                hostIds={hostIds}
                hostModels={hostModels}
                busy={busy}
                onSave={(patch) =>
                  send(
                    `role:${role}`,
                    `/api/admin/llm/role/${role}`,
                    "PUT",
                    patch,
                  )
                }
              />
            );
          })}

          <h4 className="sb-copy mt-[18px]">Image generation</h4>
          <ImageGenerationCard
            info={data.imageGeneration}
            busy={busy}
            onSave={(patch) =>
              send(
                "image-generation",
                "/api/admin/images/generation",
                "PUT",
                patch,
              )
            }
          />
        </div>
      )}
    </Pane>
  );
}

export const LlmHostsPane = memo(LlmHostsPaneComponent);

function numberOrFallback(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ImageGenerationCard({
  info,
  busy,
  onSave,
}: {
  info: ImageGenerationInfo;
  busy: string | null;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [enabled, setEnabled] = useState(info.enabled);
  const [autoGenerate, setAutoGenerate] = useState(
    info.autoGenerateForNewArticles,
  );
  const [autoGenerateFeatured, setAutoGenerateFeatured] = useState(
    info.autoGenerateForFeaturedArticle,
  );
  const [autoPresetMultipass, setAutoPresetMultipass] = useState(
    info.autoPresetMultipass,
  );
  const [backend, setBackend] = useState<"openai" | "ollama">(info.backend);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(info.openai.baseUrl);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState(info.openai.model);
  const [openaiSize, setOpenaiSize] = useState(info.openai.size);
  const [openaiQuality, setOpenaiQuality] = useState(info.openai.quality);
  const [openaiOutputFormat, setOpenaiOutputFormat] = useState(
    info.openai.outputFormat,
  );
  const [openaiOutputCompression, setOpenaiOutputCompression] = useState(
    String(info.openai.outputCompression),
  );
  const [openaiTimeout, setOpenaiTimeout] = useState(
    String(info.openai.timeoutMs),
  );
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(info.ollama.baseUrl);
  const [ollamaModel, setOllamaModel] = useState(info.ollama.model);
  const [ollamaWidth, setOllamaWidth] = useState(String(info.ollama.width));
  const [ollamaHeight, setOllamaHeight] = useState(String(info.ollama.height));
  const [ollamaSteps, setOllamaSteps] = useState(String(info.ollama.steps));
  const [ollamaTimeout, setOllamaTimeout] = useState(
    String(info.ollama.timeoutMs),
  );
  const saving = busy === "image-generation";

  return (
    <div className={LLM_CARD}>
      <div className={LLM_CARD_HEAD}>
        <strong>article image generation</strong>
        <label className="flex items-center gap-1.5 font-mono text-[0.78rem] text-ink uppercase">
          <Checkbox
            checked={enabled}
            onCheckedChange={(c) => setEnabled(c === true)}
          />{" "}
          enabled
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[0.78rem] text-ink uppercase">
          <Checkbox
            checked={autoGenerate}
            onCheckedChange={(c) => setAutoGenerate(c === true)}
          />{" "}
          auto for new articles
        </label>
        <label className="admin-thinking-toggle flex items-center gap-1.5">
          <Checkbox
            checked={autoGenerateFeatured}
            onCheckedChange={(c) => setAutoGenerateFeatured(c === true)}
          />{" "}
          auto for featured
        </label>
        <label className="admin-thinking-toggle flex items-center gap-1.5">
          <Checkbox
            checked={autoPresetMultipass}
            onCheckedChange={(c) => setAutoPresetMultipass(c === true)}
          />{" "}
          multipass auto preset
        </label>
      </div>

      <div className={LLM_CARD_GRID}>
        <label className={LLM_FIELD}>
          backend
          <Select
            value={backend}
            onValueChange={(value) =>
              setBackend(value === "ollama" ? "ollama" : "openai")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">openai</SelectItem>
              <SelectItem value="ollama">ollama</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>

      {backend === "openai" ? (
        <div className={LLM_CARD_GRID}>
          <label className={LLM_FIELD}>
            base_url
            <Input
              value={openaiBaseUrl}
              onChange={(e) => setOpenaiBaseUrl(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            api_key
            <Input
              type="password"
              placeholder={info.openai.apiKey || "(none)"}
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            model
            <Input
              value={openaiModel}
              onChange={(e) => setOpenaiModel(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            size
            <Input
              value={openaiSize}
              onChange={(e) => setOpenaiSize(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            quality
            <Input
              value={openaiQuality}
              onChange={(e) => setOpenaiQuality(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            output_format
            <Select
              value={openaiOutputFormat}
              onValueChange={(value) => value && setOpenaiOutputFormat(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="jpeg">jpeg</SelectItem>
                <SelectItem value="png">png</SelectItem>
                <SelectItem value="webp">webp</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className={LLM_FIELD}>
            output_compression
            <Input
              type="number"
              min="0"
              max="100"
              value={openaiOutputCompression}
              onChange={(e) => setOpenaiOutputCompression(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            timeout_ms
            <Input
              type="number"
              value={openaiTimeout}
              onChange={(e) => setOpenaiTimeout(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className={LLM_CARD_GRID}>
          <label className={LLM_FIELD}>
            base_url
            <Input
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            model
            <Input
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            width
            <Input
              type="number"
              value={ollamaWidth}
              onChange={(e) => setOllamaWidth(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            height
            <Input
              type="number"
              value={ollamaHeight}
              onChange={(e) => setOllamaHeight(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            steps
            <Input
              type="number"
              value={ollamaSteps}
              onChange={(e) => setOllamaSteps(e.target.value)}
            />
          </label>
          <label className={LLM_FIELD}>
            timeout_ms
            <Input
              type="number"
              value={ollamaTimeout}
              onChange={(e) => setOllamaTimeout(e.target.value)}
            />
          </label>
        </div>
      )}

      <p className="sb-copy text-[12px] opacity-60">
        Manual generation requires <code>enabled</code>. Automatic generation
        also requires one of the auto options.
      </p>

      <Button
        variant="default"
        disabled={saving}
        onClick={() =>
          onSave({
            enabled,
            autoGenerateForNewArticles: autoGenerate,
            autoGenerateForFeaturedArticle: autoGenerateFeatured,
            autoPresetMultipass,
            backend,
            openai: {
              baseUrl: openaiBaseUrl,
              ...(openaiApiKey ? { apiKey: openaiApiKey } : {}),
              model: openaiModel,
              size: openaiSize,
              quality: openaiQuality,
              outputFormat: openaiOutputFormat,
              outputCompression: numberOrFallback(
                openaiOutputCompression,
                info.openai.outputCompression,
              ),
              timeoutMs: numberOrFallback(openaiTimeout, info.openai.timeoutMs),
            },
            ollama: {
              baseUrl: ollamaBaseUrl,
              model: ollamaModel,
              width: numberOrFallback(ollamaWidth, info.ollama.width),
              height: numberOrFallback(ollamaHeight, info.ollama.height),
              steps: numberOrFallback(ollamaSteps, info.ollama.steps),
              timeoutMs: numberOrFallback(ollamaTimeout, info.ollama.timeoutMs),
            },
          })
        }
      >
        {saving ? "Saving…" : "Save image generation"}
      </Button>
    </div>
  );
}

function HostCard({
  host,
  busy,
  onSave,
}: {
  host: HostInfo;
  busy: string | null;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(host.base_url);
  const [apiKey, setApiKey] = useState("");
  const [maxInFlight, setMaxInFlight] = useState(String(host.max_in_flight));
  const [pref, setPref] = useState(String(host.pref));
  const [blacklist, setBlacklist] = useState(host.blacklist.join(", "));
  const saving = busy === `host:${host.id}`;

  return (
    <div className={LLM_CARD}>
      <div className={LLM_CARD_HEAD}>
        <strong>{host.id}</strong>
        <span
          className={
            host.online
              ? "font-mono text-[0.72rem] text-[#2e7d32]"
              : "font-mono text-[0.72rem] text-[#b00020]"
          }
        >
          {host.online
            ? `online · ${host.models?.length ?? 0} models`
            : "offline"}
        </span>
        <span className="opacity-60">
          {host.active}/{host.max_in_flight} in-flight · {host.queued} queued
        </span>
      </div>
      <HostUtilization host={host} />
      <div className={LLM_CARD_GRID}>
        <label className={LLM_FIELD}>
          base_url
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className={LLM_FIELD}>
          api_key
          <Input
            type="password"
            placeholder={host.api_key || "(none)"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className={LLM_FIELD}>
          queue depth
          <Input
            type="number"
            min={1}
            value={maxInFlight}
            onChange={(e) => setMaxInFlight(e.target.value)}
          />
        </label>
        <label className={LLM_FIELD}>
          pref
          <Input
            type="number"
            value={pref}
            onChange={(e) => setPref(e.target.value)}
          />
        </label>
        <label className={LLM_FIELD_WIDE}>
          blacklist (comma-sep)
          <Input
            value={blacklist}
            onChange={(e) => setBlacklist(e.target.value)}
          />
        </label>
      </div>
      <Button
        variant="default"
        disabled={saving}
        onClick={() =>
          onSave({
            base_url: baseUrl,
            ...(apiKey ? { api_key: apiKey } : {}),
            max_in_flight: Number(maxInFlight) || host.max_in_flight,
            pref: Number(pref),
            blacklist: blacklist
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        {saving ? "Saving…" : "Save host"}
      </Button>
    </div>
  );
}

function HostUtilization({ host }: { host: HostInfo }) {
  const hasJobs = host.activeJobs.length > 0 || host.queuedJobs.length > 0;
  return (
    <div className="mb-[0.6rem]">
      <div
        className="h-[0.45rem] overflow-hidden bg-[color-mix(in_srgb,var(--paper,#fff)_80%,var(--ink)_20%)] [border:1px_solid_var(--rule-strong)]"
        title={`${host.active}/${host.max_in_flight} active`}
      >
        <span
          className="block h-full bg-[#2e7d32]"
          style={{
            width: `${Math.min(100, Math.round((host.active / Math.max(host.max_in_flight, 1)) * 100))}%`,
          }}
        />
      </div>
      {hasJobs ? (
        <div className="mt-[0.45rem] grid gap-1">
          {host.activeJobs.map((job) => (
            <JobRow key={`active:${job.id}`} job={job} state="active" />
          ))}
          {host.queuedJobs.map((job) => (
            <JobRow
              key={`queued:${job.id}:${host.id}`}
              job={job}
              state="queued"
            />
          ))}
        </div>
      ) : (
        <p className="mx-0 mt-[0.35rem] mb-0 font-mono text-[0.72rem] text-[var(--muted)]">
          No active or queued LLM dispatches.
        </p>
      )}
    </div>
  );
}

function JobRow({
  job,
  state,
}: {
  job: DispatchJob;
  state: "active" | "queued";
}) {
  const topic = job.title || job.slug || "(no slug)";
  const timing =
    state === "active"
      ? `${formatDuration(job.runningMs ?? 0)} running`
      : `${formatDuration(job.queuedMs)} queued`;
  return (
    <div
      className={clsx(
        "grid grid-cols-[4.5rem_minmax(12rem,1fr)_minmax(14rem,1fr)] items-center gap-2 px-[0.45rem] py-[0.3rem] font-mono text-[0.74rem] [border:1px_solid_var(--rule)] max-[600px]:grid-cols-[1fr]",
        state === "queued" && "opacity-75",
      )}
    >
      <span className="text-[var(--muted)] uppercase">{state}</span>
      <span
        className="flex min-w-0 gap-[0.45rem] overflow-hidden text-ellipsis whitespace-nowrap"
        title={topic}
      >
        <strong>{job.role}</strong>
        <span>{job.workflow ?? "(direct)"}</span>
        <span>{topic}</span>
      </span>
      <span
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={job.candidates.join(" → ")}
      >
        {job.node ?? "llm"} · {job.model} · {timing}
      </span>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function AddHostForm({
  busy,
  onAdd,
}: {
  busy: string | null;
  onAdd: (body: Record<string, unknown>) => void;
}) {
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("local");
  const [maxInFlight, setMaxInFlight] = useState("4");
  const [pref, setPref] = useState("100");
  const saving = busy === "add-host";
  const valid = /^[A-Za-z0-9_-]+$/.test(id) && baseUrl.length > 0;

  return (
    <div className={LLM_CARD}>
      <div className={LLM_CARD_HEAD}>
        <strong>Add host</strong>
      </div>
      <div className={LLM_CARD_GRID}>
        <label className={LLM_FIELD}>
          id
          <Input
            value={id}
            placeholder="host-b"
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label className={LLM_FIELD}>
          base_url
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className={LLM_FIELD}>
          api_key
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <label className={LLM_FIELD}>
          queue depth
          <Input
            type="number"
            min={1}
            value={maxInFlight}
            onChange={(e) => setMaxInFlight(e.target.value)}
          />
        </label>
        <label className={LLM_FIELD}>
          pref
          <Input
            type="number"
            value={pref}
            onChange={(e) => setPref(e.target.value)}
          />
        </label>
      </div>
      <Button
        variant="default"
        disabled={saving || !valid}
        onClick={() =>
          onAdd({
            id,
            base_url: baseUrl,
            api_key: apiKey,
            max_in_flight: Number(maxInFlight) || 4,
            pref: Number(pref) || 100,
          })
        }
      >
        {saving ? "Adding…" : "Add host"}
      </Button>
    </div>
  );
}

function RoleCard({
  role,
  info,
  hostIds,
  hostModels,
  busy,
  onSave,
}: {
  role: RoleKey;
  info: RoleInfo;
  hostIds: string[];
  hostModels: Record<string, string[] | null>;
  busy: string | null;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [hosts, setHosts] = useState<string[]>(info.hosts);
  const [model, setModel] = useState(info.model);
  const [temperature, setTemperature] = useState(
    String(info.temperature ?? ""),
  );
  const [maxTokens, setMaxTokens] = useState(String(info.max_tokens ?? ""));
  const [topK, setTopK] = useState(
    info.top_k != null ? String(info.top_k) : "",
  );
  const [topP, setTopP] = useState(
    info.top_p != null ? String(info.top_p) : "",
  );
  const [minP, setMinP] = useState(
    info.min_p != null ? String(info.min_p) : "",
  );
  const [enabled, setEnabled] = useState(info.enabled ?? false);
  const saving = busy === `role:${role}`;
  const isEmbeddings = role === "embeddings";

  const available = hostIds.filter((h) => !hosts.includes(h));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= hosts.length) return;
    const next = [...hosts];
    [next[i], next[j]] = [next[j], next[i]];
    setHosts(next);
  };

  // Models the role can use = intersection across the selected hosts' probed
  // model lists (a role runs on all its hosts, so the model must exist on each).
  // Hosts whose capabilities are unknown (offline/unprobed) don't constrain the
  // set; if none are known we fall back to the union of every host's models.
  const modelOptions = useMemo(() => {
    const known = hosts
      .map((h) => hostModels[h])
      .filter((m): m is string[] => Array.isArray(m));
    let set: string[];
    if (known.length > 0) {
      set = known.reduce(
        (acc, list) => acc.filter((m) => list.includes(m)),
        [...known[0]],
      );
    } else {
      const union = new Set<string>();
      for (const id of Object.keys(hostModels))
        for (const m of hostModels[id] ?? []) union.add(m);
      set = [...union];
    }
    // Always keep the currently-saved model selectable even if it's not in the set.
    if (model && !set.includes(model)) set = [model, ...set];
    return set.sort();
  }, [hosts, hostModels, model]);

  return (
    <div className={LLM_CARD}>
      <div className={LLM_CARD_HEAD}>
        <strong>{ROLE_LABEL[role]}</strong>
        {isEmbeddings && (
          <label className="flex items-center gap-1.5 font-mono text-[0.78rem] text-ink uppercase">
            <Checkbox
              checked={enabled}
              onCheckedChange={(c) => setEnabled(c === true)}
            />{" "}
            enabled
          </label>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-[0.4rem]">
        {hosts.map((h, i) => (
          <span
            key={h}
            className="inline-flex items-center gap-[0.3rem] px-[0.4rem] py-[0.2rem] font-mono text-[0.78rem] [border:1px_solid_var(--rule-strong)] [&_button]:cursor-pointer [&_button]:border-none [&_button]:bg-transparent [&_button]:px-[0.15rem] [&_button]:py-0 [&_button]:text-ink [&_button:disabled]:cursor-default [&_button:disabled]:opacity-30"
          >
            <span className="opacity-50">{i + 1}.</span> {h}
            <button title="up" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              title="down"
              disabled={i === hosts.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              title="remove"
              onClick={() => setHosts(hosts.filter((x) => x !== h))}
            >
              ✕
            </button>
          </span>
        ))}
        {available.length > 0 && (
          <Select
            value={null}
            onValueChange={(h) => h && setHosts([...hosts, h])}
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="+ add host…" />
            </SelectTrigger>
            <SelectContent>
              {available.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className={LLM_CARD_GRID}>
        <label className={LLM_FIELD}>
          model
          <Select value={model} onValueChange={(v) => setModel(v ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {!isEmbeddings && (
          <label className={LLM_FIELD}>
            temperature
            <Input
              type="number"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label className={LLM_FIELD}>
            max_tokens
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label className={LLM_FIELD}>
            top_k
            <Input
              type="number"
              placeholder="default"
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label className={LLM_FIELD}>
            top_p
            <Input
              type="number"
              step="0.01"
              placeholder="default"
              value={topP}
              onChange={(e) => setTopP(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label className={LLM_FIELD}>
            min_p
            <Input
              type="number"
              step="0.01"
              placeholder="default"
              value={minP}
              onChange={(e) => setMinP(e.target.value)}
            />
          </label>
        )}
      </div>

      <p className="sb-copy text-[12px] opacity-60">
        Resolved order:{" "}
        {info.candidates.length
          ? info.candidates.join(" → ")
          : "(none — no host serves this model)"}
      </p>

      <Button
        variant="default"
        disabled={saving}
        onClick={() => {
          const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
          onSave({
            hosts,
            model,
            ...(isEmbeddings
              ? { enabled }
              : {
                  temperature: Number(temperature),
                  max_tokens: Number(maxTokens),
                  ...(num(topK) !== undefined ? { top_k: num(topK) } : {}),
                  ...(num(topP) !== undefined ? { top_p: num(topP) } : {}),
                  ...(num(minP) !== undefined ? { min_p: num(minP) } : {}),
                }),
          });
        }}
      >
        {saving ? "Saving…" : "Save role"}
      </Button>
    </div>
  );
}
