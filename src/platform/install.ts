// Instalação repetível: artefatos gerados por loja e checagens do estado.
// Topologia: UM Worker compartilhado ("oria-lojas") na frente das lojas, com uma rota
// <domínio>/* por loja (cobre as páginas e /__pink/*), lendo a configuração por HTTP no
// serviço (CONFIG_SERVICE_URL). Um ambiente de teste ("oria-lojas-teste") atende o endereço
// de teste de cada loja como proxy da loja real (só GET). Nada aqui altera DNS, rotas ou
// Workers: os artefatos descrevem o procedimento, e a ativação exige aprovação explícita.
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { moduleDef } from '../shared/registry.ts';
import type { Store, StoreView } from './stores.ts';
import type { StoreService } from './stores.ts';
import type { Auth } from './auth.ts';

export interface InstallContext {
  workerPort: number;
  publicPort: number;
  /** Origem do serviço público (CONFIG_SERVICE_URL do Worker) e do painel (ADMIN_ORIGIN). */
  publicOrigin?: string;
  panelOrigin?: string;
  hosted?: boolean;
  stores: StoreService;
  auth: Auth;
  integration?: { status(id: string): { site: { fetchedAt: string | null; error: string | null }; api: { configured: boolean; testOk: boolean | null; data: { problems: { resource: string; message: string }[] } | null } } };
  /** Para testes: busca HTTP injetável (Worker local). */
  probe?: (url: string, host: string) => Promise<{ status: number; body: string }>;
  /** Para testes: GET em endereço público (domínio da loja, Worker de teste hospedado). */
  remote?: (url: string) => Promise<{ status: number; body: string }>;
}

const WORKER = 'oria-lojas';
const WORKER_TEST = 'oria-lojas-teste';

async function remoteGet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: { 'user-agent': 'oria-verificacao' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  return { status: res.status, body: await res.text() };
}

/** Zona da Cloudflare de um domínio (ex.: www.loja.com.br → loja.com.br). Heurística para sufixos .com.br e afins. */
export function zoneOf(domain: string): string {
  const parts = domain.split('.');
  const two = /^(com|net|org|art|blog|eco|ind|tur|app|dev)\.br$/.test(parts.slice(-2).join('.'));
  return parts.slice(two ? -3 : -2).join('.');
}

export interface Check {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'pending' | 'error';
  detail: string;
}

export interface Artifact {
  name: string;
  description: string;
  type: string;
  content: string;
}

function localProbe(port: number) {
  return (path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host, 'user-agent': 'personalizacoes-ink/verificacao' }, timeout: 15000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] ?? '');
          try {
            if (enc.includes('gzip')) buf = gunzipSync(buf);
            else if (enc.includes('br')) buf = brotliDecompressSync(buf);
            else if (enc.includes('deflate')) buf = inflateSync(buf);
          } catch {
            // corpo não decodificável: segue como veio
          }
          resolve({ status: res.statusCode ?? 0, body: buf.toString('utf8') });
        });
      });
      req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
      req.on('error', reject);
      req.end();
    });
}

