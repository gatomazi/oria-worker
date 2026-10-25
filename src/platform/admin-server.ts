// Painel e API administrativa. Escuta só em 127.0.0.1 nesta fase.
// Operador: todas as lojas, pacotes, integração e acessos.
// Lojista: somente a própria loja (rascunho, prévia, publicação, mídia).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { COLOR_TOKENS, DEVICES, PAGE_TYPES } from '../shared/fields.ts';
import { IDENTITY_FIELDS } from '../shared/identity.ts';
import { Auth, SESSION_COOKIE, canAccessStore, isEmail, passwordProblem, type User } from './auth.ts';
import { BodyError, readJson, send, sendJson } from './http.ts';
import { MEDIA_LIMIT, MEDIA_TYPES, type MediaStore } from './media.ts';
import { ServiceError, type StoreService, type Store } from './stores.ts';
import type { CatalogReader } from './catalog.ts';
import { previewToken } from './tokens.ts';
import { installArtifacts, installStatus, type InstallContext } from './install.ts';
import type { IntegrationService } from './integration.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface AdminDeps {
  auth: Auth;
  stores: StoreService;
  media: MediaStore;
  catalog: CatalogReader;
  secret: Buffer;
  port: number;
  /** Endereço local da loja via Worker (ex.: http://loja.localhost:8787). */
  storeUrl: (s: Store) => string;
  install: InstallContext;
  integration: IntegrationService;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new BodyError(413, `Arquivo grande demais (máximo ${Math.round(limit / 1024 / 1024)} MB).`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function asset(rel: string): Promise<Buffer | null> {
  try {
    return await readFile(ROOT + rel);
  } catch {
    return null;
  }
}

const STATIC: Record<string, [string, string]> = {
  '/assets/panel.js': ['dist/panel/panel.js', 'text/javascript; charset=utf-8'],
  '/assets/panel.css': ['src/panel/panel.css', 'text/css; charset=utf-8'],
};

export function createAdminServer(deps: AdminDeps): Server {
  const { auth, stores } = deps;
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  return createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof ServiceError) sendJson(res, err.status, { error: err.code, message: err.message, errors: err.errors });
      else if (err instanceof BodyError) sendJson(res, err.status, { error: 'bad_request', message: err.message });
      else {
        console.error('[painel] erro inesperado', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Erro inesperado no servidor local. Veja o terminal.' });
      }
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Host desconhecido (DNS rebinding) e escrita de outra origem (CSRF) são recusados antes de tudo.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'Host não permitido', 'text/plain; charset=utf-8');
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const unsafe = method !== 'GET' && method !== 'HEAD';
    if (unsafe && !allowedOrigins.has(req.headers.origin ?? '')) return sendJson(res, 403, { error: 'forbidden_origin', message: 'Origem não permitida.' });

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await asset('src/panel/panel.html');
      return html
        ? send(res, 200, html, 'text/html; charset=utf-8', { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        : send(res, 500, 'panel.html ausente', 'text/plain');
    }
    const st = STATIC[path];
    if (method === 'GET' && st) {
      const body = await asset(st[0]);
      return body ? send(res, 200, body, st[1]) : send(res, 503, `Arquivo ${st[0]} ausente. Rode npm run build.`, 'text/plain; charset=utf-8');
    }
    if (!path.startsWith('/api/')) return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');

    // ---------------------------------------------------- sem sessão
    if (method === 'POST' && path === '/api/login') {
      const body = (await readJson(req)) as { email?: unknown; password?: unknown };
      const user = auth.login(body.email, body.password);
      if (!user) return sendJson(res, 401, { error: 'invalid_login', message: 'E-mail ou senha incorretos.' });
      return startSession(res, user);
    }
    const invite = /^\/api\/invites\/([A-Za-z0-9_-]{20,100})$/.exec(path);
    if (invite) {
      const token = invite[1]!;
      const user = auth.inviteUser(token);
      if (!user) return sendJson(res, 404, { error: 'invalid_invite', message: 'Convite inválido, usado ou expirado. Peça um novo convite.' });
      if (method === 'GET') return sendJson(res, 200, { name: user.name, email: user.email, role: user.role });
      if (method === 'POST') {
        const body = (await readJson(req)) as { password?: unknown };
        const problem = passwordProblem(body.password);
        if (problem) return sendJson(res, 422, { error: 'weak_password', message: problem });
        const accepted = auth.acceptInvite(token, body.password as string);
        if (!accepted) return sendJson(res, 404, { error: 'invalid_invite', message: 'Convite inválido.' });
        stores.audit(accepted.id, accepted.storeId, 'invite.accept');
        return startSession(res, accepted);
      }
    }

    // ---------------------------------------------------- com sessão
    const token = cookies(req)[SESSION_COOKIE];
    const session = auth.session(token);
    if (!session) return sendJson(res, 401, { error: 'unauthenticated', message: 'Entre para continuar.' });
    const { user } = session;
    if (unsafe && req.headers['x-csrf-token'] !== session.csrf) return sendJson(res, 403, { error: 'csrf', message: 'Sessão desatualizada. Recarregue a página.' });

    if (path === '/api/session' && method === 'GET') return sendJson(res, 200, { user, csrf: session.csrf });
    if (path === '/api/logout' && method === 'POST') {
      auth.logout(token);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (path === '/api/meta' && method === 'GET') {
      return sendJson(res, 200, {
        modules: stores.modulesCatalog(),
        identityFields: IDENTITY_FIELDS,
        pageTypes: PAGE_TYPES,
        devices: DEVICES,
        colorTokens: COLOR_TOKENS,
        packages: stores.listPackages(),
      });
    }

    const isOperator = user.role === 'operator';
    // Toda resposta com a loja passa por aqui: o lojista nunca recebe integração nem notas internas.
    const forRole = <T extends { store: Store }>(view: T) => (isOperator ? view : { ...view, store: merchantStoreView(view.store) });
    const operatorOnly = () => {
      if (!isOperator) throw new ServiceError(403, 'forbidden', 'Somente o operador pode fazer isso.');
    };

    if (path === '/api/stores' && method === 'GET') {
      const list = (isOperator ? stores.list() : stores.list().filter((s) => s.id === user.storeId)).map((s) => storeSummary(s));
      return sendJson(res, 200, { stores: list });
    }
    if (path === '/api/stores' && method === 'POST') {
      operatorOnly();
      const body = (await readJson(req)) as { store?: unknown; identity?: unknown };
      const store = stores.createStore(body.store, body.identity, user.id);
      return sendJson(res, 201, { store });
    }
    if (path === '/api/packages' && method === 'GET') return sendJson(res, 200, { packages: stores.listPackages() });
    if (path === '/api/packages' && method === 'POST') {
      operatorOnly();
      return sendJson(res, 200, { package: stores.savePackage(await readJson(req), user.id) });
    }

    const m = /^\/api\/stores\/([a-z0-9-]{3,40})(\/.*)?$/.exec(path);
    if (!m) return sendJson(res, 404, { error: 'not_found', message: 'Rota desconhecida.' });
    const store = stores.get(m[1]);
    // Lojista de outra loja recebe o mesmo 404 de loja inexistente.
    if (!store || !canAccessStore(user, store.id)) return sendJson(res, 404, { error: 'unknown_store', message: 'Loja não encontrada.' });
    const action = m[2] ?? '';

    if (action === '' && method === 'GET') {
      const view = stores.view(store.id);
      return sendJson(res, 200, {
        ...forRole(view),
        storeUrl: deps.storeUrl(store),
        media: deps.media.list(store.id),
        role: user.role,
      });
    }
    if (action === '' && method === 'PUT') {
      operatorOnly();
      return sendJson(res, 200, { store: stores.updateStore(store.id, await readJson(req), user.id) });
    }
    if (action === '/draft' && method === 'PUT') {
      const body = (await readJson(req)) as { config?: unknown; expectedUpdatedAt?: unknown };
      return sendJson(res, 200, forRole(stores.saveDraft(store.id, body.config, body.expectedUpdatedAt, user.id)));
    }
    if (action === '/publish' && method === 'POST') {
      const body = (await readJson(req)) as { expectedDraftUpdatedAt?: unknown };
      return sendJson(res, 200, forRole(stores.publish(store.id, body.expectedDraftUpdatedAt, user.id)));
    }
    if (action === '/restore' && method === 'POST') {
      const body = (await readJson(req)) as { version?: unknown };
      return sendJson(res, 200, forRole(stores.restore(store.id, body.version, user.id)));
    }
    const stateMatch = /^\/modules\/([A-Za-z]{2,40})\/state$/.exec(action);
    if (stateMatch && method === 'POST') {
      const body = (await readJson(req)) as { enabled?: unknown };
      return sendJson(res, 200, forRole(stores.setModuleState(store.id, stateMatch[1], body.enabled, user.id)));
    }
    if (action === '/preview-token' && method === 'POST') {
      return sendJson(res, 200, { token: previewToken(deps.secret, store.id), storeUrl: deps.storeUrl(store) });
    }
    if (action === '/media' && method === 'POST') {
      const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!MEDIA_TYPES[mime]) return sendJson(res, 415, { error: 'unsupported_media', message: 'Envie vídeo MP4/WebM ou imagem JPG/PNG/WebP.' });
      const body = await readRaw(req, MEDIA_LIMIT);
      if (!body.length) return sendJson(res, 400, { error: 'empty', message: 'Arquivo vazio.' });
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'arquivo')).replace(/[^\w.\- ]/g, '_');
      const saved = await deps.media.save(store.id, stores.newMediaId(), mime, body, name);
      stores.audit(user.id, store.id, 'media.upload', saved.id);
      return sendJson(res, 201, saved);
    }
    if (action.startsWith('/catalog/') && method === 'GET') return catalogRoute(res, store, action, url);

    // Integração: operador e lojista da própria loja. O token nunca volta ao painel.
    if (action === '/integration' && method === 'GET') return sendJson(res, 200, deps.integration.status(store.id));
    if (action === '/integration/sync' && method === 'POST') {
      const status = await deps.integration.syncSite(store);
      stores.audit(user.id, store.id, 'integration.sync', status.site.error ?? 'ok');
      return sendJson(res, 200, status);
    }
    if (action === '/integration/ink-token' && method === 'PUT') {
      const body = (await readJson(req)) as { token?: unknown };
      const status = deps.integration.setToken(store, body.token, user.id);
      stores.audit(user.id, store.id, 'integration.token.set', `…${status.api.hint}`);
      return sendJson(res, 200, status);
    }
    if (action === '/integration/ink-token' && method === 'DELETE') {
      stores.audit(user.id, store.id, 'integration.token.clear');
      return sendJson(res, 200, deps.integration.clearToken(store));
    }
    if (action === '/integration/ink-test' && method === 'POST') return sendJson(res, 200, await deps.integration.testApi(store));

    // ------------------------------------------------ só operador
    if (action === '/users' && method === 'GET') {
      operatorOnly();
      return sendJson(res, 200, { users: auth.usersOfStore(store.id) });
    }
    if (action === '/users' && method === 'POST') {
      operatorOnly();
      const body = (await readJson(req)) as { name?: unknown; email?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80 || /[<>]/.test(name)) return sendJson(res, 422, { error: 'invalid', message: 'Nome do acesso: obrigatório, até 80 caracteres.' });
      if (!isEmail(body.email)) return sendJson(res, 422, { error: 'invalid', message: 'E-mail inválido.' });
      if (auth.userByEmail(body.email)) return sendJson(res, 409, { error: 'exists', message: 'Já existe acesso com este e-mail.' });
      const merchant = auth.createUser({ email: body.email, name, role: 'merchant', storeId: store.id });
      const inviteToken = auth.createInvite(merchant.id);
      stores.audit(user.id, store.id, 'user.invite', merchant.email);
      return sendJson(res, 201, { user: merchant, inviteUrl: `http://127.0.0.1:${deps.port}/#/convite/${inviteToken}` });
    }
    const userAction = /^\/users\/(\d+)(\/invite)?$/.exec(action);
    if (userAction) {
      operatorOnly();
      const target = auth.userById(Number(userAction[1]));
      if (!target || target.storeId !== store.id) return sendJson(res, 404, { error: 'not_found', message: 'Acesso não encontrado.' });
      if (userAction[2] && method === 'POST') {
        const inviteToken = auth.createInvite(target.id);
        return sendJson(res, 200, { inviteUrl: `http://127.0.0.1:${deps.port}/#/convite/${inviteToken}` });
      }
      if (!userAction[2] && method === 'DELETE') {
        auth.disableUser(target.id);
        stores.audit(user.id, store.id, 'user.disable', target.email);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (action === '/install' && method === 'GET') {
      operatorOnly();
      const view = stores.view(store.id);
      return sendJson(res, 200, {
        status: await installStatus(store, view, deps.install),
        artifacts: installArtifacts(store, view, deps.install).map((a) => ({ name: a.name, description: a.description })),
      });
    }
    const artifact = /^\/install\/([a-z0-9.\-]{3,80})$/.exec(action);
    if (artifact && method === 'GET') {
      operatorOnly();
      const file = installArtifacts(store, stores.view(store.id), deps.install).find((a) => a.name === artifact[1]);
      if (!file) return sendJson(res, 404, { error: 'not_found', message: 'Artefato não encontrado.' });
      return send(res, 200, file.content, file.type, { 'content-disposition': `attachment; filename="${file.name}"` });
    }
    return sendJson(res, 405, { error: 'method_not_allowed', message: 'Ação não permitida.' });
  }

  function startSession(res: ServerResponse, user: User): void {
    const s = auth.createSession(user.id);
    sendJson(res, 200, { user, csrf: s.csrf }, {
      'set-cookie': `${SESSION_COOKIE}=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - Date.now()) / 1000)}`,
    });
  }

  function storeSummary(s: Store) {
    const view = stores.view(s.id);
    const enabled = view.published ? Object.entries(view.published.config.modules).filter(([, mm]) => mm.enabled).map(([id]) => id) : [];
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      kind: s.kind,
      domain: s.domain,
      packages: s.packages,
      entitled: view.entitled,
      published: view.published ? { version: view.published.version, publishedAt: view.published.publishedAt, enabled } : null,
      draftPending: !view.draftMatchesPublished,
      storeUrl: deps.storeUrl(s),
    };
  }

  async function catalogRoute(res: ServerResponse, store: Store, action: string, url: URL): Promise<void> {
    try {
      if (action === '/catalog/sections') return sendJson(res, 200, { sections: await deps.catalog.sections(store) });
      if (action === '/catalog/products') {
        const p = url.searchParams.get('path') ?? '';
        return sendJson(res, 200, { products: await deps.catalog.products(store, p) });
      }
      if (action === '/catalog/search') return sendJson(res, 200, { products: await deps.catalog.search(store, url.searchParams.get('q') ?? '') });
      if (action === '/catalog/most-sold') return sendJson(res, 200, { products: await deps.catalog.mostSold(store) });
      if (action === '/catalog/reviews') return sendJson(res, 200, await deps.catalog.reviews(store));
      return sendJson(res, 404, { error: 'not_found', message: 'Consulta desconhecida.' });
    } catch (err) {
      return sendJson(res, 502, { error: 'store_unreachable', message: `Não foi possível ler a loja agora (${(err as Error).message}).` });
    }
  }
}

/** O lojista não vê nem altera dados técnicos de integração. */
function merchantStoreView(s: Store) {
  return { id: s.id, name: s.name, status: s.status, domain: s.domain, basePath: s.basePath, packages: s.packages, kind: s.kind };
}
