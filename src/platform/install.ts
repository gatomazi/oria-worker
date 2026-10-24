// Instalação repetível: artefatos gerados por loja e checagens do estado.
// Nada aqui altera DNS, rotas ou Workers em produção; os artefatos descrevem
// o que fazer, e a ativação real exige aprovação explícita.
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { moduleDef } from '../shared/registry.ts';
import type { Store, StoreView } from './stores.ts';
import type { StoreService } from './stores.ts';
import type { Auth } from './auth.ts';

export interface InstallContext {
  workerPort: number;
  publicPort: number;
  stores: StoreService;
  auth: Auth;
  /** Há credencial de IA configurada no servidor? */
  aiConfigured: boolean;
  /** Para testes: busca HTTP injetável. */
  probe?: (url: string, host: string) => Promise<{ status: number; body: string }>;
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
  add('liberacao', 'Módulos liberados', view.entitled.length ? 'ok' : 'warn', view.entitled.length ? view.entitled.map((m) => moduleDef(m)?.code).join(', ') : 'Nenhum pacote ou módulo liberado.');
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
    view.published ? `versão ${view.published.version} · ${enabled.length} módulo(s) ligado(s)${view.draftMatchesPublished ? '' : ' · rascunho com mudanças não publicadas'}` : 'Ainda não houve publicação.',
  );

  // Integrações de que os módulos ligados dependem.
  const deps = new Set(enabled.flatMap((id) => moduleDef(id)?.integrations ?? []));
  if (deps.has('assistant.ai (opcional)')) {
    add('ia', 'Assistente com IA', store.integration.chatAi && ctx.aiConfigured ? 'ok' : 'warn', store.integration.chatAi ? (ctx.aiConfigured ? 'Credencial configurada no servidor.' : 'IA ligada para a loja, mas falta ANTHROPIC_API_KEY no servidor: o assistente usa só a base de respostas.') : 'Usando só a base de respostas (IA desligada).');
  }
  if (deps.has('ink.cart')) {
    add('carrinho', 'Leitura do carrinho', 'ok', store.integration.proxyCart ? 'Proxy local libera adicionar/alterar itens (sem checkout) para testes.' : 'Leitura do carrinho renderizado pela INK. No proxy local, adicionar itens está bloqueado.');
  }

  // Verificação ao vivo pelo Worker local (proxy). Não toca o domínio real.
  const probe = ctx.probe ?? localProbe(ctx.workerPort);
  try {
    const home = await probe(store.basePath || '/', `${store.devHost}:${ctx.workerPort}`);
    const injected = /data-pink-loader=/.test(home.body);
    const expected = view.published ? Object.values(view.published.config.modules).some((m) => m.enabled) : false;
    if (home.status !== 200) add('proxy', 'Loja pelo Worker local', 'error', `A página inicial respondeu ${home.status}.`);
    else if (injected) add('proxy', 'Loja pelo Worker local', 'ok', 'Página inicial carrega e o carregador foi inserido.');
    else add('proxy', 'Loja pelo Worker local', expected ? 'warn' : 'ok', expected ? 'Página carrega, mas o carregador não foi inserido na inicial (talvez nenhum módulo rode nesta página).' : 'Página carrega sem alteração (nenhum módulo ligado).');
  } catch (err) {
    add('proxy', 'Loja pelo Worker local', 'error', `Worker local indisponível (${(err as Error).message}). Rode npm run dev.`);
  }
  add('producao', 'Rota no domínio real', 'pending', `Não configurada. Ativar exige aprovação: siga instalacao-${store.id}.md.`);
  return checks;
}

