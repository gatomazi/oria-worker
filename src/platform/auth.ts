// Acesso ao painel: operador (Gabriel) vê tudo; lojista só a própria loja.
// Senha com scrypt, sessão em cookie HttpOnly + token CSRF por sessão,
// convite de uso único para definir a senha. Nada de senha em texto puro.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'operator' | 'merchant';
  storeId: string | null;
}

export const SESSION_COOKIE = 'pink_session';
const SESSION_TTL_MS = 12 * 3600_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && EMAIL.test(v.trim());
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 10) return 'Use uma senha com pelo menos 10 caracteres.';
  if (password.length > 200) return 'Senha longa demais.';
  return null;
}

function rowToUser(r: Record<string, unknown>): User {
  return { id: Number(r.id), email: String(r.email), name: String(r.name), role: r.role as User['role'], storeId: (r.store_id as string | null) ?? null };
}

export class Auth {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  hasOperator(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role = 'operator' AND disabled = 0 LIMIT 1").get();
  }

  createUser(input: { email: string; name: string; role: User['role']; storeId: string | null; password?: string }): User {
    const email = input.email.trim().toLowerCase();
    const res = this.db
      .prepare('INSERT INTO users (email, name, role, store_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, input.name.trim(), input.role, input.storeId, input.password ? hashPassword(input.password) : null, new Date().toISOString());
    return this.userById(Number(res.lastInsertRowid))!;
  }

  userById(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id) as Record<string, unknown> | undefined;
    return r ? rowToUser(r) : null;
  }

  userByEmail(email: string): (User & { passwordHash: string | null }) | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ? AND disabled = 0').get(email.trim().toLowerCase()) as
      | Record<string, unknown>
      | undefined;
    return r ? { ...rowToUser(r), passwordHash: (r.password_hash as string | null) ?? null } : null;
  }

  usersOfStore(storeId: string): (User & { hasPassword: boolean })[] {
    return (this.db.prepare('SELECT * FROM users WHERE store_id = ? AND disabled = 0 ORDER BY id').all(storeId) as Record<string, unknown>[]).map(
      (r) => ({ ...rowToUser(r), hasPassword: !!r.password_hash }),
    );
  }

  disableUser(id: number): void {
    this.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  /** Convite de uso único para definir senha. Devolve o token em claro uma única vez. */
  createInvite(userId: number, now = Date.now()): string {
    const t = token();
    this.db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
    this.db.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(t), userId, now + INVITE_TTL_MS);
    return t;
  }

  inviteUser(t: unknown, now = Date.now()): User | null {
    if (typeof t !== 'string' || t.length > 100) return null;
    const r = this.db.prepare('SELECT user_id, expires_at, used_at FROM invites WHERE token_hash = ?').get(sha256(t)) as
      | { user_id: number; expires_at: number; used_at: string | null }
      | undefined;
    if (!r || r.used_at || r.expires_at < now) return null;
    return this.userById(r.user_id);
  }

  acceptInvite(t: string, password: string, now = Date.now()): User | null {
    const user = this.inviteUser(t, now);
    if (!user) return null;
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    this.db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), sha256(t));
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return user;
  }

  login(email: unknown, password: unknown): User | null {
    if (!isEmail(email) || typeof password !== 'string') return null;
    const u = this.userByEmail(email);
    if (!u || !verifyPassword(password, u.passwordHash)) return null;
    return u;
  }

  createSession(userId: number, now = Date.now()): { token: string; csrf: string; expiresAt: number } {
    const t = token();
    const csrf = token();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(sha256(t), userId, csrf, expiresAt);
    return { token: t, csrf, expiresAt };
  }

  session(t: string | undefined, now = Date.now()): { user: User; csrf: string } | null {
    if (!t || t.length > 100) return null;
    const r = this.db.prepare('SELECT user_id, csrf, expires_at FROM sessions WHERE token_hash = ?').get(sha256(t)) as
      | { user_id: number; csrf: string; expires_at: number }
      | undefined;
    if (!r || r.expires_at < now) return null;
    const user = this.userById(r.user_id);
    return user ? { user, csrf: r.csrf } : null;
  }

  logout(t: string | undefined): void {
    if (t) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
  }
}

/** O lojista só alcança a própria loja; o operador alcança todas. */
export function canAccessStore(user: User, storeId: string): boolean {
  return user.role === 'operator' || user.storeId === storeId;
}
