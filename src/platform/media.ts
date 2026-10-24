// Arquivos de vídeo e capa enviados pelo painel. Local: DATA_DIR/media/<loja>/<id>.
// Em produção: armazenamento de objetos (ex.: R2) servido pelo Worker.
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';

export const MEDIA_TYPES: Record<string, 'video' | 'image'> = {
  'video/mp4': 'video',
  'video/webm': 'video',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
};
export const MEDIA_LIMIT = 60 * 1024 * 1024;
export const MEDIA_ID = /^[a-f0-9]{24}$/;

export class MediaStore {
  private db: Db;
  private dir: string;
  constructor(db: Db, dataDir: string) {
    this.db = db;
    this.dir = join(dataDir, 'media');
  }

  private file(storeId: string, id: string): string {
    return join(this.dir, storeId, id);
  }

  async save(storeId: string, id: string, mime: string, body: Buffer, originalName: string): Promise<{ id: string; url: string; kind: string }> {
    const kind = MEDIA_TYPES[mime];
    if (!kind) throw new Error('tipo não aceito');
    await mkdir(join(this.dir, storeId), { recursive: true });
    const tmp = `${this.file(storeId, id)}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.file(storeId, id));
    this.db
      .prepare('INSERT INTO media (id, store_id, kind, mime, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, storeId, kind, mime, body.length, originalName.slice(0, 120), new Date().toISOString());
    return { id, url: `/__pink/media/${id}`, kind };
  }

  list(storeId: string): { id: string; kind: string; mime: string; size: number; originalName: string; url: string }[] {
    return (this.db.prepare('SELECT * FROM media WHERE store_id = ? ORDER BY created_at DESC').all(storeId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      mime: String(r.mime),
      size: Number(r.size),
      originalName: String(r.original_name),
      url: `/__pink/media/${r.id}`,
    }));
  }

  /** Serve com suporte a Range (o Safari exige para MP4). */
  async serve(storeId: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!MEDIA_ID.test(id)) return false;
    const row = this.db.prepare('SELECT mime FROM media WHERE id = ? AND store_id = ?').get(id, storeId) as { mime: string } | undefined;
    if (!row) return false;
    const path = this.file(storeId, id);
    const { size } = await stat(path);
    const headers: Record<string, string> = {
      'content-type': row.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return true;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      if (req.method === 'HEAD') res.end();
      else createReadStream(path, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    if (req.method === 'HEAD') res.end();
    else createReadStream(path).pipe(res);
    return true;
  }
}
