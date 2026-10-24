# personalizacoes-ink — rodada 2

Produto independente de funcionalidades por assinatura para lojas Reserva INK (nome interno, não é marca).
Uma base compartilhada, 12 módulos configuráveis por loja, painel de operador e de lojista, liberação por pacotes e
instalação repetível. Tudo roda **localmente**. Não houve deploy, DNS, rota ou alteração em loja real.

> O painel não tem domínio próprio e escuta só em `127.0.0.1`: não expor na internet.
> A loja de teste real (Vista Entre Nós) é lida pelo **proxy local** (Worker no seu computador). Isso **não** é validação de produção.

## Como rodar

```bash
npm install
npm run dev            # build + painel/API + serviço público + réplica INK (Node) + Worker local (wrangler)
OPERATOR_PASSWORD=… npm run demo:setup   # configura as 2 lojas demo pela API do painel (+ --vista para a loja de teste real)
npm run check          # typecheck + 62 testes
npm run e2e            # percurso completo no Chrome (pare o dev antes); grava vídeo e capturas
OPERATOR_PASSWORD=… npm run check:loja -- <id>   # homologação só de leitura de uma loja, pelo proxy
```

| O quê | Endereço |
| --- | --- |
| Painel (abra por este endereço; `localhost` quebra a prévia) | http://127.0.0.1:4000/ |
| Loja de teste real, pelo Worker local | http://vistaentrenos.localhost:8787/vistaentrenos |
| Lojas demo (réplica gravada da INK) | http://demo-aurora.localhost:8787/vistaentrenos · http://demo-trilha.localhost:8787/vistaentrenos |

**Primeiro acesso:** sem operador cadastrado, `npm run dev` imprime um link de convite para definir a senha.
Para automação local, `OPERATOR_EMAIL` + `OPERATOR_PASSWORD` criam o operador já com senha.

## Arquitetura

```
navegador ─► Worker (8787) ─► loja INK (em produção: a rota do domínio; aqui: proxy só leitura ou réplica)
               │ resolve a loja pelo host no cadastro (cache curto; falha = página intacta)
               │ injeta 1 carregador só onde algum módulo publicado roda (GET 200 HTML; nunca Turbo-Frame/Range/streams)
               └─ /__pink/* : carregador e módulos, config publicada, prévia (token), mídia (Range), assistente
carregador (10 KB) ─► config ─► baixa só os módulos da página/dispositivo (vídeo, chat e avaliações depois do load)
painel (4000) ─► API: lojas, pacotes, acessos, rascunho, publicação, liga/desliga, restauração, mídia, instalação
serviço público (4001) ─► host → loja, configuração publicada, rascunho com token, mídia, assistente
```

| Pasta | Papel |
| --- | --- |
| `src/shared/fields.ts`, `registry.ts`, `modules/*` | **Registro de módulos**: id, esquema de campos, padrões, páginas, integrações, projeção pública. O mesmo esquema gera o formulário, a validação no servidor e o que a loja recebe |
| `src/shared/ink-parse.ts` | Leitura da marcação real da INK: cards, menu, produto, avaliações, carrinho |
| `src/client/loader.ts`, `runtime/*`, `modules/*` | Carregador, superfícies da INK (`page.ts` é o único lugar com seletores), carrinho, coordenação de flutuantes, player |
| `src/platform/*` | SQLite (`data/pink.db`), autenticação, lojas/pacotes/versões, mídia, assistente, instalação, servidores, réplica |
| `src/worker/*` | Adaptador Cloudflare Worker e proxy de desenvolvimento |
| `src/panel/*` | Painel (operador e lojista) |

**Configuração por loja.**
- A identidade (logo, cores, tipografia, estilo) é definida uma vez; os módulos usam tokens de cor, sem repetir cores.
- Cada módulo tem padrões e sobrescritas por loja. Rascunho, prévia ao vivo sobre a página real, publicação versionada, liga/desliga por módulo e restauração ficam guardados por loja.
- Validação em dois níveis:
  - segurança (texto sem HTML, só caminhos da própria loja ou https, cores, tamanhos) vale sempre;
  - completude vale só para módulo ligado.

**Acesso.** Sessão em cookie HttpOnly, CSRF por sessão, conferência de Host/Origin e convites de uso único.
- **Operador:** todas as lojas, pacotes, integração técnica, acessos e instalação.
- **Lojista:** só a própria loja (edita, vê a prévia, publica, liga/desliga, restaura). Outra loja responde como inexistente.

**Pacotes.** Agrupamentos de módulos, sem preço, liberados por loja, com módulos avulsos. Tirar um módulo da liberação o tira da loja na próxima leitura, sem nova publicação.

**Instalação repetível.** A tela de Operação mostra o estado da instalação:
- cadastro e responsável;
- módulos liberados;
- acesso do lojista;
- publicação;
- Worker local inserindo o carregador;
- rota real (pendente).

