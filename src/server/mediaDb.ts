import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface MediaRecord {
  id: string;
  sha256: string;
  source_url: string | null;
  mime: string;
  width: number;
  height: number;
  byte_size: number;
  model_b64: string;
  model_mime: string;
  model_width: number;
  model_height: number;
  description: string;
  created_at: number;
}

export function openMediaDatabase(databasePath: string): DatabaseSync {
  const absolutePath = resolve(process.cwd(), databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const db = new DatabaseSync(absolutePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      source_url TEXT,
      mime TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      bytes TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL,
      model_b64 TEXT NOT NULL,
      model_mime TEXT NOT NULL,
      model_width INTEGER NOT NULL,
      model_height INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media(sha256);
  `);
  return db;
}

export function getMediaById(mediaDb: DatabaseSync, id: string): MediaRecord | null {
  return (mediaDb
    .prepare(
      `SELECT id, sha256, source_url, mime, width, height, byte_size,
              model_b64, model_mime, model_width, model_height, description, created_at
       FROM media WHERE id = ?`,
    )
    .get(id) as MediaRecord | undefined) ?? null;
}

export function getMediaBytesById(mediaDb: DatabaseSync, id: string): { bytes: Buffer; mime: string } | null {
  const row = mediaDb
    .prepare(`SELECT bytes, mime FROM media WHERE id = ?`)
    .get(id) as { bytes: string; mime: string } | undefined;
  if (!row) return null;
  return { bytes: Buffer.from(row.bytes, "base64"), mime: row.mime };
}

export function getMediaBySha256(mediaDb: DatabaseSync, sha256: string): MediaRecord | null {
  return (mediaDb
    .prepare(
      `SELECT id, sha256, source_url, mime, width, height, byte_size,
              model_b64, model_mime, model_width, model_height, description, created_at
       FROM media WHERE sha256 = ?`,
    )
    .get(sha256) as MediaRecord | undefined) ?? null;
}

export function insertMedia(
  mediaDb: DatabaseSync,
  record: {
    id: string;
    sha256: string;
    sourceUrl: string | null;
    mime: string;
    width: number;
    height: number;
    bytes: Buffer;
    byteSize: number;
    modelB64: string;
    modelMime: string;
    modelWidth: number;
    modelHeight: number;
    description: string;
  },
): void {
  mediaDb
    .prepare(
      `INSERT INTO media
         (id, sha256, source_url, mime, width, height, bytes, byte_size,
          model_b64, model_mime, model_width, model_height, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.sha256,
      record.sourceUrl,
      record.mime,
      record.width,
      record.height,
      record.bytes.toString("base64"),
      record.byteSize,
      record.modelB64,
      record.modelMime,
      record.modelWidth,
      record.modelHeight,
      record.description,
      Date.now(),
    );
}

export function updateMediaDescription(mediaDb: DatabaseSync, id: string, description: string): void {
  mediaDb.prepare(`UPDATE media SET description = ? WHERE id = ?`).run(description, id);
}

export function updateMediaId(mediaDb: DatabaseSync, oldId: string, newId: string): boolean {
  try {
    mediaDb.prepare(`UPDATE media SET id = ? WHERE id = ?`).run(newId, oldId);
    return true;
  } catch {
    return false;
  }
}

export function listMedia(mediaDb: DatabaseSync): MediaRecord[] {
  return mediaDb
    .prepare(
      `SELECT id, sha256, source_url, mime, width, height, byte_size,
              model_b64, model_mime, model_width, model_height, description, created_at
       FROM media ORDER BY created_at DESC`,
    )
    .all() as unknown as MediaRecord[];
}
