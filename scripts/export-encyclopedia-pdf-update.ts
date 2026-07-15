import { resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import { runEncyclopediaPdfDumpJob } from "../src/server/encyclopediaPdfDump";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--help")) {
  console.log("Usage: pnpm encyclopedia:pdf:update [--output path] [--database path] [--media-database path] [--tombstone path]");
  process.exit(0);
}

const config = loadConfig();
const outputPath = readFlag("--output") ?? "output/pdf/halupedia-encyclopedia-update.pdf";
const articleDatabasePath = readFlag("--database") ?? config.app.storage.database_path;
const mediaDatabasePath = readFlag("--media-database") ?? config.app.images.media_database_path;
const tombstonePath = readFlag("--tombstone") ?? "output/pdf/halupedia-encyclopedia.tombstone.json";

console.log(`PDF update: article database ${resolve(articleDatabasePath)}`);
console.log(`PDF update: media database ${resolve(mediaDatabasePath)}`);
await runEncyclopediaPdfDumpJob({
  mode: "update",
  articleDatabasePath,
  mediaDatabasePath,
  outputPath,
  tombstonePath,
  log: console.log,
});
