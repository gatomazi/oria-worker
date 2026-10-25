// Armazenamento dos arquivos de mídia (vídeos e capas).
//  - Local: DATA_DIR/media/<loja>/<id> (desenvolvimento e testes).
//  - R2: API compatível com S3, assinada com AWS SigV4 (node:crypto, sem biblioteca extra).
// As duas devolvem a resposta já no formato HTTP (status, cabeçalhos, corpo em fluxo),
// com suporte a Range: o Safari exige isso para tocar MP4.
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';

export interface BlobRead {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: Readable | null;
}

export interface BlobStore {
  readonly kind: 'local' | 'r2';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** range: valor do cabeçalho Range do pedido, repassado como veio. */
  get(key: string, range: string | undefined, head: boolean): Promise<BlobRead | null>;
}

const safeKey = (key: string) => {
  if (!/^[a-z0-9-]{3,40}\/[a-f0-9]{24}$/.test(key) && !/^backups\/[\w.-]{1,120}$/.test(key)) throw new Error('chave inválida');
  return key;
};

export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const;
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'media');
  }
  private file(key: string) {
    return join(this.dir, ...safeKey(key).split('/'));
  }
  async put(key: string, body: Buffer): Promise<void> {
    const file = this.file(key);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
  }
  async get(key: string, range: string | undefined, head: boolean): Promise<BlobRead | null> {
    const file = this.file(key);
    const size = await stat(file).then((s) => s.size).catch(() => -1);
    if (size < 0) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return { status: 416, headers: { 'content-range': `bytes */${size}` }, body: null };
      return { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }, body: head ? null : createReadStream(file, { start, end }) };
    }
    return { status: 200, headers: { 'content-length': String(size) }, body: head ? null : createReadStream(file) };
  }
  async remove(key: string): Promise<void> {
    await unlink(this.file(key)).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ SigV4

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** AAAAMMDDTHHMMSSZ */
  amzDate: string;
}

/** Assinatura AWS Signature Version 4 (cabeçalho Authorization). Os cabeçalhos dados entram assinados. */
export function signV4(i: SigV4Input): string {
  const date = i.amzDate.slice(0, 8);
  const names = Object.keys(i.headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonicalPath = i.url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const query = [...i.url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, av], [b, bv]) => (a === b ? (av! < bv! ? -1 : 1) : a! < b! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [i.method, canonicalPath, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export class R2BlobStore implements BlobStore {
  readonly kind = 'r2' as const;
  private endpoint: string;
  private bucket: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private fetchImpl: typeof fetch;
  private now: () => Date;
  constructor(opts: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; fetchImpl?: typeof fetch; now?: () => Date }) {
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.bucket = opts.bucket;
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private request(method: string, key: string, extra: Record<string, string>, body?: Buffer): Promise<Response> {
    const url = new URL(`${this.endpoint}/${this.bucket}/${safeKey(key)}`);
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = body ? sha256hex(body) : 'UNSIGNED-PAYLOAD';
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extra };
    const authorization = signV4({ method, url, headers, payloadHash, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, region: 'auto', service: 's3', amzDate });
    const { host: _host, ...send } = headers;
    void _host;
    return this.fetchImpl(url, { method, headers: { ...send, authorization }, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.request('PUT', key, { 'content-type': contentType }, body);
    if (!res.ok) throw new Error(`R2 recusou o envio (${res.status})`);
  }

  async get(key: string, range: string | undefined, head: boolean): Promise<BlobRead | null> {
    const extra: Record<string, string> = {};
    if (range && /^bytes=\d*-\d*$/.test(range)) extra.range = range;
    const res = await this.request(head ? 'HEAD' : 'GET', key, extra);
    if (res.status === 404) return null;
    if (res.status === 416) return { status: 416, headers: { 'content-range': res.headers.get('content-range') ?? '' }, body: null };
    if (res.status !== 200 && res.status !== 206) throw new Error(`R2 respondeu ${res.status}`);
    const headers: Record<string, string> = {};
    for (const h of ['content-length', 'content-range']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return { status: res.status, headers, body: head || !res.body ? null : Readable.fromWeb(res.body as import('node:stream/web').ReadableStream) };
  }
}
