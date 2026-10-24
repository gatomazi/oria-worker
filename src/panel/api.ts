// Chamadas à API do painel com sessão (cookie HttpOnly) e token CSRF.
import type { FieldError } from '../shared/fields.ts';

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

export class ApiError extends Error {
  status: number;
  code: string;
  errors: FieldError[];
  constructor(status: number, code: string, message: string, errors: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.method && init.method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string; errors?: FieldError[] };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Falha ${res.status}`, data.errors ?? []);
  return data;
}
