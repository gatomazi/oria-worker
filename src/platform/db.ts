// Banco local (SQLite embutido no Node). Um arquivo: DATA_DIR/pink.db.
// Em produção este papel seria de um banco gerenciado + KV para a leitura no edge.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ink', 'demo')),
    status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'paused')),
    owner_name TEXT NOT NULL DEFAULT '',
    owner_email TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL,
    base_path TEXT NOT NULL,
    dev_host TEXT NOT NULL UNIQUE,
    dev_origin TEXT NOT NULL,
    integration TEXT NOT NULL DEFAULT '{}',
    extra_modules TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('operator', 'merchant')),
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
    password_hash TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    CHECK ((role = 'operator' AND store_id IS NULL) OR (role = 'merchant' AND store_id IS NOT NULL))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at TEXT
  );
  CREATE TABLE packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    modules TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE store_packages (
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    PRIMARY KEY (store_id, package_id)
  );
  CREATE TABLE drafts (
    store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
    config TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  );
  CREATE TABLE publications (
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    config TEXT NOT NULL,
    published_at TEXT NOT NULL,
    published_by INTEGER,
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (store_id, version)
  );
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'image')),
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user_id INTEGER,
    store_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE chat_usage (
    store_id TEXT NOT NULL,
    day TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, day)
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'pink.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
    });
  }
  return db;
}

/** Transação síncrona: tudo ou nada. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
