import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownEditor } from "../../MarkdownEditor";
import { Pane } from "../Pane";
import { Button } from "@/components/ui/button";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type VariantProps } from "class-variance-authority";

/** Map a prompt-history source ("save" | "revert" | "startup") to a badge look. */
const SOURCE_BADGE: Record<
  string,
  VariantProps<typeof badgeVariants>["variant"]
> = {
  save: "secondary",
  revert: "warn",
  startup: "outline",
};

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

interface PromptRevision {
  id: number;
  scope: string;
  key: string;
  createdAt: number;
  source: string;
  sourceRevisionId: number | null;
}

interface ImagePromptOption {
  key: string;
  label: string;
}

export function PromptEditorPane() {
  const [promptList, setPromptList] = useState<PromptList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    scope: "runnable" | "shared";
    key: string;
  } | null>(null);
  const [content, setContent] = useState<PromptContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baselineRef = useRef<{ system: string; user: string } | null>(null);

  const [revisions, setRevisions] = useState<PromptRevision[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [newPresetName, setNewPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [imagePromptPresets, setImagePromptPresets] = useState<
    ImagePromptOption[]
  >([{ key: "default", label: "default" }]);
  const [selectedPresetKey, setSelectedPresetKey] = useState("default");
  const contentRequestRef = useRef(0);

  const isDirty =
    baselineRef.current !== null &&
    (system !== baselineRef.current.system ||
      user !== baselineRef.current.user);

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

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadRevisions = useCallback(
    async (scope: string, key: string, requestId?: number) => {
      try {
        const res = await fetch(`/api/admin/prompt/${scope}/${key}/revisions`);
        if (!res.ok) return;
        const data = await res.json();
        if (requestId !== undefined && contentRequestRef.current !== requestId)
          return;
        setRevisions(data.revisions ?? []);
      } catch {
        // history is non-critical
      }
    },
    [],
  );

  const normalizePresetContent = useCallback(
    (data: PromptContent): PromptContent => ({
      ...data,
      scope: "runnable",
      hasModes: Boolean(data.hasModes),
    }),
    [],
  );

  const loadImagePresetList = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/article-image-prompts");
      if (!res.ok) {
        setImagePromptPresets([{ key: "default", label: "default" }]);
        return;
      }
      const data = await res.json();
      const prompts = Array.isArray(data.prompts) ? data.prompts : [];
      setImagePromptPresets(
        prompts.length > 0 ? prompts : [{ key: "default", label: "default" }],
      );
    } catch {
      setImagePromptPresets([{ key: "default", label: "default" }]);
    }
  }, []);

  const loadImagePresetContent = useCallback(
    async (key: string) => {
      const requestId = ++contentRequestRef.current;
      setLoading(true);
      setLoadError(null);
      setSaveMsg(null);
      setSaveError(null);
      setPreviewingId(null);
      setRevertError(null);
      setRevisions([]);
      try {
        const res = await fetch(
          `/api/admin/article-image-prompts/${encodeURIComponent(key)}`,
        );
        if (!res.ok) throw new Error(`error ${res.status}`);
        const data = normalizePresetContent(await res.json());
        if (contentRequestRef.current !== requestId) return;
        setContent(data);
        setSystem(data.system);
        setUser(data.user);
        baselineRef.current = { system: data.system, user: data.user };
        setSelectedPresetKey(key);
      } catch (err: any) {
        if (contentRequestRef.current !== requestId) return;
        setLoadError(err?.message ?? "failed to load image preset");
        setContent(null);
      } finally {
        if (contentRequestRef.current === requestId) setLoading(false);
      }
    },
    [normalizePresetContent],
  );

  const loadContent = useCallback(
    async (scope: "runnable" | "shared", key: string) => {
      const requestId = ++contentRequestRef.current;
      setLoading(true);
      setLoadError(null);
      setSaveMsg(null);
      setSaveError(null);
      setPreviewingId(null);
      setRevertError(null);
      setRevisions([]);
      try {
        const res = await fetch(`/api/admin/prompt/${scope}/${key}`);
        if (!res.ok) throw new Error(`error ${res.status}`);
        const data: PromptContent = await res.json();
        if (contentRequestRef.current !== requestId) return;
        setContent(data);
        setSystem(data.system);
        setUser(data.user);
        baselineRef.current = { system: data.system, user: data.user };
      } catch (err: any) {
        if (contentRequestRef.current !== requestId) return;
        setLoadError(err?.message ?? "failed to load prompt");
        setContent(null);
      } finally {
        if (contentRequestRef.current === requestId) setLoading(false);
      }
      loadRevisions(scope, key, requestId);
    },
    [loadRevisions],
  );

  const handleSelect = useCallback(
    (value: string) => {
      if (!value) {
        contentRequestRef.current += 1;
        setSelected(null);
        setContent(null);
        setImagePromptPresets([{ key: "default", label: "default" }]);
        setSelectedPresetKey("default");
        return;
      }
      const [scope, ...rest] = value.split(":");
      const key = rest.join(":");
      if (scope !== "runnable" && scope !== "shared") return;
      setSelected({ scope, key });
      setPresetError(null);
      setSelectedPresetKey("default");
      if (scope === "runnable" && key === "article_image") {
        void loadImagePresetList();
      } else {
        setImagePromptPresets([{ key: "default", label: "default" }]);
      }
      loadContent(scope, key);
    },
    [loadContent, loadImagePresetList],
  );

  const handlePresetSelect = useCallback(
    (key: string) => {
      if (
        !selected ||
        selected.scope !== "runnable" ||
        selected.key !== "article_image"
      )
        return;
      setPresetError(null);
      if (key === "default") {
        setSelectedPresetKey("default");
        loadContent("runnable", "article_image");
        return;
      }
      void loadImagePresetContent(key);
    },
    [loadContent, loadImagePresetContent, selected],
  );

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const isCustomImagePreset =
        selected.scope === "runnable" &&
        selected.key === "article_image" &&
        selectedPresetKey !== "default";
      const res = await fetch(
        isCustomImagePreset
          ? `/api/admin/article-image-prompts/${encodeURIComponent(selectedPresetKey)}`
          : `/api/admin/prompt/${selected.scope}/${selected.key}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ system, user }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(data?.error ?? `error ${res.status}`);
        return;
      }
      setSaveMsg("Saved — runtime reloaded.");
      baselineRef.current = { system, user };
      setPreviewingId(null);
      if (data.prompt) setContent(normalizePresetContent(data.prompt));
      if (isCustomImagePreset) {
        setRevisions([]);
      } else {
        loadRevisions(selected.scope, selected.key);
      }
    } catch (err: any) {
      setSaveError(err?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }, [
    loadRevisions,
    normalizePresetContent,
    selected,
    selectedPresetKey,
    system,
    user,
  ]);

  const handleReset = useCallback(() => {
    if (!baselineRef.current) return;
    setSystem(baselineRef.current.system);
    setUser(baselineRef.current.user);
    setSaveMsg(null);
    setSaveError(null);
    setPreviewingId(null);
  }, []);

  const handleReload = useCallback(() => {
    if (!selected) return;
    if (
      selected.scope === "runnable" &&
      selected.key === "article_image" &&
      selectedPresetKey !== "default"
    ) {
      void loadImagePresetContent(selectedPresetKey);
      return;
    }
    loadContent(selected.scope, selected.key);
  }, [selected, loadContent, loadImagePresetContent, selectedPresetKey]);

  const handlePreview = useCallback(
    async (id: number) => {
      if (!selected) return;
      try {
        const res = await fetch(
          `/api/admin/prompt/${selected.scope}/${selected.key}/revisions/${id}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        setSystem(data.system);
        setUser(data.user);
        setPreviewingId(id);
        setSaveMsg(null);
        setSaveError(null);
      } catch {
        // ignore
      }
    },
    [selected],
  );

  const handleRevert = useCallback(
    async (id: number) => {
      if (!selected) return;
      setRevertingId(id);
      setRevertError(null);
      try {
        const res = await fetch(
          `/api/admin/prompt/${selected.scope}/${selected.key}/revisions/${id}/revert`,
          {
            method: "POST",
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRevertError(data?.error ?? `error ${res.status}`);
          return;
        }
        setSaveMsg("Reverted — runtime reloaded.");
        setPreviewingId(null);
        if (data.prompt) {
          const p: PromptContent = data.prompt;
          setContent(p);
          setSystem(p.system);
          setUser(p.user);
          baselineRef.current = { system: p.system, user: p.user };
        }
        loadRevisions(selected.scope, selected.key);
      } catch (err: any) {
        setRevertError(err?.message ?? "revert failed");
      } finally {
        setRevertingId(null);
      }
    },
    [selected, loadRevisions],
  );

  const selectedImagePreset =
    selected?.scope === "runnable" && selected.key === "article_image";
  const editingCustomImagePreset =
    selectedImagePreset && selectedPresetKey !== "default";

  const handleCreatePreset = useCallback(async () => {
    if (!selectedImagePreset || !selected) return;
    setPresetBusy(true);
    setPresetError(null);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/article-image-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newPresetName,
          copyFrom: selectedPresetKey,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPresetError(data?.error ?? `error ${res.status}`);
        return;
      }
      const prompts = Array.isArray(data.prompts)
        ? data.prompts
        : imagePromptPresets;
      setImagePromptPresets(prompts);
      const prompt = data.prompt
        ? normalizePresetContent(data.prompt)
        : undefined;
      if (prompt) {
        setContent(prompt);
        setSystem(prompt.system);
        setUser(prompt.user);
        baselineRef.current = { system: prompt.system, user: prompt.user };
        setSelectedPresetKey(prompt.key);
        setPreviewingId(null);
        setRevisions([]);
      }
      setNewPresetName("");
      setSaveMsg("Preset created.");
    } catch (err: any) {
      setPresetError(err?.message ?? "failed to create preset");
    } finally {
      setPresetBusy(false);
    }
  }, [
    imagePromptPresets,
    newPresetName,
    normalizePresetContent,
    selected,
    selectedImagePreset,
    selectedPresetKey,
  ]);

  const handleDeletePreset = useCallback(async () => {
    if (!selectedImagePreset || !selected || selectedPresetKey === "default")
      return;
    setPresetBusy(true);
    setPresetError(null);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/admin/article-image-prompts/${encodeURIComponent(selectedPresetKey)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPresetError(data?.error ?? `error ${res.status}`);
        return;
      }
      setImagePromptPresets(
        Array.isArray(data.prompts)
          ? data.prompts
          : [{ key: "default", label: "default" }],
      );
      setSelectedPresetKey("default");
      loadContent("runnable", "article_image");
      setSaveMsg("Preset deleted.");
    } catch (err: any) {
      setPresetError(err?.message ?? "failed to delete preset");
    } finally {
      setPresetBusy(false);
    }
  }, [loadContent, selected, selectedImagePreset, selectedPresetKey]);

  return (
    <Pane id="prompt-editor" title="Prompt Editor" wide defaultCollapsed>
      {listError && <p className="search-error">{listError}</p>}

      <div className="admin-prompt-editor">
        <div className="admin-prompt-select-row">
          <Select
            value={selected ? `${selected.scope}:${selected.key}` : null}
            onValueChange={(v) => handleSelect((v as string) ?? "")}
            disabled={!promptList}
            // `items` maps each value (scope:key) to its display label (key) so
            // the trigger shows the bare key, not the scoped value.
            items={Object.fromEntries([
              ...(promptList?.runnable ?? []).map((p) => [
                `runnable:${p.key}`,
                p.key,
              ]),
              ...(promptList?.shared ?? []).map((p) => [
                `shared:${p.key}`,
                p.key,
              ]),
            ])}
          >
            <SelectTrigger className="admin-prompt-select w-full">
              <SelectValue placeholder="Select a prompt…" />
            </SelectTrigger>
            <SelectContent>
              {promptList && promptList.runnable.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Runnable</SelectLabel>
                  {promptList.runnable.map((p) => (
                    <SelectItem key={p.key} value={`runnable:${p.key}`}>
                      {p.key}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {promptList && promptList.shared.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Shared</SelectLabel>
                  {promptList.shared.map((p) => (
                    <SelectItem key={p.key} value={`shared:${p.key}`}>
                      {p.key}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          {selected && (
            <Button variant="outline" onClick={handleReload} disabled={loading}>
              Reload
            </Button>
          )}
        </div>

        {selectedImagePreset && (
          <div className="admin-prompt-presets">
            <div className="admin-prompt-preset-row">
              <label className="admin-prompt-preset-label">
                Image preset
                <Select
                  value={selectedPresetKey}
                  onValueChange={(value) => value && handlePresetSelect(value)}
                  disabled={loading || presetBusy}
                  items={Object.fromEntries(
                    imagePromptPresets.map((preset) => [
                      preset.key,
                      preset.label,
                    ]),
                  )}
                >
                  <SelectTrigger className="admin-prompt-preset-select w-full">
                    <SelectValue placeholder="Image preset" />
                  </SelectTrigger>
                  <SelectContent>
                    {imagePromptPresets.map((preset) => (
                      <SelectItem key={preset.key} value={preset.key}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <Button
                variant="outline"
                type="button"
                onClick={handleDeletePreset}
                disabled={
                  presetBusy || !selected || selectedPresetKey === "default"
                }
              >
                Delete preset
              </Button>
            </div>
            <div className="admin-prompt-preset-row">
              <Input
                className="admin-prompt-preset-name"
                value={newPresetName}
                onChange={(e) => {
                  setNewPresetName(e.target.value);
                  setPresetError(null);
                }}
                placeholder="New preset name…"
                disabled={presetBusy}
              />
              <Button
                variant="outline"
                type="button"
                onClick={handleCreatePreset}
                disabled={presetBusy || !newPresetName.trim()}
              >
                {presetBusy ? "Working…" : "Add preset"}
              </Button>
            </div>
            {presetError && (
              <p className="search-error admin-prompt-save-error">
                {presetError}
              </p>
            )}
          </div>
        )}

        {loading && <p className="sb-copy">Loading…</p>}
        {loadError && <p className="search-error">{loadError}</p>}

        {content && !loading && (
          <>
            <div className="admin-prompt-meta">
              <span>
                file: <code>{content.path}</code>
              </span>
              {content.model !== undefined && (
                <span>
                  {" "}
                  • model: {content.model} • thinking:{" "}
                  {content.thinking ? "on" : "off"}
                  {content.json ? " • json: on" : ""}
                </span>
              )}
              {content.model !== undefined && (
                <span className="admin-prompt-meta-hint">
                  {" "}
                  — edit model/thinking in Prompt Models pane
                </span>
              )}
            </div>

            {content.hasModes && (
              <div className="admin-prompt-modes-warn">
                This file has a <code>modes</code> table. It will be preserved
                on save but is not shown here.
              </div>
            )}

            <label className="admin-prompt-label">
              System
              <MarkdownEditor
                className="admin-prompt-mdedit"
                value={system}
                onChange={(v) => {
                  setSystem(v);
                  setSaveMsg(null);
                  setPreviewingId(null);
                }}
                minRows={10}
              />
            </label>

            <label className="admin-prompt-label">
              User
              <MarkdownEditor
                className="admin-prompt-mdedit"
                value={user}
                onChange={(v) => {
                  setUser(v);
                  setSaveMsg(null);
                  setPreviewingId(null);
                }}
                minRows={6}
              />
            </label>

            <div className="admin-prompt-actions">
              <Button
                variant="default"
                onClick={handleSave}
                disabled={saving || !isDirty}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={!isDirty}
              >
                Reset
              </Button>
              {isDirty && (
                <span className="admin-prompt-dirty">
                  {previewingId !== null
                    ? `previewing revision #${previewingId} — save to apply`
                    : "unsaved changes"}
                </span>
              )}
              {saveMsg && <span className="admin-prompt-saved">{saveMsg}</span>}
              {saveError && (
                <span className="search-error admin-prompt-save-error">
                  {saveError}
                </span>
              )}
            </div>

            {!editingCustomImagePreset && revisions.length > 0 && (
              <div className="admin-prompt-history">
                <button
                  className="admin-prompt-history-toggle"
                  type="button"
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  {historyOpen ? "▾" : "▸"} History ({revisions.length})
                </button>
                {historyOpen && (
                  <ul className="admin-prompt-history-list">
                    {revisions.map((rev) => (
                      <li key={rev.id} className="admin-prompt-history-row">
                        <span className="admin-prompt-history-time">
                          {new Date(rev.createdAt).toLocaleString()}
                        </span>
                        <Badge
                          variant={SOURCE_BADGE[rev.source] ?? "outline"}
                          className="uppercase"
                        >
                          {rev.source}
                        </Badge>
                        <Button
                          variant="outline"
                          onClick={() => handlePreview(rev.id)}
                          disabled={previewingId === rev.id}
                        >
                          {previewingId === rev.id ? "Previewing" : "Preview"}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleRevert(rev.id)}
                          disabled={revertingId === rev.id}
                        >
                          {revertingId === rev.id ? "Reverting…" : "Revert"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {revertError && (
                  <p className="search-error" style={{ marginTop: "0.4rem" }}>
                    {revertError}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Pane>
  );
}
