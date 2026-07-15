import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { PdfDumpJobResult, PdfDumpMode } from "./encyclopediaPdfDump";

type JobState = "idle" | "running" | "complete" | "no_changes" | "failed";

export interface PdfExportJobStatus {
  mode: PdfDumpMode | null;
  state: JobState;
  startedAt: number | null;
  completedAt: number | null;
  articleCount: number | null;
  error: string | null;
  logs: string[];
  downloads: Record<PdfDumpMode, { available: boolean; updatedAt: number | null }>;
}

interface Options {
  articleDatabasePath: string;
  mediaDatabasePath: string;
  outputDir?: string;
}

const FILES: Record<PdfDumpMode, string> = {
  full: "halupedia-encyclopedia.pdf",
  update: "halupedia-encyclopedia-update.pdf",
};

export function createEncyclopediaPdfExportJobs(options: Options) {
  const outputDir = resolve(options.outputDir ?? "output/pdf");
  const tombstonePath = join(outputDir, "halupedia-encyclopedia.tombstone.json");
  let current: Omit<PdfExportJobStatus, "downloads"> = {
    mode: null,
    state: "idle",
    startedAt: null,
    completedAt: null,
    articleCount: null,
    error: null,
    logs: [],
  };

  const outputPath = (mode: PdfDumpMode) => join(outputDir, FILES[mode]);
  const appendLog = (message: string) => {
    current = { ...current, logs: [...current.logs.slice(-49), message] };
  };
  const status = (): PdfExportJobStatus => ({
    ...current,
    logs: [...current.logs],
    downloads: {
      full: fileStatus(outputPath("full")),
      update: fileStatus(outputPath("update")),
    },
  });

  const start = (mode: PdfDumpMode): PdfExportJobStatus | null => {
    if (current.state === "running") return null;
    current = {
      mode,
      state: "running",
      startedAt: Date.now(),
      completedAt: null,
      articleCount: null,
      error: null,
      logs: [`PDF ${mode}: worker started`],
    };
    // Worker threads do not reliably inherit the parent's tsx ESM loader.
    const worker = new Worker(new URL("./encyclopediaPdfExportWorker.ts", import.meta.url), {
      execArgv: ["--import", "tsx/esm"],
      workerData: {
        mode,
        articleDatabasePath: options.articleDatabasePath,
        mediaDatabasePath: options.mediaDatabasePath,
        outputPath: outputPath(mode),
        tombstonePath,
      },
    });
    worker.on("message", (message: { type: string; message?: string; result?: PdfDumpJobResult; error?: string }) => {
      if (message.type === "log" && message.message) appendLog(message.message);
      if (message.type === "complete" && message.result) {
        current = {
          ...current,
          state: message.result.noChanges ? "no_changes" : "complete",
          completedAt: Date.now(),
          articleCount: message.result.articleCount,
        };
      }
      if (message.type === "failed") {
        current = { ...current, state: "failed", completedAt: Date.now(), error: message.error ?? "PDF worker failed" };
      }
    });
    worker.once("error", (error: unknown) => {
      current = {
        ...current,
        state: "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    });
    worker.once("exit", (code) => {
      if (code !== 0 && current.state === "running") {
        current = { ...current, state: "failed", completedAt: Date.now(), error: `PDF worker exited with code ${code}` };
      }
    });
    return status();
  };

  return { start, status, outputPath };
}

function fileStatus(path: string): { available: boolean; updatedAt: number | null } {
  if (!existsSync(path)) return { available: false, updatedAt: null };
  return { available: true, updatedAt: statSync(path).mtimeMs };
}
