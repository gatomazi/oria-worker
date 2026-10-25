// Cópia do banco agora: npm run backup  (DATA_DIR, e R2 se MEDIA_BACKEND=r2).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { backupDb } from '../src/platform/backup.ts';
import { R2BlobStore } from '../src/platform/blobs.ts';

const dataDir = process.env.DATA_DIR ?? 'data';
const db = new DatabaseSync(join(dataDir, 'pink.db'));
const r2 =
  process.env.MEDIA_BACKEND === 'r2'
    ? new R2BlobStore({
        endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        bucket: process.env.R2_BUCKET,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      })
    : null;
const out = await backupDb(db, dataDir, r2);
db.close();
console.log(`cópia: ${out.file}${out.remoteKey ? ` · R2: ${out.remoteKey}` : ''}`);
