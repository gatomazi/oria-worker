# 0001 — Hospedagem: backend Node num processo, Worker das lojas na Cloudflare

Data: 25/10/2026 · Situação: **aceita, implementada; deploy pendente de autorização**

## Contexto

O serviço (painel, API, configuração pública, mídia, assistente, leitura das lojas) roda em Node:
`node:sqlite` com transações síncronas (`BEGIN IMMEDIATE`), servidores `node:http`, arquivos locais e
leitura de HTML com jsdom. A direção preferida era Workers + D1 + R2.

## O que foi conferido (documentação vigente)

- **`node:sqlite` não existe em Workers**: aparece só como *stub* sem implementação
  (developers.cloudflare.com/workers/runtime-apis/nodejs).
- **D1 não tem transação interativa**: só `batch()` atômico; o serviço inteiro (lojas, versões, acessos,
  convites, importações) usa transações com leitura e escrita intercaladas e API síncrona
  (developers.cloudflare.com/d1/worker-api/d1-database).
- jsdom (catálogo, integração, assistente) teria de ser trocado por HTMLRewriter/outra biblioteca.

Migrar tudo para Workers seria reescrever a camada de dados e de leitura, com risco de regressão em
publicação, permissões e isolamento — o oposto do que a rodada pede.

## Decisão

1. **Backend Node num processo só** (`ORIA_MODE=hosted`): uma porta (`PORT`), painel e serviço público
   separados pelo **host** do pedido (`PANEL_ORIGIN`, `PUBLIC_ORIGIN`), atrás de TLS.
   Destino recomendado: **Railway**, já usado pelo dono, com `Dockerfile` e `railway.json`.
2. **Banco**: SQLite no **volume** persistente (`DATA_DIR=/data`), migrações na subida, cópia diária
   (`VACUUM INTO`) local e no R2, `npm run backup` / `npm run restore`.
   **Instância única** (volume não aceita réplicas): é uma limitação assumida.
3. **Mídia**: **R2** pela API compatível com S3, assinada com SigV4 em `node:crypto` (sem biblioteca),
   com Range repassado. Local continua em disco.
4. **Worker das lojas** continua na Cloudflare: um Worker compartilhado (`oria-lojas`) com uma rota
   `<domínio>/*` por loja, lendo a configuração por HTTP (`CONFIG_SERVICE_URL = PUBLIC_ORIGIN`).
5. **E-mail**: Resend (API HTTP). Em desenvolvimento, caixa de saída local; nada sai da máquina.

## Publicação e cache

- Fonte única: o serviço (versão publicada, liberação, pausa).
- O Worker consulta a configuração **a cada página** com `If-None-Match`; sem mudança, 304 sem corpo.
  Publicar, restaurar, desligar módulo, retirar liberação ou pausar vale **na navegação seguinte**
  (medido em `test/worker.test.ts` e `test/access.test.ts`).
- Arquivos dos módulos têm hash no nome e são servidos como imutáveis (cache do edge); o carregador
  tem cache curto.
- KV **não** é usado: com consistência eventual, um desligamento poderia continuar valendo por até
  um minuto em alguns locais.
- Configuração indisponível ou inválida: nada é injetado; a página da INK segue como veio.

## Consequências

- Um ponto único (o serviço) precisa estar no ar para os módulos aparecerem; se cair, as lojas
  continuam funcionando sem os módulos (falha fechada).
- Redeploy com volume tem uma breve indisponibilidade (limite do Railway com volume).
- Para escalar além de uma instância: trocar SQLite por Postgres gerenciado (a camada de dados é
  isolada em `src/platform/*`).