export function installArtifacts(store: Store, view: StoreView, ctx: InstallContext): Artifact[] {
  const publicConfig = ctx.stores.publicConfig(store.id);
  const route = `${store.domain}${store.basePath}*`;
  const enabled = publicConfig ? Object.keys(publicConfig.modules) : [];
  const md = `# Instalação — ${store.name}

Gerado pelo painel em ${new Date().toISOString()} para a loja \`${store.id}\`.
Este procedimento **não foi executado**: ativar a rota no domínio real exige aprovação.

## Dados

| Item | Valor |
| --- | --- |
| Domínio | ${store.domain} |
| Caminho da loja na INK | ${store.basePath || '/'} |
| Responsável | ${store.ownerName} <${store.ownerEmail}> |
| Pacotes | ${store.packages.join(', ') || '—'} |
| Módulos liberados | ${view.entitled.map((m) => `${moduleDef(m)?.code} ${moduleDef(m)?.name}`).join('; ') || '—'} |
| Publicação atual | ${view.published ? `versão ${view.published.version} (${view.published.publishedAt})` : 'nenhuma'} |
| Módulos ligados | ${enabled.map((m) => moduleDef(m)?.code).join(', ') || 'nenhum'} |

## 1. Homologar no proxy local (sem DNS)

\`\`\`bash
npm run dev
# loja pelo Worker local:
open http://${store.devHost}:${ctx.workerPort}${store.basePath}
npm run check:loja -- ${store.id}
\`\`\`

## 2. Worker de teste (exige aprovação)

1. Copie \`wrangler.${store.id}.toml\` para a raiz e revise as variáveis.
2. Publique a configuração em KV (\`config-publicada-${store.id}.json\`) ou aponte \`CONFIG_SERVICE_URL\` para o serviço de configuração.
3. \`npx wrangler deploy -c wrangler.${store.id}.toml\` **sem rotas** (só workers.dev) e confira com \`verificacao-${store.id}.sh\`.

## 3. Rota no domínio (exige aprovação)

- Rota: \`${route}\` com \`ORIGIN_MODE="passthrough"\`.
- Ordem segura: rota com todos os módulos desligados → conferir página idêntica → ligar um módulo → ampliar.
- **Retorno:** desligar módulos no painel (efeito no próximo carregamento) → remover a rota → nada mais muda na INK.

## O que a INK continua fazendo

Catálogo, variantes, estoque, preços, descontos aplicados, frete, pagamento e pedidos. Os módulos só apresentam e conduzem.
`;
  const toml = `# Worker da loja ${store.name} (${store.id}). NÃO PUBLICAR sem aprovação.
name = "pink-${store.id}"
main = "src/worker/index.ts"
compatibility_date = "2026-07-01"
workers_dev = true
send_metrics = false

# Rotas ficam comentadas até a aprovação:
# routes = [{ pattern = "${route}", zone_name = "${store.domain.replace(/^www\./, '')}" }]

[vars]
CONFIG_SERVICE_URL = "https://<servico-de-configuracao>"
ORIGIN_MODE = "passthrough"
CONFIG_TIMEOUT_MS = "800"
PINK_STORE_DOMAIN = "${store.domain}"
`;
  const sh = `#!/usr/bin/env bash
# Verificação da loja ${store.id} depois da ativação. Só GET.
set -euo pipefail
BASE="\${1:-https://${store.domain}${store.basePath}}"
echo "→ página inicial"; curl -fsS -o /tmp/pink-home.html -w "%{http_code}\\n" "$BASE"
grep -q 'data-pink-loader' /tmp/pink-home.html && echo "carregador presente" || echo "carregador AUSENTE (esperado se nenhum módulo roda na inicial)"
echo "→ configuração pública"; curl -fsS "\${BASE%${store.basePath}}/__pink/config.json" | head -c 300; echo
`;
  return [
    { name: `instalacao-${store.id}.md`, description: 'Procedimento passo a passo, com retorno.', type: 'text/markdown; charset=utf-8', content: md },
    { name: `wrangler.${store.id}.toml`, description: 'Configuração do Worker da loja (rotas comentadas).', type: 'text/plain; charset=utf-8', content: toml },
    { name: `config-publicada-${store.id}.json`, description: 'Configuração pública da versão atual (para KV).', type: 'application/json; charset=utf-8', content: JSON.stringify(publicConfig ?? { aviso: 'sem publicação' }, null, 2) },
    { name: `verificacao-${store.id}.sh`, description: 'Checagens só de leitura depois de ativar.', type: 'text/x-shellscript; charset=utf-8', content: sh },
  ];
}
