// Arquivos de vídeo e capa enviados pelo painel. O registro fica no banco; o conteúdo, no
// armazenamento configurado (local em DATA_DIR/media ou R2). Servidos pelo Worker em /__pink/media.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import type { BlobStore } from './blobs.ts';

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
  private blobs: BlobStore;
  constructor(db: Db, blobs: BlobStore) {
    this.db = db;
    this.blobs = blobs;
  }

  get backend(): BlobStore['kind'] {
    return this.blobs.kind;
  }

  async save(storeId: string, id: string, mime: string, body: Buffer, originalName: string): Promise<{ id: string; url: string; kind: string }> {
    const kind = MEDIA_TYPES[mime];
    if (!kind) throw new Error('tipo não aceito');
    await this.blobs.put(`${storeId}/${id}`, body, mime);
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

  /** Serve com suporte a Range (o Safari exige para MP4). Só arquivos da própria loja. */
  async serve(storeId: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!MEDIA_ID.test(id)) return false;
    const row = this.db.prepare('SELECT mime FROM media WHERE id = ? AND store_id = ?').get(id, storeId) as { mime: string } | undefined;
    if (!row) return false;
    const head = req.method === 'HEAD';
    const got = await this.blobs.get(`${storeId}/${id}`, typeof req.headers.range === 'string' ? req.headers.range : undefined, head);
    if (!got) return false;
    if (got.status === 416) {
      res.writeHead(416, got.headers);
      res.end();
      return true;
    }
    res.writeHead(got.status, {
      'content-type': row.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      ...got.headers,
    });
    if (got.body) got.body.pipe(res);
    else res.end();
    return true;
  }
}
