import initSqlJs, { type Database } from "sql.js";
import { Preferences } from "@capacitor/preferences";
import { generateId } from "@/lib/utils";
import type { FileChunk, FileItem, FolderItem, SearchParams } from "@/types";

// Import WASM as a URL so Vite handles it correctly
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

const DB_KEY = "unlimitade-db";
let db: Database | null = null;

export async function initDatabase(): Promise<void> {
  // Fetch WASM manually to avoid MIME type issues
  const wasmResponse = await fetch(sqlWasmUrl);
  const wasmBinary = await wasmResponse.arrayBuffer();

  const SQL = await initSqlJs({
    wasmBinary,
  });

  // Try to load existing DB
  const { value } = await Preferences.get({ key: DB_KEY });
  if (value) {
    try {
      const buf = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      db = new SQL.Database(buf);
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parentId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (parentId) REFERENCES folders(id) ON DELETE SET NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      originalName TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size TEXT NOT NULL,
      telegramFileId TEXT NOT NULL,
      telegramMessageId INTEGER NOT NULL,
      thumbnailFileId TEXT,
      thumbnailMessageId INTEGER,
      isImage INTEGER NOT NULL DEFAULT 0,
      isVideo INTEGER NOT NULL DEFAULT 0,
      isFavorite INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration INTEGER,
      folderId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      dateTaken TEXT,
      FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE SET NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folderId);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_image ON files(isImage);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_favorite ON files(isFavorite);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parentId);`);

  // Migration: add chunks column if it doesn't exist (for existing databases)
  try {
    db.run(`ALTER TABLE files ADD COLUMN chunks TEXT;`);
  } catch {
    // Column already exists — safe to ignore
  }

  await saveDatabase();
}

export async function saveDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export();
  // Convert in slices: spreading the whole export into String.fromCharCode()
  // exceeds the engine's argument limit once the database passes ~100 KB.
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  const base64 = btoa(binary);
  await Preferences.set({ key: DB_KEY, value: base64 });
}

function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

// ---- Files ----

function rowToFile(row: Record<string, unknown>): FileItem {
  let chunks: FileChunk[] | null = null;
  if (row.chunks) {
    try {
      chunks = JSON.parse(row.chunks as string);
    } catch {
      chunks = null;
    }
  }
  return {
    id: row.id as string,
    originalName: row.originalName as string,
    mimeType: row.mimeType as string,
    size: row.size as string,
    isImage: !!(row.isImage as number),
    isVideo: !!(row.isVideo as number),
    isFavorite: !!(row.isFavorite as number),
    folderId: (row.folderId as string) || null,
    telegramFileId: row.telegramFileId as string,
    telegramMessageId: row.telegramMessageId as number,
    thumbnailFileId: (row.thumbnailFileId as string) || null,
    thumbnailMessageId: (row.thumbnailMessageId as number) || null,
    width: (row.width as number) || null,
    height: (row.height as number) || null,
    createdAt: row.createdAt as string,
    dateTaken: (row.dateTaken as string) || null,
    chunks,
  };
}

export function getFiles(folderId?: string | null): FileItem[] {
  const d = getDb();
  const stmt = folderId
    ? d.prepare("SELECT * FROM files WHERE folderId = ? ORDER BY createdAt DESC", [folderId])
    : d.prepare("SELECT * FROM files WHERE folderId IS NULL ORDER BY createdAt DESC");

  const results: FileItem[] = [];
  while (stmt.step()) {
    results.push(rowToFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getPhotos(): FileItem[] {
  const d = getDb();
  const stmt = d.prepare(
    "SELECT * FROM files WHERE isImage = 1 OR isVideo = 1 ORDER BY COALESCE(dateTaken, createdAt) DESC"
  );
  const results: FileItem[] = [];
  while (stmt.step()) {
    results.push(rowToFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getFavorites(): FileItem[] {
  const d = getDb();
  const stmt = d.prepare("SELECT * FROM files WHERE isFavorite = 1 ORDER BY createdAt DESC");
  const results: FileItem[] = [];
  while (stmt.step()) {
    results.push(rowToFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export interface CreateFileData {
  originalName: string;
  mimeType: string;
  size: number;
  telegramFileId: string;
  telegramMessageId: number;
  thumbnailFileId?: string | null;
  thumbnailMessageId?: number | null;
  isImage: boolean;
  isVideo: boolean;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  dateTaken?: string | null;
  chunks?: FileChunk[] | null;
}

export async function createFile(data: CreateFileData): Promise<FileItem> {
  const d = getDb();
  const id = generateId();
  const now = new Date().toISOString();

  d.run(
    `INSERT INTO files (id, originalName, mimeType, size, telegramFileId, telegramMessageId,
      thumbnailFileId, thumbnailMessageId, isImage, isVideo, width, height, folderId, createdAt, updatedAt, dateTaken, chunks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, data.originalName, data.mimeType, String(data.size),
      data.telegramFileId, data.telegramMessageId,
      data.thumbnailFileId || null, data.thumbnailMessageId || null,
      data.isImage ? 1 : 0, data.isVideo ? 1 : 0,
      data.width || null, data.height || null,
      data.folderId || null, now, now, data.dateTaken || null,
      data.chunks ? JSON.stringify(data.chunks) : null,
    ]
  );

  await saveDatabase();

  return {
    id,
    originalName: data.originalName,
    mimeType: data.mimeType,
    size: String(data.size),
    isImage: data.isImage,
    isVideo: data.isVideo,
    isFavorite: false,
    folderId: data.folderId || null,
    telegramFileId: data.telegramFileId,
    telegramMessageId: data.telegramMessageId,
    thumbnailFileId: data.thumbnailFileId || null,
    thumbnailMessageId: data.thumbnailMessageId || null,
    width: data.width || null,
    height: data.height || null,
    createdAt: now,
    dateTaken: data.dateTaken || null,
    chunks: data.chunks || null,
  };
}