export async function installStatus(store: Store, view: StoreView, ctx: InstallContext): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, state: Check['state'], detail: string) => checks.push({ id, label, state, detail });

  add('cadastro', 'Cadastro da loja', store.domain && store.ownerEmail ? 'ok' : 'warn', store.ownerEmail ? `${store.domain}${store.basePath} · responsável ${store.ownerName || store.ownerEmail}` : 'Falta o e-mail do responsável.');
  add('liberacao', 'Recursos liberados', view.entitled.length ? 'ok' : 'warn', view.entitled.length ? view.entitled.map((m) => moduleDef(m)?.name).join(', ') : 'Nenhum pacote ou recurso liberado.');
  const users = ctx.auth.usersOfStore(store.id);
  const active = users.filter((u) => u.hasPassword);
  add(
    'acesso',
    'Acesso do lojista',
    active.length ? 'ok' : users.length ? 'pending' : 'warn',
    active.length ? `${active.map((u) => u.email).join(', ')}` : users.length ? 'Convite enviado, ainda não aceito.' : 'Nenhum acesso criado para o lojista.',
  );
  const enabled = view.published ? Object.entries(view.published.config.modules).filter(([, m]) => m.enabled).map(([id]) => id) : [];
  add(
    'publicacao',
    'Configuração publicada',
    view.published ? 'ok' : 'pending',
    view.published ? `versão ${view.published.version} · ${enabled.length} recurso(s) ligado(s)${view.draftMatchesPublished ? '' : ' · rascunho com mudanças não publicadas'}` : 'Ainda não houve publicação.',
  );

  // Leitura da loja e API: última leitura e o que pede ação.
  const integ = ctx.integration?.status(store.id);
  if (integ) {
    const at = integ.site.fetchedAt;
    add('leitura', 'Leitura da loja', integ.site.error ? 'warn' : at ? 'ok' : 'pending', integ.site.error ?? (at ? `Última leitura em ${new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.` : 'Ainda não lida.'));
    if (integ.api.configured) {
      const problems = integ.api.data?.problems ?? [];
      add('api', 'API da INK', integ.api.testOk === false || problems.length ? 'warn' : integ.api.testOk ? 'ok' : 'pending', problems.length ? problems.map((p) => `${p.resource}: ${p.message}`).join(' ') : integ.api.testOk ? 'Token conectado.' : 'Token guardado, conexão não testada.');
    }
  }

  const deps = new Set(enabled.flatMap((id) => moduleDef(id)?.integrations ?? []));
  if (deps.has('ink.cart')) {
    add('carrinho', 'Leitura do carrinho', 'ok', store.integration.proxyCart ? 'No teste, o proxy libera adicionar e alterar itens do carrinho (nunca o checkout).' : 'Lê o carrinho que a INK mostra.');
  }

  // Teste pelo Worker de teste (proxy da loja). Passar aqui NÃO significa instalado.
  const expected = view.published ? Object.values(view.published.config.modules).some((m) => m.enabled) : false;
  const testLabel = ctx.hosted ? 'Teste pelo Worker de teste' : 'Teste local pelo proxy (não é instalação)';
  try {
    const home = ctx.hosted ? await (ctx.remote ?? remoteGet)(`https://${store.devHost}${store.basePath || '/'}`) : await (ctx.probe ?? localProbe(ctx.workerPort))(store.basePath || '/', `${store.devHost}:${ctx.workerPort}`);
    const injected = /data-pink-loader=/.test(home.body);
    if (home.status !== 200) add('teste', testLabel, 'error', `A página inicial respondeu ${home.status}.`);
    else if (injected) add('teste', testLabel, 'ok', 'Página inicial carrega e o carregador foi inserido.');
    else add('teste', testLabel, expected ? 'warn' : 'ok', expected ? 'Página carrega, mas o carregador não entrou na inicial (talvez nenhum recurso rode nela).' : 'Página carrega sem alteração (nenhum recurso ligado).');
  } catch (err) {
    add('teste', testLabel, 'pending', ctx.hosted ? `Worker de teste não respondeu em ${store.devHost} (${(err as Error).message}).` : `Worker local indisponível (${(err as Error).message}). Rode npm run dev.`);
  }

  // Domínio real: só conta como instalado quando o carregador aparece na página pública.
  if (store.kind === 'demo') add('producao', 'Rota no domínio real', 'ok', 'Loja de demonstração: sem domínio real.');
  else {
    try {
      const live = await (ctx.remote ?? remoteGet)(`https://${store.domain}${store.basePath || '/'}`);
      if (live.status === 200 && /data-pink-loader=/.test(live.body)) add('producao', 'Rota no domínio real', 'ok', 'Instalado: o carregador está na página pública da loja.');
      else add('producao', 'Rota no domínio real', 'pending', `Preparado para instalação; validação remota pendente (a página pública ${live.status === 200 ? 'ainda não tem o carregador' : `respondeu ${live.status}`}). Siga instalacao-${store.id}.md.`);
    } catch (err) {
      add('producao', 'Rota no domínio real', 'pending', `Preparado para instalação; validação remota pendente (sem resposta de ${store.domain}: ${(err as Error).message}).`);
    }
  }
  return checks;
}

