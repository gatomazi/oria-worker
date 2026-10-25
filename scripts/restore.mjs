// Restaura uma cópia do banco. Com o serviço PARADO:  npm run restore -- <arquivo.db>
// Confere a integridade da cópia antes; o banco atual fica guardado ao lado (pink.db.antes-<data>).
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('Uso: npm run restore -- <arquivo.db>');
  process.exit(2);
}
const check = new DatabaseSync(resolve(src), { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
const version = check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
check.close();
if (Object.values(ok)[0] !== 'ok') {
  console.error('A cópia não passou na verificação de integridade. Nada foi alterado.');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? 'data';
const target = join(dataDir, 'pink.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (existsSync(target)) renameSync(target, `${target}.antes-${stamp}`);
for (const extra of ['-wal', '-shm']) if (existsSync(target + extra)) rmSync(target + extra);
copyFileSync(resolve(src), target);
console.log(`Restaurado ${src} → ${target} (migração ${version.v}). O banco anterior ficou em ${target}.antes-${stamp}. Inicie o serviço: as migrações novas, se houver, rodam na subida.`);
