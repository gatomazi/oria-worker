// Serviço público consultado pelo Worker: resolve a loja pelo host, entrega a
// configuração publicada, a prévia (com token), os arquivos do carregador, a
// mídia e o assistente. Nada aqui expõe rascunho sem token válido.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BodyError, readJson, send, sendJson } from './http.ts';
import type { MediaStore } from './media.ts';
import type { StoreService } from './stores.ts';
import { verifyPreviewToken } from './tokens.ts';
import type { AssistantService } from './assistant.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT_FILE = /^\/client\/([a-z0-9-]+(?:\/[a-z0-9-]+)?\.js)$/i;

export interface PublicDeps {
  stores: StoreService;
  media: MediaStore;
  secret: Buffer;
  assistant: AssistantService;
}

export function createPublicServer(deps: PublicDeps): Server {
  return createServer(createPublicHandler(deps));
}

export function createPublicHandler(deps: PublicDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { stores } = deps;
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof BodyError) sendJson(res, err.status, { error: 'bad_request', message: err.message });
      else {
        console.error('[público] erro inesperado', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      }
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health') return sendJson(res, 200, { ok: true });

    // Arquivos do carregador e dos módulos (gerados pelo build).
    const client = CLIENT_FILE.exec(path);
    if (client && method === 'GET') {
      try {
        const body = await readFile(`${ROOT}dist/client/${client[1]}`);
        // Módulos com hash no nome nunca mudam; o carregador muda a cada versão do serviço.
        const immutable = client[1]!.startsWith('m/');
        return send(res, 200, body, 'text/javascript; charset=utf-8', { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' });
      } catch {
        return send(res, 404, '/* arquivo não encontrado */', 'text/javascript; charset=utf-8');
      }
    }

    // Resolução da loja pelo host (o Worker consulta e guarda por alguns segundos).
    const host = /^\/api\/v1\/hosts\/([a-z0-9.\-]{3,253})$/.exec(path);
    if (host && method === 'GET') {
      const h = host[1]!.toLowerCase();
      const store = stores.byHost(h);
      if (!store) return sendJson(res, 404, { error: 'unknown_host' });
      return sendJson(res, 200, {
        storeId: store.id,
        basePath: store.basePath,
        devOrigin: store.devOrigin,
        kind: store.kind,
        active: store.status !== 'paused',
        proxyCart: store.integration.proxyCart,
        turbo: store.integration.turbo,
      });
    }

    const m = /^\/api\/v1\/stores\/([a-z0-9-]{3,40})\/([a-z-]+)(?:\/([a-f0-9]{24}))?$/.exec(path);
    if (!m) return sendJson(res, 404, { error: 'not_found' });
    const store = stores.get(m[1]);
    if (!store) return sendJson(res, 404, { error: 'unknown_store' });
    const action = m[2];

    if (action === 'config' && method === 'GET') {
      const config = stores.publicConfig(store.id);
      if (!config) return sendJson(res, 404, { error: 'not_published' }, { 'cache-control': 'no-store' });
      // ETag do conteúdo: o Worker revalida a cada página e só baixa quando muda.
      const body = JSON.stringify(config);
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        res.end();
        return;
      }
      return send(res, 200, body, 'application/json; charset=utf-8', { etag, 'cache-control': 'no-cache' });
    }
    if (action === 'preview-config' && method === 'GET') {
      // Rascunho só com token assinado desta mesma loja e dentro da validade.
      if (verifyPreviewToken(deps.secret, url.searchParams.get('token')) !== store.id) return sendJson(res, 403, { error: 'invalid_token' });
      return sendJson(res, 200, stores.draftPublicConfig(store.id));
    }
    if (action === 'media' && m[3] && (method === 'GET' || method === 'HEAD')) {
      const served = await deps.media.serve(store.id, m[3], req, res);
      if (!served) sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (action === 'assistant' && method === 'POST') {
      const body = await readJson(req);
      const result = await deps.assistant.answer(store.id, body);
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
}
