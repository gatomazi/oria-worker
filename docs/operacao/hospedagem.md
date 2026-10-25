# Hospedagem e instalação — passo a passo

Estado: **preparado; deploy e validação remota pendentes de autorização.** Nada aqui foi executado.
Decisão de arquitetura: [`docs/decisoes/0001-hospedagem.md`](../decisoes/0001-hospedagem.md).

## 1. Serviço (painel + serviço público) no Railway

1. Novo serviço a partir do repositório (usa `Dockerfile` e `railway.json`; instância única).
2. **Volume** montado em `/data`.
3. Variáveis: ver `.env.example` (`PANEL_ORIGIN`, `PUBLIC_ORIGIN`, `APP_SECRET`, R2, Resend, operador).
4. Dois domínios apontando para o mesmo serviço: o do painel e o do serviço público. O processo
   separa pelo host; qualquer outro host recebe só o serviço público.
5. Conferir `GET https://<painel>/health` e `GET https://<serviço>/health` → `{"ok":true}`.
6. O log da subida diz o modo de mídia e de e-mail (`caixa de saída local (envio real pendente)` se o
   Resend não estiver configurado).

**Migração dos dados locais:** `npm run backup` gera `data/backups/pink-<data>.db`; copie para o volume e,
com o serviço parado, `DATA_DIR=/data npm run restore -- /data/pink-<data>.db`. As migrações novas rodam
na subida. A mídia local (`data/media/<loja>/<id>`) vai para o R2 com a mesma chave (`<loja>/<id>`).
Os tokens da INK guardados continuam válidos se o `APP_SECRET` for o conteúdo de `data/secret`.

**Recuperação:** cópias diárias em `/data/backups` (7 últimas) e `backups/` no R2.
`npm run restore -- <arquivo>` confere a integridade antes e guarda o banco anterior ao lado.

## 2. Worker das lojas (Cloudflare)

Gerado por loja na **Operação → Instalação**: `wrangler.oria.toml` (Worker compartilhado `oria-lojas`,
uma rota `<domínio>/*` por loja instalada, e o ambiente `teste`), `instalacao-<loja>.md` e
`verificacao-<loja>.sh`. Validado localmente com `wrangler deploy --dry-run` (teste automatizado).

- **Teste** (sem mexer no DNS da loja): `npx wrangler deploy -c wrangler.oria.toml --env teste`. Cada loja
  usa o seu endereço de teste (Operação → Endereço de teste), ex. `vista.teste.<seu-domínio>` com a rota
  curinga do ambiente `teste`; ou o `oria-lojas-teste.<conta>.workers.dev`, que atende **uma loja por vez**.
- **Domínio real**: a zona da loja na Cloudflare com o registro da INK em proxy; descomentar a rota da
  loja e `npx wrangler deploy -c wrangler.oria.toml`. Ordem segura e retorno no `instalacao-<loja>.md`.
- `bash verificacao-<loja>.sh <endereço>` confere carregador, arquivos de recurso, configuração da loja
  certa, prévia com token e mídia. A Operação só marca "Instalado" quando o carregador aparece na página
  pública.
- Conteúdo, recursos e identidade mudam pelo painel e **não** exigem novo deploy do Worker.

## 3. E-mail (Resend)

Domínio de envio verificado na Resend, `RESEND_API_KEY` e `MAIL_FROM`. Sem isso, convites e
redefinições ficam na caixa de saída local (`/data/outbox`) e o painel mostra o link para o operador
repassar.

## 4. API da INK (por loja)

Token gerado no painel da INK (Credenciais da API) com `store.promotions.read`,
`store.categories.read` e `store.products.read`; colado pelo lojista ou operador na aba Integração.
Homologação: `INK_TOKEN=… npm run check:api -- <slug>` (o token não é impresso).