export async function updateFile(id: string, updates: Partial<Pick<FileItem, "originalName" | "isFavorite" | "folderId">>): Promise<void> {
  const d = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.originalName !== undefined) {
    sets.push("originalName = ?");
    values.push(updates.originalName);
  }
  if (updates.isFavorite !== undefined) {
    sets.push("isFavorite = ?");
    values.push(updates.isFavorite ? 1 : 0);
  }
  if (updates.folderId !== undefined) {
    sets.push("folderId = ?");
    values.push(updates.folderId);
  }

  if (sets.length === 0) return;

  sets.push("updatedAt = ?");
  values.push(new Date().toISOString());
  values.push(id);

  d.run(`UPDATE files SET ${sets.join(", ")} WHERE id = ?`, values);
  await saveDatabase();
}

export async function deleteFile(id: string): Promise<FileItem | null> {
  const d = getDb();
  const stmt = d.prepare("SELECT * FROM files WHERE id = ?", [id]);
  let file: FileItem | null = null;
  if (stmt.step()) {
    file = rowToFile(stmt.getAsObject());
  }
  stmt.free();

  if (file) {
    d.run("DELETE FROM files WHERE id = ?", [id]);
    await saveDatabase();
  }
  return file;
}

export function getFileById(id: string): FileItem | null {
  const d = getDb();
  const stmt = d.prepare("SELECT * FROM files WHERE id = ?", [id]);
  let file: FileItem | null = null;
  if (stmt.step()) {
    file = rowToFile(stmt.getAsObject());
  }
  stmt.free();
  return file;
}

// ---- Folders ----

function rowToFolder(row: Record<string, unknown>): FolderItem {
  return {
    id: row.id as string,
    name: row.name as string,
    parentId: (row.parentId as string) || null,
    createdAt: row.createdAt as string,
  };
}

