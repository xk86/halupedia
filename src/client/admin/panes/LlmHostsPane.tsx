import { useCallback, useEffect, useMemo, useState } from "react";
import { Pane } from "../Pane";
import { AdminButton } from "../AdminButton";

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
}

const ROLE_ORDER: RoleKey[] = ["heavy", "light", "images", "embeddings"];
const ROLE_LABEL: Record<RoleKey, string> = {
  heavy: "heavy (llm.chat)",
  light: "light (llm.light)",
  images: "images (llm.images)",
  embeddings: "embeddings (llm.embeddings)",
};

export function LlmHostsPane() {
  const [data, setData] = useState<LlmConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/llm");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as LlmConfigResponse);
      setError(null);
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
      {error && <div className="search-error">{error}</div>}
      {!data ? (
        <p className="sb-copy">Loading…</p>
      ) : (
        <div className="llm-hosts">
          <h4 className="sb-copy">Hosts</h4>
          <p className="sb-copy" style={{ opacity: 0.7 }}>
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

          <h4 className="sb-copy" style={{ marginTop: 18 }}>
            Roles
          </h4>
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
        </div>
      )}
    </Pane>
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
    <div className="llm-card">
      <div className="llm-card-head">
        <strong>{host.id}</strong>
        <span className={host.online ? "llm-dot-online" : "llm-dot-offline"}>
          {host.online
            ? `online · ${host.models?.length ?? 0} models`
            : "offline"}
        </span>
        <span style={{ opacity: 0.6 }}>
          {host.active}/{host.max_in_flight} in-flight · {host.queued} queued
        </span>
      </div>
      <HostUtilization host={host} />
      <div className="llm-card-grid">
        <label>
          base_url
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          api_key
          <input
            type="password"
            placeholder={host.api_key || "(none)"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          queue depth
          <input
            type="number"
            min={1}
            value={maxInFlight}
            onChange={(e) => setMaxInFlight(e.target.value)}
          />
        </label>
        <label>
          pref
          <input
            type="number"
            value={pref}
            onChange={(e) => setPref(e.target.value)}
          />
        </label>
        <label className="llm-wide">
          blacklist (comma-sep)
          <input
            value={blacklist}
            onChange={(e) => setBlacklist(e.target.value)}
          />
        </label>
      </div>
      <AdminButton
        variant="primary"
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
      </AdminButton>
    </div>
  );
}

function HostUtilization({ host }: { host: HostInfo }) {
  const hasJobs = host.activeJobs.length > 0 || host.queuedJobs.length > 0;
  return (
    <div className="llm-utilization">
      <div
        className="llm-util-bar"
        title={`${host.active}/${host.max_in_flight} active`}
      >
        <span
          style={{
            width: `${Math.min(100, Math.round((host.active / Math.max(host.max_in_flight, 1)) * 100))}%`,
          }}
        />
      </div>
      {hasJobs ? (
        <div className="llm-job-list">
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
        <p className="llm-job-empty">No active or queued LLM dispatches.</p>
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
    <div className={`llm-job-row llm-job-row--${state}`}>
      <span className="llm-job-state">{state}</span>
      <span className="llm-job-main" title={topic}>
        <strong>{job.role}</strong>
        <span>{job.workflow ?? "(direct)"}</span>
        <span>{topic}</span>
      </span>
      <span className="llm-job-meta" title={job.candidates.join(" → ")}>
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
    <div className="llm-card">
      <div className="llm-card-head">
        <strong>Add host</strong>
      </div>
      <div className="llm-card-grid">
        <label>
          id
          <input
            value={id}
            placeholder="host-b"
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label>
          base_url
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          api_key
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <label>
          queue depth
          <input
            type="number"
            min={1}
            value={maxInFlight}
            onChange={(e) => setMaxInFlight(e.target.value)}
          />
        </label>
        <label>
          pref
          <input
            type="number"
            value={pref}
            onChange={(e) => setPref(e.target.value)}
          />
        </label>
      </div>
      <AdminButton
        variant="primary"
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
      </AdminButton>
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
    <div className="llm-card">
      <div className="llm-card-head">
        <strong>{ROLE_LABEL[role]}</strong>
        {isEmbeddings && (
          <label className="admin-thinking-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{" "}
            enabled
          </label>
        )}
      </div>

      <div className="llm-host-list">
        {hosts.map((h, i) => (
          <span key={h} className="llm-host-chip">
            <span style={{ opacity: 0.5 }}>{i + 1}.</span> {h}
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
          <select
            className="admin-model-select"
            value=""
            onChange={(e) =>
              e.target.value && setHosts([...hosts, e.target.value])
            }
          >
            <option value="">+ add host…</option>
            {available.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="llm-card-grid">
        <label>
          model
          <select
            className="admin-model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {!isEmbeddings && (
          <label>
            temperature
            <input
              type="number"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label>
            max_tokens
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label>
            top_k
            <input
              type="number"
              placeholder="default"
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label>
            top_p
            <input
              type="number"
              step="0.01"
              placeholder="default"
              value={topP}
              onChange={(e) => setTopP(e.target.value)}
            />
          </label>
        )}
        {!isEmbeddings && (
          <label>
            min_p
            <input
              type="number"
              step="0.01"
              placeholder="default"
              value={minP}
              onChange={(e) => setMinP(e.target.value)}
            />
          </label>
        )}
      </div>

      <p className="sb-copy" style={{ opacity: 0.6, fontSize: 12 }}>
        Resolved order:{" "}
        {info.candidates.length
          ? info.candidates.join(" → ")
          : "(none — no host serves this model)"}
      </p>

      <AdminButton
        variant="primary"
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
      </AdminButton>
    </div>
  );
}
