import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { type VariantProps } from "class-variance-authority";
import { MarkdownEditor } from "../../MarkdownEditor";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PromptContent, PromptMeta, PromptRevision } from "./types";

const SOURCE_BADGE: Record<
  string,
  VariantProps<typeof badgeVariants>["variant"]
> = {
  save: "secondary",
  revert: "warn",
  startup: "outline",
};

interface ImagePromptOption {
  key: string;
  label: string;
  allowText?: boolean;
}

const BASE_IMAGE_PRESET: ImagePromptOption = {
  key: "documentary_photo",
  label: "documentary_photo",
};

function PromptEditorCardComponent({ prompt }: { prompt: PromptMeta }) {
  const [content, setContent] = useState<PromptContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baselineRef = useRef<{ system: string; user: string } | null>(null);
  const contentRequestRef = useRef(0);

  const [revisions, setRevisions] = useState<PromptRevision[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  const [newPresetName, setNewPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [imagePromptPresets, setImagePromptPresets] = useState<
    ImagePromptOption[]
  >([BASE_IMAGE_PRESET]);
  const [selectedPresetKey, setSelectedPresetKey] = useState(
    BASE_IMAGE_PRESET.key,
  );

  const isDirty =
    baselineRef.current !== null &&
    (system !== baselineRef.current.system ||
      user !== baselineRef.current.user);
  const isImagePrompt =
    prompt.scope === "runnable" && prompt.key === "article_image";
  const editingCustomImagePreset =
    isImagePrompt && selectedPresetKey !== BASE_IMAGE_PRESET.key;

  const applyContent = useCallback((data: PromptContent) => {
    setContent(data);
    setSystem(data.system);
    setUser(data.user);
    baselineRef.current = { system: data.system, user: data.user };
  }, []);

  const normalizePresetContent = useCallback(
    (data: PromptContent): PromptContent => ({
      ...prompt,
      ...data,
      scope: "runnable",
      hasModes: Boolean(data.hasModes),
    }),
    [prompt],
  );

  const loadRevisions = useCallback(async () => {
    if (editingCustomImagePreset) {
      setRevisions([]);
      setHistoryLoaded(true);
      return;
    }
    try {
      const res = await fetch(
        `/api/admin/prompt/${prompt.scope}/${prompt.key}/revisions`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setRevisions(data.revisions ?? []);
      setHistoryLoaded(true);
    } catch {
      // Revision history is non-critical.
    }
  }, [editingCustomImagePreset, prompt.key, prompt.scope]);

  const loadContent = useCallback(async () => {
    const requestId = ++contentRequestRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveMsg(null);
    setSaveError(null);
    setPreviewingId(null);
    setRevertError(null);
    setRevisions([]);
    setHistoryLoaded(false);
    try {
      const res = await fetch(
        `/api/admin/prompt/${prompt.scope}/${prompt.key}`,
      );
      if (!res.ok) throw new Error(`error ${res.status}`);
      const data: PromptContent = await res.json();
      if (contentRequestRef.current !== requestId) return;
      applyContent({ ...prompt, ...data });
    } catch (err: any) {
      if (contentRequestRef.current !== requestId) return;
      setLoadError(err?.message ?? "failed to load prompt");
      setContent(null);
    } finally {
      if (contentRequestRef.current === requestId) setLoading(false);
    }
  }, [applyContent, prompt]);

  const loadImagePresetList = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/article-image-prompts");
      if (!res.ok) {
        setImagePromptPresets([BASE_IMAGE_PRESET]);
        return;
      }
      const data = await res.json();
      const prompts = Array.isArray(data.prompts) ? data.prompts : [];
      setImagePromptPresets(prompts.length > 0 ? prompts : [BASE_IMAGE_PRESET]);
    } catch {
      setImagePromptPresets([BASE_IMAGE_PRESET]);
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
      setHistoryLoaded(false);
      try {
        const res = await fetch(
          `/api/admin/article-image-prompts/${encodeURIComponent(key)}`,
        );
        if (!res.ok) throw new Error(`error ${res.status}`);
        const data = normalizePresetContent(await res.json());
        if (contentRequestRef.current !== requestId) return;
        applyContent(data);
        setSelectedPresetKey(key);
      } catch (err: any) {
        if (contentRequestRef.current !== requestId) return;
        setLoadError(err?.message ?? "failed to load image preset");
        setContent(null);
      } finally {
        if (contentRequestRef.current === requestId) setLoading(false);
      }
    },
    [applyContent, normalizePresetContent],
  );

  useEffect(() => {
    void loadContent();
    if (isImagePrompt) void loadImagePresetList();
  }, [isImagePrompt, loadContent, loadImagePresetList]);

  const handlePresetSelect = useCallback(
    (key: string) => {
      setPresetError(null);
      if (key === BASE_IMAGE_PRESET.key) {
        setSelectedPresetKey(BASE_IMAGE_PRESET.key);
        void loadContent();
        return;
      }
      void loadImagePresetContent(key);
    },
    [loadContent, loadImagePresetContent],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    setSaveError(null);
    try {
      const res = await fetch(
        editingCustomImagePreset
          ? `/api/admin/article-image-prompts/${encodeURIComponent(selectedPresetKey)}`
          : `/api/admin/prompt/${prompt.scope}/${prompt.key}`,
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
      if (data.prompt) {
        setContent(normalizePresetContent(data.prompt));
      }
      setHistoryLoaded(false);
      if (historyOpen && !editingCustomImagePreset) void loadRevisions();
    } catch (err: any) {
      setSaveError(err?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }, [
    editingCustomImagePreset,
    historyOpen,
    loadRevisions,
    normalizePresetContent,
    prompt.key,
    prompt.scope,
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
    if (editingCustomImagePreset) {
      void loadImagePresetContent(selectedPresetKey);
      return;
    }
    void loadContent();
  }, [
    editingCustomImagePreset,
    loadContent,
    loadImagePresetContent,
    selectedPresetKey,
  ]);

  const handlePreview = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(
          `/api/admin/prompt/${prompt.scope}/${prompt.key}/revisions/${id}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        setSystem(data.system);
        setUser(data.user);
        setPreviewingId(id);
        setSaveMsg(null);
        setSaveError(null);
      } catch {
        // Preview failure leaves the current editor content intact.
      }
    },
    [prompt.key, prompt.scope],
  );

  const handleRevert = useCallback(
    async (id: number) => {
      setRevertingId(id);
      setRevertError(null);
      try {
        const res = await fetch(
          `/api/admin/prompt/${prompt.scope}/${prompt.key}/revisions/${id}/revert`,
          { method: "POST" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRevertError(data?.error ?? `error ${res.status}`);
          return;
        }
        setSaveMsg("Reverted — runtime reloaded.");
        setPreviewingId(null);
        if (data.prompt) applyContent({ ...prompt, ...data.prompt });
        void loadRevisions();
      } catch (err: any) {
        setRevertError(err?.message ?? "revert failed");
      } finally {
        setRevertingId(null);
      }
    },
    [applyContent, loadRevisions, prompt],
  );

  const handleCreatePreset = useCallback(async () => {
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
      if (Array.isArray(data.prompts)) setImagePromptPresets(data.prompts);
      if (data.prompt) {
        const created = normalizePresetContent(data.prompt);
        applyContent(created);
        setSelectedPresetKey(created.key);
        setHistoryLoaded(false);
      }
      setNewPresetName("");
      setSaveMsg("Preset created.");
    } catch (err: any) {
      setPresetError(err?.message ?? "failed to create preset");
    } finally {
      setPresetBusy(false);
    }
  }, [applyContent, newPresetName, normalizePresetContent, selectedPresetKey]);

  const handleDeletePreset = useCallback(async () => {
    if (selectedPresetKey === BASE_IMAGE_PRESET.key) return;
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
        Array.isArray(data.prompts) ? data.prompts : [BASE_IMAGE_PRESET],
      );
      setSelectedPresetKey(BASE_IMAGE_PRESET.key);
      void loadContent();
      setSaveMsg("Preset deleted.");
    } catch (err: any) {
      setPresetError(err?.message ?? "failed to delete preset");
    } finally {
      setPresetBusy(false);
    }
  }, [loadContent, selectedPresetKey]);

  const cardKey = `${prompt.scope}-${prompt.key}`;

  return (
    <Card
      size="sm"
      data-testid={`prompt-editor-${cardKey}`}
      className="min-w-0"
    >
      <CardHeader>
        <CardTitle>
          <h3 className="font-mono">{prompt.key}</h3>
        </CardTitle>
        <CardDescription>{prompt.description}</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1">
          <Badge variant="outline">{prompt.scope}</Badge>
          {prompt.model ? (
            <Badge variant="secondary">{prompt.model}</Badge>
          ) : null}
          {prompt.usedBy.map((usage) => (
            <Badge key={usage} variant="outline">
              {usage}
            </Badge>
          ))}
        </CardAction>
      </CardHeader>

      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading prompt…</p>
        ) : null}
        {loadError ? <FieldError>{loadError}</FieldError> : null}

        {content && !loading ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${cardKey}-path`}>Source file</FieldLabel>
              <Input
                id={`${cardKey}-path`}
                value={content.path}
                readOnly
                className="font-mono"
              />
              {content.model !== undefined ? (
                <FieldDescription>
                  Model: {content.model}. Thinking:{" "}
                  {content.thinking ? "on" : "off"}.
                  {content.json ? " JSON mode: on." : null} Change these in
                  Prompt Models.
                </FieldDescription>
              ) : null}
            </Field>

            {content.hasModes ? (
              <FieldDescription>
                This file has a modes table. Saving preserves it; this editor
                only changes the system and user values.
              </FieldDescription>
            ) : null}

            {isImagePrompt ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${cardKey}-preset`}>
                    Image preset
                  </FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={selectedPresetKey}
                      onValueChange={(value) =>
                        value && handlePresetSelect(value)
                      }
                      disabled={loading || presetBusy}
                      items={Object.fromEntries(
                        imagePromptPresets.map((preset) => [
                          preset.key,
                          preset.label,
                        ]),
                      )}
                    >
                      <SelectTrigger
                        id={`${cardKey}-preset`}
                        className="min-w-56 flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {imagePromptPresets.map((preset) => (
                            <SelectItem key={preset.key} value={preset.key}>
                              {preset.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={handleDeletePreset}
                      disabled={
                        presetBusy ||
                        selectedPresetKey === BASE_IMAGE_PRESET.key
                      }
                    >
                      Delete preset
                    </Button>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${cardKey}-new-preset`}>
                    New preset
                  </FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id={`${cardKey}-new-preset`}
                      value={newPresetName}
                      onChange={(event) => {
                        setNewPresetName(event.target.value);
                        setPresetError(null);
                      }}
                      placeholder="New preset name…"
                      disabled={presetBusy}
                      className="min-w-56 flex-1"
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
                  {presetError ? <FieldError>{presetError}</FieldError> : null}
                </Field>
              </FieldGroup>
            ) : null}

            <Field>
              <FieldLabel>System</FieldLabel>
              <MarkdownEditor
                ariaLabel={`${prompt.key} system prompt`}
                value={system}
                onChange={(value) => {
                  setSystem(value);
                  setSaveMsg(null);
                  setPreviewingId(null);
                }}
                minRows={10}
                maxRows={24}
              />
            </Field>

            <Field>
              <FieldLabel>User</FieldLabel>
              <MarkdownEditor
                ariaLabel={`${prompt.key} user prompt`}
                value={user}
                onChange={(value) => {
                  setUser(value);
                  setSaveMsg(null);
                  setPreviewingId(null);
                }}
                minRows={6}
                maxRows={16}
              />
            </Field>

            {!editingCustomImagePreset ? (
              <Collapsible
                open={historyOpen}
                onOpenChange={(open) => {
                  setHistoryOpen(open);
                  if (open && !historyLoaded) void loadRevisions();
                }}
              >
                <CollapsibleTrigger
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  <ChevronDown data-icon="inline-start" />
                  History
                  {historyLoaded ? ` (${revisions.length})` : null}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-2 pt-2">
                    {historyLoaded && revisions.length === 0 ? (
                      <FieldDescription>
                        No revisions recorded.
                      </FieldDescription>
                    ) : null}
                    {revisions.map((revision) => (
                      <div
                        key={revision.id}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {new Date(revision.createdAt).toLocaleString()}
                        </span>
                        <Badge
                          variant={SOURCE_BADGE[revision.source] ?? "outline"}
                          className="uppercase"
                        >
                          {revision.source}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePreview(revision.id)}
                          disabled={previewingId === revision.id}
                        >
                          {previewingId === revision.id
                            ? "Previewing"
                            : "Preview"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevert(revision.id)}
                          disabled={revertingId === revision.id}
                        >
                          {revertingId === revision.id
                            ? "Reverting…"
                            : "Revert"}
                        </Button>
                      </div>
                    ))}
                    {revertError ? (
                      <FieldError>{revertError}</FieldError>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </FieldGroup>
        ) : null}
      </CardContent>

      {content && !loading ? (
        <CardFooter className="flex-wrap gap-2 border-t">
          <Button onClick={handleSave} disabled={saving || !isDirty}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="outline" onClick={handleReset} disabled={!isDirty}>
            Reset
          </Button>
          <Button variant="outline" onClick={handleReload} disabled={loading}>
            Reload
          </Button>
          {isDirty ? (
            <span className="text-sm text-muted-foreground">
              {previewingId !== null
                ? `Previewing revision #${previewingId}; save to apply.`
                : "Unsaved changes."}
            </span>
          ) : null}
          {saveMsg ? <span className="text-sm">{saveMsg}</span> : null}
          {saveError ? <FieldError>{saveError}</FieldError> : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

export const PromptEditorCard = memo(PromptEditorCardComponent);
