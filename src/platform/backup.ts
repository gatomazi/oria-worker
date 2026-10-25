// Cópia do banco: VACUUM INTO gera um arquivo consistente sem parar o serviço.
// Guarda as últimas cópias em DATA_DIR/backups e, com R2 configurado, envia para backups/.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import type { BlobStore } from './blobs.ts';

export const KEEP_LOCAL = 7;

export async function backupDb(db: Db, dataDir: string, remote: BlobStore | null, now = new Date()): Promise<{ file: string; remoteKey: string | null }> {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const name = `pink-${now.toISOString().replace(/[:.]/g, '-')}.db`;
  const file = join(dir, name);
  db.prepare('VACUUM INTO ?').run(file);
  const old = readdirSync(dir).filter((f) => /^pink-.*\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_LOCAL))) rmSync(join(dir, f));
  let remoteKey: string | null = null;
  if (remote && remote.kind === 'r2') {
    remoteKey = `backups/${name}`;
    await remote.put(remoteKey, readFileSync(file), 'application/vnd.sqlite3');
  }
  return { file, remoteKey };
}

export function startBackupLoop(run: () => Promise<unknown>, everyHours: number, log: (m: string) => void): () => void {
  if (!everyHours) return () => undefined;
  const timer = setInterval(() => void run().catch((err: Error) => log(`cópia do banco falhou: ${err.message}`)), everyHours * 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}