export function installArtifacts(store: Store, view: StoreView, ctx: InstallContext): Artifact[] {
  const publicConfig = ctx.stores.publicConfig(store.id);
  const service = ctx.publicOrigin ?? `http://127.0.0.1:${ctx.publicPort}`;
  const panel = ctx.panelOrigin ?? 'http://127.0.0.1:4000';
  const route = `${store.domain}/*`;
  const zone = zoneOf(store.domain);
  const installed = ctx.stores.list().filter((x) => x.kind !== 'demo' && x.status === 'active' && x.id !== store.id);
  const enabled = publicConfig ? Object.keys(publicConfig.modules) : [];
  const testBase = ctx.hosted ? `https://${store.devHost}${store.basePath}` : `http://${store.devHost}:${ctx.workerPort}${store.basePath}`;
  const md = `# Instalação — ${store.name}

Gerado pelo painel em ${new Date().toISOString()} para a loja \`${store.id}\`.
**Estado: preparado para instalação; validação remota pendente.** Nada aqui foi executado:
ativar a rota no domínio real exige aprovação.

## Como funciona

- Um Worker compartilhado (\`${WORKER}\`) fica na frente de todas as lojas instaladas. Cada loja ganha
  **uma rota** \`${route}\`, que cobre as páginas da loja (\`${store.basePath || '/'}\`) e as rotas próprias
  (\`/__pink/*\`: carregador, módulos, configuração, prévia, mídia, assistente).
- O Worker identifica a loja pelo **host do pedido**, no cadastro do serviço (\`${service}/api/v1/hosts/<host>\`).
  O lojista não troca domínio: isso é cadastro do operador.
- Conteúdo, recursos e identidade mudam pelo painel e valem na próxima página: **não exigem novo deploy**.

## Dados

| Item | Valor |
| --- | --- |
| Domínio | ${store.domain} (zona \`${zone}\`) |
| Caminho da loja na INK | ${store.basePath || '/'} |
| Endereço de teste | ${store.devHost} |
| Serviço (CONFIG_SERVICE_URL) | ${service} |
| Painel (ADMIN_ORIGIN) | ${panel} |
| Responsável | ${store.ownerName} <${store.ownerEmail}> |
| Recursos liberados | ${view.entitled.map((m) => moduleDef(m)?.name).join('; ') || '—'} |
| Publicação atual | ${view.published ? `versão ${view.published.version} (${view.published.publishedAt})` : 'nenhuma'} |
| Recursos ligados | ${enabled.map((m) => moduleDef(m)?.name).join(', ') || 'nenhum'} |

## 1. Teste antes do domínio (sem mexer no DNS da loja)

O ambiente \`teste\` do Worker atende o **endereço de teste** como proxy da loja real (só leitura; carrinho só
se liberado na Operação; nunca checkout). Cada loja precisa de um host próprio:

- **Recomendado:** um subdomínio de teste por loja numa zona sua, ex. \`${store.id}.teste.<seu-domínio>\`,
  com a rota curinga \`*.teste.<seu-domínio>/*\` no ambiente \`teste\`.
- **workers.dev:** o endereço \`${WORKER_TEST}.<conta>.workers.dev\` é um host só. Ele atende **uma loja por vez**:
  cadastre esse host como endereço de teste da loja na Operação. Não é equivalente à rota no domínio.

\`\`\`bash
npx wrangler deploy -c wrangler.oria.toml --env teste      # exige aprovação
bash verificacao-${store.id}.sh ${testBase}
\`\`\`

## 2. Rota no domínio real (exige aprovação)

1. A zona \`${zone}\` precisa estar na conta Cloudflare, com o registro de \`${store.domain}\` apontando para a INK
   e o **proxy ligado** (nuvem laranja). Se o DNS da loja está em outro provedor, mude os nameservers para a
   Cloudflare antes (ou peça ao cliente acesso de edição à zona).
2. Ordem segura: **desligue os recursos no painel** → adicione a rota \`${route}\` ao \`${WORKER}\`
   (descomente em \`wrangler.oria.toml\` e \`npx wrangler deploy -c wrangler.oria.toml\`, ou crie a rota no painel
   da Cloudflare) → confira a página idêntica → ligue um recurso → amplie.
3. \`bash verificacao-${store.id}.sh https://${store.domain}${store.basePath}\`
4. Marque a loja como **Instalada** na Operação depois que a verificação passar.

## Retorno

1. Desligue os recursos no painel (vale na próxima página).
2. Remova a rota \`${route}\` (painel da Cloudflare ou tirar a linha e fazer deploy). A loja volta a ser servida
   direto pela INK; nada na INK foi alterado.

## O que a INK continua fazendo

Catálogo, variantes, estoque, preços, descontos aplicados, frete, pagamento e pedidos. Os recursos só apresentam e conduzem.
`;
  const routeLine = (x: Store) => `  { pattern = "${x.domain}/*", zone_name = "${zoneOf(x.domain)}" },`;
  const toml = `# Worker compartilhado das lojas Oria. Gerado pelo painel. NÃO PUBLICAR sem aprovação.
# Uma rota por loja instalada; o Worker identifica a loja pelo host no serviço de configuração.
name = "${WORKER}"
main = "src/worker/index.ts"
compatibility_date = "2026-07-01"
workers_dev = false
send_metrics = false

routes = [
${installed.map(routeLine).join('\n')}${installed.length ? '\n' : ''}  # ${store.name} — descomentar depois da aprovação e do teste:
  # { pattern = "${route}", zone_name = "${zone}" },
]

[vars]
CONFIG_SERVICE_URL = "${service}"
ADMIN_ORIGIN = "${panel}"
ORIGIN_MODE = "passthrough"
CONFIG_TIMEOUT_MS = "800"

# Ambiente de teste: proxy das lojas pelo endereço de teste de cada uma (só leitura).
[env.teste]
name = "${WORKER_TEST}"
workers_dev = true
# routes = [{ pattern = "*.teste.<seu-domínio>/*", zone_name = "<seu-domínio>" }]

[env.teste.vars]
CONFIG_SERVICE_URL = "${service}"
ADMIN_ORIGIN = "${panel}"
ORIGIN_MODE = "dev-origin"
CONFIG_TIMEOUT_MS = "1500"
`;
  const sh = `#!/usr/bin/env bash
# Verificação da instalação de ${store.name} (${store.id}). Só GET; nada é alterado.
# Uso: bash verificacao-${store.id}.sh [endereço da loja]   (padrão: o domínio real)
set -uo pipefail
BASE="\${1:-https://${store.domain}${store.basePath}}"
ORIGIN="$(printf '%s' "$BASE" | sed -E 's#^(https?://[^/]+).*#\\1#')"
FAIL=0
ok() { echo "ok      $1"; }
ko() { echo "FALHOU  $1"; FAIL=1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
get() { curl -sS -L -A 'oria-verificacao' -o "$TMP/body" -w '%{http_code} %{content_type}' "$1" 2>/dev/null || echo "000 -"; }

read -r code _ <<<"$(get "$BASE")"
[ "$code" = 200 ] && ok "página da loja responde (200)" || ko "página da loja respondeu $code"
if grep -q 'data-pink-loader' "$TMP/body"; then ok "carregador inserido na página"; else echo "aviso   carregador ausente nesta página (normal se nenhum recurso roda nela)"; fi

read -r code ctype <<<"$(get "$ORIGIN/__pink/config.json")"
if [ "$code" = 200 ] && grep -q '"storeId":"${store.id}"' "$TMP/body"; then ok "configuração publicada desta loja (host → ${store.id})";
elif [ "$code" = 404 ]; then echo "aviso   sem configuração aplicável (nada publicado, loja pausada ou nenhum recurso ligado)";
else ko "configuração: $code (esperado 200 desta loja)"; fi

read -r code ctype <<<"$(get "$ORIGIN/__pink/client/loader.js")"
if [ "$code" = 200 ] && printf '%s' "$ctype" | grep -q javascript; then ok "carregador servido ($ctype)"; else ko "carregador: $code $ctype"; fi
CHUNK="$(grep -oE 'm/[A-Za-z0-9_-]+-[A-Z0-9]+\.js' "$TMP/body" | head -1)"
if [ -n "$CHUNK" ]; then
  read -r code ctype <<<"$(get "$ORIGIN/__pink/client/$CHUNK")"
  [ "$code" = 200 ] && ok "arquivo de recurso servido ($CHUNK)" || ko "arquivo de recurso $CHUNK: $code"
else ko "carregador sem referência a arquivos de recurso"; fi

read -r code _ <<<"$(get "$ORIGIN/__pink/preview-config.json?token=token-invalido-000000000000")"
[ "$code" = 403 ] && ok "prévia exige token válido (403)" || ko "prévia sem token válido respondeu $code (esperado 403)"
read -r code _ <<<"$(get "$ORIGIN/__pink/media/000000000000000000000000")"
[ "$code" = 404 ] && ok "mídia inexistente não é servida (404)" || ko "mídia inexistente respondeu $code"

echo
[ "$FAIL" = 0 ] && echo "Tudo certo em $BASE." || echo "Há falhas. Retorno: desligue os recursos no painel e, se preciso, remova a rota ${route}."
exit "$FAIL"
`;
  return [
    { name: `instalacao-${store.id}.md`, description: 'Procedimento: teste, rota no domínio e retorno.', type: 'text/markdown; charset=utf-8', content: md },
    { name: 'wrangler.oria.toml', description: 'Worker compartilhado das lojas (rota desta loja comentada) e ambiente de teste.', type: 'text/plain; charset=utf-8', content: toml },
    { name: `verificacao-${store.id}.sh`, description: 'Confere página, carregador, recursos, configuração, prévia e isolamento. Só GET.', type: 'text/x-shellscript; charset=utf-8', content: sh },
  ];
}
