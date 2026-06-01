import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return !!(db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined);
}

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

export interface MediaRevision {
  id: number;
  media_id: string;
  description: string;
  operation: string;
  changed_at: number;
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
    CREATE TABLE IF NOT EXISTS media_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      description TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'update',
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_revisions_media_id
      ON media_revisions(media_id, changed_at DESC);
  `);
  // Migrations
  if (!hasColumn(db, "media", "bytes")) {
    db.exec(`ALTER TABLE media ADD COLUMN bytes TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasTable(db, "media_revisions")) {
    db.exec(`
      CREATE TABLE media_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id TEXT NOT NULL,
        description TEXT NOT NULL,
        operation TEXT NOT NULL DEFAULT 'update',
        changed_at INTEGER NOT NULL
      );
      CREATE INDEX idx_media_revisions_media_id
        ON media_revisions(media_id, changed_at DESC);
    `);
  }
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
  // Record the initial upload revision
  mediaDb
    .prepare(`INSERT INTO media_revisions (media_id, description, operation, changed_at) VALUES (?, ?, ?, ?)`)
    .run(record.id, record.description, "uploaded", Date.now());
}

export function updateMediaDescription(
  mediaDb: DatabaseSync,
  id: string,
  description: string,
  operation: string = "update",
): void {
  mediaDb.prepare(`UPDATE media SET description = ? WHERE id = ?`).run(description, id);
  mediaDb
    .prepare(`INSERT INTO media_revisions (media_id, description, operation, changed_at) VALUES (?, ?, ?, ?)`)
    .run(id, description, operation, Date.now());
}

export function updateMediaId(mediaDb: DatabaseSync, oldId: string, newId: string): boolean {
  try {
    mediaDb.prepare(`UPDATE media SET id = ? WHERE id = ?`).run(newId, oldId);
    mediaDb.prepare(`UPDATE media_revisions SET media_id = ? WHERE media_id = ?`).run(newId, oldId);
    return true;
  } catch {
    return false;
  }
}

export function listMediaRevisions(mediaDb: DatabaseSync, id: string): MediaRevision[] {
  return mediaDb
    .prepare(
      `SELECT id, media_id, description, operation, changed_at
       FROM media_revisions WHERE media_id = ? ORDER BY changed_at DESC`,
    )
    .all(id) as unknown as MediaRevision[];
}

export function listMedia(mediaDb: DatabaseSync, query?: string): MediaRecord[] {
  if (query && query.trim()) {
    const pattern = `%${query.trim()}%`;
    return mediaDb
      .prepare(
        `SELECT id, sha256, source_url, mime, width, height, byte_size,
                model_b64, model_mime, model_width, model_height, description, created_at
         FROM media WHERE description LIKE ? ORDER BY created_at DESC`,
      )
      .all(pattern) as unknown as MediaRecord[];
  }
  return mediaDb
    .prepare(
      `SELECT id, sha256, source_url, mime, width, height, byte_size,
              model_b64, model_mime, model_width, model_height, description, created_at
       FROM media ORDER BY created_at DESC`,
    )
    .all() as unknown as MediaRecord[];
}