Também gera por loja `instalacao-<id>.md`, `wrangler.<id>.toml` (rotas comentadas), `config-publicada-<id>.json` e `verificacao-<id>.sh`. A terceira loja do roteiro (Vista) é criada **pelo painel**, sem editar arquivos.

## Operação (roteiro)

1. Operador: **Nova loja** → dados, domínio e caminho na INK, identidade inicial, pacotes → **Operação** → criar acesso do lojista (gera link de convite).
2. Lojista: abre o convite → define senha → entra direto na própria loja.
3. Editor: escolhe o módulo, ativa no rascunho e preenche o formulário. A prévia à direita mostra a página real da loja com o rascunho ainda não salvo.
4. **Salvar rascunho**: a loja não muda. Depois **Publicar**, que gera uma versão.
5. Na loja, recarregar. **Desligar na loja agora** tira só aquele módulo. **Publicações → Restaurar** cria uma versão nova igual à escolhida.

## Matriz por módulo

Legenda:
- **A** = funcionando e verificado na loja INK real (Vista) pelo proxy local, só leitura;
- **B** = verificado sobre marcação real da INK em fixture ou réplica, mas não na Vista;
- **C** = implementado com dependência pendente.

| Módulo | Situação | O que foi testado | Fonte de dados / dependência |
| --- | --- | --- | --- |
| M01 Cabeçalho, menu e busca | **B** | jsdom: cores, menu com grupos, busca visível, comportamento ao rolar, carrinho e conta preservados, desfaz exatamente ao original. Réplica (demos) | Cabeçalho nativo da INK (duas barras: celular e computador) |
| M02 Categorias em abas | **A** | Vista: monta na home com 8 produtos reais da coleção, sem erros e sem rolagem lateral. jsdom: troca de aba muda os produtos e o "Ver todos"; atalhos repetidos só somem depois que as abas carregam | Páginas de coleção/listagem da própria loja (cache de 5 min na sessão) |
| M03 Galeria com miniaturas | **A** | Vista: monta com as miniaturas das fotos reais, sem rolagem lateral no celular. jsdom: uma miniatura por foto navegável, clique aciona só o ponto nativo, variante intacta, acompanha a foto ativa | Carrossel nativo da INK |
| M04 Compartilhamento | **A** | Vista: monta no produto. jsdom: WhatsApp com mensagem e link canônico limpo, copiar link | Canônico da página |
| M05 Cupons (único, abas, lista) + selo de 1ª compra | **A** (bloco e selo) / **B** ("Usar no carrinho") | Vista: bloco na home e selo "10% na 1ª compra" junto ao preço do produto (e2e). jsdom: abas, vigência, copiar sem prometer desconto. "Usar no carrinho" só preenche o campo de cupom da INK (nunca envia), testado na marcação documentada | Campanhas cadastradas no painel (as mesmas da INK). A Vista não tem cupons nativos |
| M06 Incentivo no carrinho + confirmação após adicionar | **C** | jsdom: progresso por peças/valor, faixas, frete nativo da INK tem prioridade, estimativa sinalizada, confirmação com sugestões reais (mais vendidos) | **Pendente**: carrinho com itens da Vista nunca observado. Leitor e réplica seguem a marcação documentada da Use Sul. Precisa liberar POST de carrinho no proxy para homologar |
| M07 Avaliações com fotos | **B** | Parser e módulo sobre a marcação real da INK (avaliações da Use Origens, só nos testes). A foto abre o depoimento de origem. Sem nota geral. Loja sem avaliações não mostra nada | `/reviews` da própria loja. **A Vista ainda não tem avaliações** |
| M08 Cards de vídeo | **B** | Painel no Chrome: envio de arquivo de vídeo, vínculo no M08, publicação e card novo na loja. Réplica e jsdom: cards no início, vídeos vinculados na página do produto, player sem som automático com a peça (nome e preço da página real) | Biblioteca de vídeos da loja (envio de arquivo ou https; servido com Range) |
| M09 Mini player | **B** | Réplica e jsdom: vídeo da peça com prioridade, fechamento respeitado (sessão/dia), recolhe com carrinho, menu ou modais, cede ao chat | Mesma biblioteca e mesmo player do M08 |
| M10 Assistente | **B** (base de respostas) / **C** (IA) | Testes: resposta da base, busca por peça no catálogo real, rastreio pelo canal nativo, recusa CPF e cartão, limite por visita no servidor, teto diário por loja. Caminho de IA testado com cliente simulado | IA com `claude-opus-5-5` (configurável), esforço baixo e fallback em caso de recusa. **Pendente: `ANTHROPIC_API_KEY`** no servidor + IA ligada para a loja. Sem chave, nenhuma chamada externa |
| M11 Guia de medidas | **B** | jsdom: tabela da modelagem pelo nome ou categoria, ao lado do guia nativo, sugestão explicável comparando com uma peça da pessoa (sem altura e peso) | Tabelas cadastradas pela loja. **Complementa** o guia nativo da INK |
| M12 Prazo de entrega | **A** | Vista: data real da INK para o CEP 01001-000 ("Entrega entre …"), pelo formulário de CEP da própria INK. Produção aparece separada | `delivery_estimates` da INK (formulário nativo; o módulo não chama o endpoint por fora) |

