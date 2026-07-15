import { parentPort, workerData } from "node:worker_threads";
import { runEncyclopediaPdfDumpJob, type PdfDumpMode } from "./encyclopediaPdfDump";

interface WorkerData {
  mode: PdfDumpMode;
  articleDatabasePath: string;
  mediaDatabasePath: string;
  outputPath: string;
  tombstonePath: string;
}

const data = workerData as WorkerData;

void runEncyclopediaPdfDumpJob({
  ...data,
  log: (message) => parentPort?.postMessage({ type: "log", message }),
})
  .then((result) => parentPort?.postMessage({ type: "complete", result }))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ type: "failed", error: message });
  })
  .finally(() => parentPort?.close());
