import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { PdfDumpMode } from "./encyclopediaPdfDump";

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
  projectRoot?: string;
}

const FILES: Record<PdfDumpMode, string> = {
  full: "halupedia-encyclopedia.pdf",
  update: "halupedia-encyclopedia-update.pdf",
};

const PACKAGE_SCRIPTS: Record<PdfDumpMode, string> = {
  full: "encyclopedia:pdf",
  update: "encyclopedia:pdf:update",
};

export function createEncyclopediaPdfExportJobs(options: Options) {
  const outputDir = resolve(options.outputDir ?? "output/pdf");
  const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const tombstonePath = join(outputDir, "halupedia-encyclopedia.tombstone.json");
  let runId = 0;
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
    const id = ++runId;
    const script = PACKAGE_SCRIPTS[mode];
    const args = [
      "run", script, "--",
      "--output", outputPath(mode),
      "--database", options.articleDatabasePath,
      "--media-database", options.mediaDatabasePath,
      "--tombstone", tombstonePath,
    ];
    current = {
      mode,
      state: "running",
      startedAt: Date.now(),
      completedAt: null,
      articleCount: null,
      error: null,
      logs: [`$ pnpm ${args.join(" ")}`],
    };

    const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let articleCount: number | null = null;
    let sawNoChanges = false;
    const acceptLine = (line: string, source: "stdout" | "stderr") => {
      if (id !== runId || !line) return;
      appendLog(source === "stderr" ? `[stderr] ${line}` : line);
      const count = line.match(/^PDF dump: loading (\d+) current articles$/);
      if (count) articleCount = Number(count[1]);
      if (line.startsWith("PDF update: no article changes since ")) sawNoChanges = true;
    };
    pipeOutput(child.stdout, (line) => acceptLine(line, "stdout"));
    pipeOutput(child.stderr, (line) => acceptLine(line, "stderr"));
    child.once("error", (error) => {
      if (id !== runId) return;
      current = { ...current, state: "failed", completedAt: Date.now(), error: error.message };
    });
    child.once("close", (code) => {
      if (id !== runId || current.state !== "running") return;
      if (code !== 0) {
        current = { ...current, state: "failed", completedAt: Date.now(), error: `PDF command exited with code ${code ?? "unknown"}` };
      } else if (sawNoChanges) {
        current = { ...current, state: "no_changes", completedAt: Date.now(), articleCount: 0 };
      } else if (existsSync(outputPath(mode))) {
        current = { ...current, state: "complete", completedAt: Date.now(), articleCount };
      } else {
        current = { ...current, state: "failed", completedAt: Date.now(), error: "PDF command completed without an output file" };
      }
    });
    return status();
  };

  return { start, status, outputPath };
}

function pipeOutput(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  let buffer = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream?.on("end", () => {
    if (buffer) onLine(buffer);
  });
}

function fileStatus(path: string): { available: boolean; updatedAt: number | null } {
  if (!existsSync(path)) return { available: false, updatedAt: null };
  return { available: true, updatedAt: statSync(path).mtimeMs };
}
