// Token assinado da prévia: dá acesso ao RASCUNHO de uma única loja por pouco tempo.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PREVIEW_TTL_MS = 30 * 60_000;

/** Segredo local gerado no primeiro uso e guardado em DATA_DIR/secret (fora do código). */
export function loadSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  return Buffer.from(readFileSync(file, 'utf8'), 'base64');
}

const sign = (secret: Buffer, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function previewToken(secret: Buffer, storeId: string, now = Date.now()): string {
  const payload = `${storeId}.${now + PREVIEW_TTL_MS}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Devolve o id da loja se o token for válido e não tiver expirado. */
export function verifyPreviewToken(secret: Buffer, token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^([a-z0-9-]{3,40})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, storeId, exp, sig] = m as unknown as [string, string, string, string];
  const expected = Buffer.from(sign(secret, `${storeId}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) < now) return null;
  return storeId;
}
