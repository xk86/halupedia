import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import {
  loadEncyclopediaPdfDump,
  readPdfDumpTombstone,
  writeEncyclopediaPdfDump,
  writePdfDumpTombstone,
} from "../src/server/encyclopediaPdfDump";

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

if (!existsSync(tombstonePath)) {
  throw new Error(`No full-extraction tombstone exists at ${resolve(tombstonePath)}. Run pnpm encyclopedia:pdf first.`);
}

const tombstone = readPdfDumpTombstone(tombstonePath);
const since = Date.parse(tombstone.lastPublishedAt);
const changed = loadEncyclopediaPdfDump(articleDatabasePath, mediaDatabasePath, since);
if (changed.length === 0) {
  console.log(`PDF update: no article changes since ${tombstone.lastPublishedAt}`);
  process.exit(0);
}

console.log(`PDF update: article database ${resolve(articleDatabasePath)}`);
console.log(`PDF update: media database ${resolve(mediaDatabasePath)}`);
console.log(`PDF update: publishing ${changed.length} articles since ${tombstone.lastPublishedAt}`);
await writeEncyclopediaPdfDump({
  articleDatabasePath,
  mediaDatabasePath,
  outputPath,
  since,
  log: console.log,
});
const publishedAt = new Date().toISOString();
writePdfDumpTombstone(tombstonePath, { ...tombstone, lastPublishedAt: publishedAt });
console.log(`PDF update: wrote tombstone ${resolve(tombstonePath)}`);
