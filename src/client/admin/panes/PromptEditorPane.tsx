import { useCallback, useEffect, useRef, useState } from "react";
import { Pane } from "../Pane";

interface PromptMeta {
  key: string;
  scope: "runnable" | "shared";
  model?: "heavy" | "light";
  thinking?: boolean;
  json?: boolean;
  hasModes: boolean;
}

interface PromptContent extends PromptMeta {
  system: string;
  user: string;
  path: string;
}

interface PromptList {
  runnable: PromptMeta[];
  shared: PromptMeta[];
}

export function PromptEditorPane() {
  const [promptList, setPromptList] = useState<PromptList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ scope: "runnable" | "shared"; key: string } | null>(null);
  const [content, setContent] = useState<PromptContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baselineRef = useRef<{ system: string; user: string } | null>(null);

  const isDirty =
    baselineRef.current !== null &&
    (system !== baselineRef.current.system || user !== baselineRef.current.user);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch("/api/admin/prompts");
      if (!res.ok) throw new Error(`error ${res.status}`);
      setPromptList(await res.json());
    } catch (err: any) {
      setListError(err?.message ?? "failed to load prompts");
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const loadContent = useCallback(async (scope: "runnable" | "shared", key: string) => {
    setLoading(true);
    setLoadError(null);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/prompt/${scope}/${key}`);
      if (!res.ok) throw new Error(`error ${res.status}`);
      const data: PromptContent = await res.json();
      setContent(data);
      setSystem(data.system);
      setUser(data.user);
      baselineRef.current = { system: data.system, user: data.user };
    } catch (err: any) {
      setLoadError(err?.message ?? "failed to load prompt");
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelect = useCallback((value: string) => {
    if (!value) { setSelected(null); setContent(null); return; }
    const [scope, ...rest] = value.split(":");
    const key = rest.join(":");
    if (scope !== "runnable" && scope !== "shared") return;
    setSelected({ scope, key });
    loadContent(scope, key);
  }, [loadContent]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/prompt/${selected.scope}/${selected.key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, user }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveError(data?.error ?? `error ${res.status}`); return; }
      setSaveMsg("Saved — runtime reloaded.");
      baselineRef.current = { system, user };
      if (data.prompt) setContent(data.prompt);
    } catch (err: any) {
      setSaveError(err?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }, [selected, system, user]);

  const handleReset = useCallback(() => {
    if (!baselineRef.current) return;
    setSystem(baselineRef.current.system);
    setUser(baselineRef.current.user);
    setSaveMsg(null);
    setSaveError(null);
  }, []);

  const handleReload = useCallback(() => {
    if (!selected) return;
    loadContent(selected.scope, selected.key);
  }, [selected, loadContent]);

  const allPrompts: Array<{ scope: "runnable" | "shared"; key: string }> = promptList
    ? [
        ...promptList.runnable.map((p) => ({ scope: "runnable" as const, key: p.key })),
        ...promptList.shared.map((p) => ({ scope: "shared" as const, key: p.key })),
      ]
    : [];

  return (
    <Pane id="prompt-editor" title="Prompt Editor" wide defaultCollapsed>
      {listError && <p className="search-error">{listError}</p>}

      <div className="admin-prompt-editor">
        <div className="admin-prompt-select-row">
          <select
            className="admin-model-select admin-prompt-select"
            value={selected ? `${selected.scope}:${selected.key}` : ""}
            onChange={(e) => handleSelect(e.target.value)}
            disabled={!promptList}
          >
            <option value="">Select a prompt…</option>
            {promptList && promptList.runnable.length > 0 && (
              <optgroup label="Runnable">
                {promptList.runnable.map((p) => (
                  <option key={p.key} value={`runnable:${p.key}`}>{p.key}</option>
                ))}
              </optgroup>
            )}
            {promptList && promptList.shared.length > 0 && (
              <optgroup label="Shared">
                {promptList.shared.map((p) => (
                  <option key={p.key} value={`shared:${p.key}`}>{p.key}</option>
                ))}
              </optgroup>
            )}
          </select>
          {selected && (
            <button className="admin-btn" type="button" onClick={handleReload} disabled={loading}>
              Reload from disk
            </button>
          )}
        </div>

        {loading && <p className="sb-copy">Loading…</p>}
        {loadError && <p className="search-error">{loadError}</p>}

        {content && !loading && (
          <>
            <div className="admin-prompt-meta">
              <span>file: <code>{content.path}</code></span>
              {content.model !== undefined && (
                <span> • model: {content.model} • thinking: {content.thinking ? "on" : "off"}{content.json ? " • json: on" : ""}</span>
              )}
              {content.model !== undefined && (
                <span className="admin-prompt-meta-hint"> — edit model/thinking in Prompt Models pane</span>
              )}
            </div>

            {content.hasModes && (
              <div className="admin-prompt-modes-warn">
                This file has a <code>modes</code> table. It will be preserved on save but is not shown here.
              </div>
            )}

            <label className="admin-prompt-label">
              System
              <textarea
                className="admin-prompt-textarea"
                value={system}
                onChange={(e) => { setSystem(e.target.value); setSaveMsg(null); }}
                spellCheck={false}
                rows={14}
              />
            </label>

            <label className="admin-prompt-label">
              User
              <textarea
                className="admin-prompt-textarea"
                value={user}
                onChange={(e) => { setUser(e.target.value); setSaveMsg(null); }}
                spellCheck={false}
                rows={8}
              />
            </label>

            <div className="admin-prompt-actions">
              <button
                className="all-entries-more-btn"
                type="button"
                onClick={handleSave}
                disabled={saving || !isDirty}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                className="admin-btn"
                type="button"
                onClick={handleReset}
                disabled={!isDirty}
              >
                Reset
              </button>
              {isDirty && <span className="admin-prompt-dirty">unsaved changes</span>}
              {saveMsg && <span className="admin-prompt-saved">{saveMsg}</span>}
              {saveError && <span className="search-error admin-prompt-save-error">{saveError}</span>}
            </div>
          </>
        )}
      </div>
    </Pane>
  );
}