**Complementos do InkBoost:**
- cupom de 1ª compra perto do preço: M05;
- confirmação após adicionar, com sugestões: M06;
- guia de medidas com ajuda para escolher: M11;
- prazo na página do produto: M12;
- atendimento e descoberta no chat: M10;
- vídeos na página do produto: M08.

O compartilhamento com recompensa ficou para depois, porque falta a regra de concessão.

## Verificações executadas

- **`npm run check`** (62 testes) cobre:
  - registro e esquema;
  - lojas: isolamento A/B, publicação, liga/desliga só do módulo, restauração, liberação e pausa;
  - acesso por cliente em todas as rotas de loja, CSRF, Host, Origin e convites;
  - Worker em workerd: injeção só onde roda módulo, HTML idêntico sem módulo, falha fechada, prévia com `frame-ancestors`, mídia com Range, proxy só leitura sem analytics nem cookies, POST de carrinho só por liberação e nunca checkout;
  - os 12 módulos em jsdom sobre páginas gravadas da INK;
  - parsers;
  - assistente;
  - reinício real do processo.
- **`npm run e2e`** (27 verificações, Chrome):
  - operador cria a Vista pelo painel e gera o convite;
  - lojista aceita o convite e configura M05, M02, M03 e M12 pelos formulários;
  - a prévia ao vivo esconde o módulo desativado no rascunho;
  - salvar, publicar e conferir na loja real pelo proxy;
  - CEP real da INK;
  - desligar o M05 e restaurar a versão 1;
  - selo de 1ª compra e miniaturas no produto real;
  - vídeo enviado pelo painel aparecendo na loja;
  - instalação, painel no celular, demos, sem erros de JavaScript dos módulos.
  - Vídeos em `docs/demo/`, capturas em `docs/capturas/r2-*`.
- **`check:loja`**: Vista, Aurora e Trilha com 15 de 15 cada, em computador e celular, sem rolagem horizontal.

**Carregamento:**
- O carregador tem 10 KB; cada módulo é um arquivo próprio, baixado só onde roda.
- Vídeo, mini player, assistente e avaliações montam depois do `load`.
- Páginas lidas pelos módulos, medidas pelo cabeçalho `x-pink-fetch`:
  - na Vista, início + produto fazem 1 leitura (a coleção da aba ativa);
  - na Aurora, 2 (coleção e avaliações).
- As leituras ficam em cache na sessão por 5 a 10 minutos e passam pelo Worker sem injeção.

## Lojas demo

**Ateliê Aurora** e **Trilha Norte** são uma **réplica do HTML real da Vista**, gravado com GET (por isso aparece o logo "Entre Nós"), com identidade e combinação de módulos diferentes. O HTML é local, mas estilos, scripts e imagens continuam vindo da CDN da INK. Só os testes em jsdom são totalmente offline.
- Avaliações, vídeos (sintéticos, barras de teste) e textos são fictícios e identificados.
- Analytics é removido das páginas gravadas.
- O carrinho com itens da réplica é simulado.

## Analytics

Na **rodada 1**, as verificações pelo proxy chegaram a enviar visitas e eventos (GTM, gtag, pixel) da Vista a partir de `localhost`. Nesta rodada:
- o proxy local remove os scripts de analytics da loja;
- a réplica não os tem;
- os roteiros no Chrome bloqueiam esses domínios.

## O que falta / decisões pendentes

1. **Carrinho real (M06 e "Usar no carrinho" do M05):** liberar POST de carrinho no proxy da Vista (opção de operador "Proxy local: permitir adicionar/alterar itens", desligada) para observar a marcação real e homologar.
2. **Cupom real:** a Vista usa o texto provisório `TESTE10`. Cadastre o cupom na INK e troque no painel.
3. **IA do assistente:** `ANTHROPIC_API_KEY` no servidor + ligar "Assistente com IA" na loja.
4. **Produção:**
   - painel com domínio e login próprios (hoje só em `127.0.0.1`);
   - banco gerenciado e KV para a configuração no edge (hoje SQLite e salto HTTP);
   - armazenamento de mídia (R2);
   - rota de teste aprovada.
5. **Cobrança:** manual, fora do produto, nesta fase.
