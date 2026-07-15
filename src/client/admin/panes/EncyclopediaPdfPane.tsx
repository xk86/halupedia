import { useCallback, useEffect, useState } from "react";
import { Download, FilePlus2, LoaderCircle, RefreshCw } from "lucide-react";
import { Pane } from "../Pane";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ExportMode = "full" | "update";
type ExportState = "idle" | "running" | "complete" | "no_changes" | "failed";

interface ExportStatus {
  mode: ExportMode | null;
  state: ExportState;
  startedAt: number | null;
  completedAt: number | null;
  articleCount: number | null;
  error: string | null;
  logs: string[];
  downloads: Record<ExportMode, { available: boolean; updatedAt: number | null }>;
}

const STATE_LABELS: Record<ExportState, string> = {
  idle: "Idle",
  running: "Generating",
  complete: "Ready",
  no_changes: "No changes",
  failed: "Failed",
};

async function readStatus(): Promise<ExportStatus> {
  const response = await fetch("/api/admin/encyclopedia-pdf");
  const body = await response.json() as ExportStatus | { error?: string };
  if (!response.ok) throw new Error(("error" in body && body.error) || "Could not load PDF export status");
  return body as ExportStatus;
}

export function EncyclopediaPdfPane() {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await readStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (status?.state !== "running") return;
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [refresh, status?.state]);

  const start = useCallback(async (mode: ExportMode) => {
    try {
      const response = await fetch(`/api/admin/encyclopedia-pdf/${mode}`, { method: "POST" });
      const body = await response.json() as ExportStatus | { error?: string };
      if (!response.ok) throw new Error(("error" in body && body.error) || "Could not start PDF export");
      setStatus(body as ExportStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const running = status?.state === "running";
  return (
    <Pane
      id="encyclopedia-pdf"
      title="Encyclopedia PDF"
      description="Generate full or incremental downloadable encyclopedia revisions in a worker thread."
      count={status ? STATE_LABELS[status.state] : "Loading"}
      actions={
        <Button variant="ghost" size="icon-xs" onClick={() => void refresh()} aria-label="Refresh PDF export status" title="Refresh status">
          <RefreshCw className={cn(running && "animate-spin")} />
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void start("full")} disabled={running}>
          {running && status?.mode === "full" ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <FilePlus2 data-icon="inline-start" />}
          Generate full
        </Button>
        <Button variant="outline" size="sm" onClick={() => void start("update")} disabled={running}>
          {running && status?.mode === "update" ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <FilePlus2 data-icon="inline-start" />}
          Generate updates
        </Button>
        {(["full", "update"] as const).map((mode) => (
          status?.downloads[mode].available ? (
            <a key={mode} className={buttonVariants({ variant: "secondary", size: "sm" })} href={`/api/admin/encyclopedia-pdf/${mode}/download`} download>
              <Download data-icon="inline-start" />
              Download {mode}
            </a>
          ) : null
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {running ? "The server stays responsive while the PDF worker reads and renders the encyclopedia." : status?.state === "complete" ? `${status.articleCount ?? 0} articles included in the latest ${status.mode} export.` : "A full export sets the checkpoint used by later update exports."}
      </p>
      {error || status?.error ? <p className="mt-2 text-xs text-destructive">{error ?? status?.error}</p> : null}
      {status?.logs.length ? (
        <pre className="mt-3 max-h-44 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs leading-5 text-muted-foreground">{status.logs.slice(-8).join("\n")}</pre>
      ) : null}
    </Pane>
  );
}
