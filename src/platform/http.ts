import type { IncomingMessage, ServerResponse } from 'node:http';

export const BODY_LIMIT = 32 * 1024;

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', headers);
}

export class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new BodyError(415, 'Envie o corpo como application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BodyError(413, 'Corpo da requisição grande demais.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError(400, 'JSON inválido.');
  }
}
