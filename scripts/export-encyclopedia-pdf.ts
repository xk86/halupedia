import { resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import { writeEncyclopediaPdfDump, writePdfDumpTombstone } from "../src/server/encyclopediaPdfDump";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--help")) {
  console.log("Usage: pnpm encyclopedia:pdf [--output path] [--database path] [--media-database path] [--tombstone path]");
  process.exit(0);
}

const config = loadConfig();
const outputPath = readFlag("--output") ?? "output/pdf/halupedia-encyclopedia.pdf";
const articleDatabasePath = readFlag("--database") ?? config.app.storage.database_path;
const mediaDatabasePath = readFlag("--media-database") ?? config.app.images.media_database_path;
const tombstonePath = readFlag("--tombstone") ?? "output/pdf/halupedia-encyclopedia.tombstone.json";

console.log(`PDF dump: article database ${resolve(articleDatabasePath)}`);
console.log(`PDF dump: media database ${resolve(mediaDatabasePath)}`);
await writeEncyclopediaPdfDump({
  articleDatabasePath,
  mediaDatabasePath,
  outputPath,
  log: console.log,
});
const publishedAt = new Date().toISOString();
writePdfDumpTombstone(tombstonePath, {
  version: 1,
  lastFullExtractionAt: publishedAt,
  lastPublishedAt: publishedAt,
});
console.log(`PDF dump: wrote tombstone ${resolve(tombstonePath)}`);