function getFolderCounts(folderId: string): { files: number; children: number } {
  const d = getDb();
  const fileStmt = d.prepare("SELECT COUNT(*) as c FROM files WHERE folderId = ?", [folderId]);
  fileStmt.step();
  const files = (fileStmt.getAsObject().c as number) || 0;
  fileStmt.free();

  const childStmt = d.prepare("SELECT COUNT(*) as c FROM folders WHERE parentId = ?", [folderId]);
  childStmt.step();
  const children = (childStmt.getAsObject().c as number) || 0;
  childStmt.free();

  return { files, children };
}

export function getFolders(parentId?: string | null): FolderItem[] {
  const d = getDb();
  const stmt = parentId
    ? d.prepare("SELECT * FROM folders WHERE parentId = ? ORDER BY name ASC", [parentId])
    : d.prepare("SELECT * FROM folders WHERE parentId IS NULL ORDER BY name ASC");

  const results: FolderItem[] = [];
  while (stmt.step()) {
    const folder = rowToFolder(stmt.getAsObject());
    folder._count = getFolderCounts(folder.id);
    results.push(folder);
  }
  stmt.free();
  return results;
}

export async function createFolder(name: string, parentId?: string | null): Promise<FolderItem> {
  const d = getDb();
  const id = generateId();
  const now = new Date().toISOString();

  d.run(
    "INSERT INTO folders (id, name, parentId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    [id, name, parentId || null, now, now]
  );

  await saveDatabase();

  return {
    id,
    name,
    parentId: parentId || null,
    createdAt: now,
    _count: { files: 0, children: 0 },
  };
}

export async function updateFolder(id: string, name: string): Promise<void> {
  const d = getDb();
  d.run("UPDATE folders SET name = ?, updatedAt = ? WHERE id = ?", [name, new Date().toISOString(), id]);
  await saveDatabase();
}

export async function deleteFolder(id: string): Promise<void> {
  const d = getDb();
  // Move files in this folder to root
  d.run("UPDATE files SET folderId = NULL WHERE folderId = ?", [id]);
  // Move child folders to root
  d.run("UPDATE folders SET parentId = NULL WHERE parentId = ?", [id]);
  d.run("DELETE FROM folders WHERE id = ?", [id]);
  await saveDatabase();
}

export function getFolderById(id: string): FolderItem | null {
  const d = getDb();
  const stmt = d.prepare("SELECT * FROM folders WHERE id = ?", [id]);
  let folder: FolderItem | null = null;
  if (stmt.step()) {
    folder = rowToFolder(stmt.getAsObject());
    folder._count = getFolderCounts(folder.id);
  }
  stmt.free();
  return folder;
}

export function getFolderPath(folderId: string): FolderItem[] {
  const path: FolderItem[] = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const folder = getFolderById(currentId);
    if (!folder) break;
    path.unshift(folder);
    currentId = folder.parentId;
  }

  return path;
}

// ---- Search ----

export function searchFiles(params: SearchParams): FileItem[] {
  const d = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.q) {
    conditions.push("originalName LIKE ?");
    values.push(`%${params.q}%`);
  }

  if (params.type) {
    switch (params.type) {
      case "images":
        conditions.push("isImage = 1");
        break;
      case "videos":
        conditions.push("isVideo = 1");
        break;
      case "audio":
        conditions.push("mimeType LIKE 'audio/%'");
        break;
      case "pdfs":
        conditions.push("mimeType = 'application/pdf'");
        break;
    }
  }

  if (params.dateFrom) {
    conditions.push("createdAt >= ?");
    values.push(params.dateFrom + "T00:00:00.000Z");
  }
  if (params.dateTo) {
    conditions.push("createdAt <= ?");
    values.push(params.dateTo + "T23:59:59.999Z");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = d.prepare(`SELECT * FROM files ${where} ORDER BY createdAt DESC`, values);

  const results: FileItem[] = [];
  while (stmt.step()) {
    results.push(rowToFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}
