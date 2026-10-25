# personalizacoes-ink — rodada 2

Produto independente de funcionalidades por assinatura para lojas Reserva INK (nome interno, não é marca).
Uma base compartilhada, 13 módulos configuráveis por loja, painel de operador e de lojista, liberação por pacotes e
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
| M01 Cabeçalho, menu e busca | **A** | Vista: busca visível com **sugestões enquanto digita** ("abelh" → 5 Abelhinhas com foto e preço, "Ver todos os resultados"), no computador e no celular; `check:loja` com o M01 ligado. jsdom: cores, menu com grupos, comportamento ao rolar, carrinho e conta preservados, sugestões (mínimo de 2 letras, sem nomes repetidos, "Nada encontrado", erro, Esc), desfaz exatamente ao original | Cabeçalho nativo da INK (duas barras: celular e computador). Sugestões leem a busca da própria loja (`products?search_filter=`); Enter continua indo para a busca da INK |
| M02 Categorias em abas | **A** | Vista: monta na home com 8 produtos reais da coleção, sem erros e sem rolagem lateral. jsdom: troca de aba muda os produtos e o "Ver todos"; atalhos repetidos só somem depois que as abas carregam | Páginas de coleção/listagem da própria loja (cache de 5 min na sessão) |
| M03 Galeria com miniaturas | **A** | Vista: monta com as miniaturas das fotos reais, sem rolagem lateral no celular. jsdom: uma miniatura por foto navegável, clique aciona só o ponto nativo, variante intacta, acompanha a foto ativa | Carrossel nativo da INK |
| M04 Compartilhamento | **A** | Vista: monta no produto. jsdom: WhatsApp com mensagem e link canônico limpo, copiar link | Canônico da página |
| M05 Cupons (único, abas, lista) + selo de 1ª compra | **A** | Vista: bloco na home; **no produto, abas compactas logo abaixo do preço, uma por código** (título configurável, ex.: "Quer cupom? Toma!"; texto da campanha, condições recolhidas e "Copiar" → "Copiado"; cabem 3 códigos no celular, mais que isso rolam de lado com esmaecido na borda); selo "10% na 1ª compra" nos cards, com posição escolhida no painel: no topo da foto à esquerda (padrão), no topo da foto à direita ou abaixo do preço (e2e). Opção de manter o bloco grande no produto. "Usar no carrinho" verificado no carrinho real da Vista: preenche o campo de cupom da INK e não envia (a pessoa confirma lá). jsdom: abas, vigência, copiar sem prometer desconto | Campanhas cadastradas no painel (as mesmas da INK). Opcional: **cupons cadastrados na INK** lidos do frame nativo `product_promotions` do produto (código, regras, faixas progressivas; "Somente primeira compra" vira selo "R$10,00 OFF na 1ª compra"), sem repetir códigos do painel. O frame é `lazy` na INK: o módulo lê o endereço dele direto, sem esperar a rolagem; os cupons do painel aparecem antes. O selo de um cupom da INK fica só no preço do produto principal (o cupom vale para aquele produto), nunca nos cards de outros. Essa leitura é **B**: testada na estrutura nativa (fixture reduzida, códigos fictícios), porque a Vista não tem cupons nativos |
| M06 Incentivo no carrinho + confirmação após adicionar | **A** | Vista (proxy com carrinho liberado, item de teste removido no fim): adicionar pela página do produto mostra o incentivo no modal "Produto adicionado" da INK; na gaveta, "Faltam 1 peça…" com 1 item e troca de faixa ao aumentar a quantidade. Marcação real capturada em `test/fixtures/ink/cart-drawer-com-item.html` e `last-added-product.html` (tokens removidos). jsdom: faixas, frete nativo com prioridade, participação por coleção pelo id do produto | Gaveta `turbo-frame#cart` e modal `#last_added_product` da INK. A INK **substitui** o `#last_added_product` a cada adição (o módulo refaz a observação). O item do carrinho não tem link do produto: a participação por coleção usa o id |
| M07 Avaliações com fotos | **B** | Parser e módulo sobre a marcação real da INK (avaliações da Use Origens, só nos testes). A foto abre o depoimento de origem. Sem nota geral. **Nota mínima** (padrão 4★; avaliação 2★ some da vitrine, aparece com "todas") e "só com texto" nas recentes. Loja sem avaliações não mostra nada | `/reviews` da própria loja. **A Vista ainda não tem avaliações** |
| M08 Cards de vídeo | **B** | Painel no Chrome: envio de arquivo de vídeo, vínculo no M08, publicação e card novo na loja. Réplica e jsdom: cards no início, vídeos vinculados na página do produto, player sem som automático com a peça (nome e preço da página real) | Biblioteca de vídeos da loja (envio de arquivo ou https; servido com Range) |
| M09 Mini player | **B** | Réplica e jsdom: vídeo da peça com prioridade, fechamento respeitado (sessão/dia), recolhe com carrinho, menu ou modais, cede ao chat | Mesma biblioteca e mesmo player do M08 |
| M10 Assistente | **A** | Vista: "tem estampa de mãe?" → peças e a coleção Mães; "camiseta de pai" → coleção Pais (o tipo de peça não vira tema); "cachorro" → Pets; "namorado" → Casais; "presente pra vó" e "abelha" → busca da INK (com trecho do nome: "abelh" acha "Abelhinhas"); tema inexistente → "Não encontrei peças com…" e atendimento; dúvida → base de respostas. Testes: rastreio pelo canal nativo, recusa CPF e cartão, limites por visita e por dia | **Sem IA** (decisão do dono): base de respostas da loja, coleções do menu (com sinônimos comuns: papai, mamãe, filho, pet, namorado, fé) e busca nativa da INK. Nomes repetidos (uma cor por produto na INK) aparecem uma vez. Nenhuma chamada externa além da própria loja |
| M11 Guia de medidas | **B** | jsdom: tabela da modelagem pelo nome ou categoria, ao lado do guia nativo, sugestão explicável comparando com uma peça da pessoa (sem altura e peso) | Tabelas cadastradas pela loja. **Complementa** o guia nativo da INK |
| M12 Prazo de entrega | **A** | Vista: data real da INK para o CEP 01001-000 ("Entrega entre …"), pelo formulário de CEP da própria INK. Produção aparece separada | `delivery_estimates` da INK (formulário nativo; o módulo não chama o endpoint por fora) |
| M13 Aviso de cookies | **A** | Vista: o aviso nativo da INK vira cartão no canto (computador) ou cartão compacto no rodapé (celular), com as cores e os cantos da identidade, acima da barra de compra do celular; o assistente sobe só do lado do aviso. `check:loja` com o M13 ligado (flutuantes não cobrem o aviso). jsdom: texto e botão trocáveis mantendo o link da Política de Privacidade e a ação de aceite da INK; desmontar devolve o original | `.cookie-acceptance` da INK: quem mostra, esconde e guarda o aceite continua sendo a INK |

**Complementos do InkBoost:**
- cupom de 1ª compra perto do preço: M05;
- confirmação após adicionar, com sugestões: M06;
- guia de medidas com ajuda para escolher: M11;
- prazo na página do produto: M12;
- atendimento e descoberta no chat: M10;
- vídeos na página do produto: M08.

O compartilhamento com recompensa ficou para depois. Na loja de referência observada, a concessão é **por confiança**: o clique no WhatsApp libera o cupom, sem verificação, e o código fica legível no HTML. Se for adotado assim, o cupom precisa ser tratado como público (decisão do dono).

## Integração com a INK (painel → Integração)

Cada loja tem uma aba **Integração**, aberta ao operador e ao lojista da própria loja. Ela pré-carrega os módulos com o que já existe na INK, para o cliente não precisar cadastrar tudo à mão. O cadastro manual continua disponível e tem prioridade.

| Fonte | Situação | O que traz |
| --- | --- | --- |
| Leitura da loja (qualquer plano) | **A**: Vista, 10 de 10 páginas lidas, 10 perguntas, Instagram, 15 coleções; nenhum cupom, porque a Vista não tem cupons nativos | Páginas públicas, só GET e no servidor: início, `/faq`, `/exchanges_and_returns`, `/about` e 3 produtos com o frame `product_promotions`. Cupons e faixas da promoção progressiva ("2 itens - R$20,00 OFF") viram, com um clique, campanhas do M05 e faixas do M06 **no rascunho**: o lojista revisa e publica. O M10 usa sozinho FAQ, trocas, sobre e redes, com a opção "Responder também com o que a loja já publicou na INK", ligada por padrão. Uma leitura com mais de 12 horas é renovada em segundo plano; se a leitura falha, o último retrato bom é mantido. Cupons e faixas foram testados sobre a estrutura nativa (fixture com códigos fictícios), portanto **B** |
| API da INK (plano com API) | **B**: segue o contrato oficial ([developers.reserva.ink](https://developers.reserva.ink/referencia/)), testado com respostas no formato documentado, ainda sem um token real | O token é guardado cifrado (AES-GCM) e nunca volta ao painel nem vai para a loja: o painel mostra só os 4 últimos caracteres. Só leituras, no máximo cerca de 18 chamadas por leitura (o limite da INK é 100 por minuto): **promoções** (`GET /v1/stores/promotions`: desconto, progressiva e leve N pague N-1, com vigência, primeira compra, alcance e se é automática) → cupom no M05 (só as que exigem código) e metas no M06 (inclusive a coleção participante); **categorias** (`/v1/stores/collections`, na ordem do menu) → abas do M02; **produtos publicados** (`/v1/stores/products`: nome, tags, tipo, tamanhos disponíveis, mais vendidos, agrupamento) → busca do M10 por nome e tags, mais vendidos primeiro. Um recurso sem escopo não impede os outros; o problema aparece na aba. Escopos: `store.promotions.read`, `store.categories.read`, `store.products.read` |

## Layout clássico da INK

A Vista usa o layout novo da INK; outras lojas usam o clássico. Os módulos foram rodados em jsdom sobre páginas de duas lojas INK de referência no layout clássico, gravadas só para leitura (o HTML **não** está no repositório): início e produto, computador e celular, com os frames carregados. Resultado: todos os módulos de início e produto montam, sem erros, nos dois layouts (miniaturas, guia de medidas ao lado do nativo, prazo, selo perto do preço, carrinho). A sonda achou um defeito, já corrigido: o link nativo "Confira suas medidas" se liga ao formulário pelo atributo `form=` e pode ficar fora do `<form>`; o M11 caía no lugar alternativo (abaixo do preço) nessas lojas e também na Vista ao vivo. Os seletores usados (`header.header`, `[id^="dot-image-"]`, `#open-modal-size`, `.card-thumb__prices-v2`, `.cart-drawer`, `#last_added_product`, `.cookie-acceptance`, `.form-product-options__add-to-cart-mobile`) existem nos dois. É verificação **B**: não houve instalação nessas lojas.

## Verificações executadas

- **`npm run check`** (72 testes) cobre:
  - registro e esquema;
  - lojas: isolamento A/B, publicação, liga/desliga só do módulo, restauração, liberação e pausa;
  - acesso por cliente em todas as rotas de loja, CSRF, Host, Origin e convites;
  - Worker em workerd: injeção só onde roda módulo, HTML idêntico sem módulo, falha fechada, prévia com `frame-ancestors`, mídia com Range, proxy só leitura sem analytics nem cookies, POST de carrinho só por liberação e nunca checkout;
  - os 13 módulos em jsdom sobre páginas gravadas da INK;
  - parsers;
  - assistente;
  - reinício real do processo.
- **`npm run e2e`** (29 verificações, Chrome):
  - operador cria a Vista pelo painel e gera o convite;
  - lojista aceita o convite e configura M05, M02, M03 e M12 pelos formulários;
  - a prévia ao vivo esconde o módulo desativado no rascunho;
  - salvar, publicar e conferir na loja real pelo proxy;
  - CEP real da INK;
  - desligar o M05 e restaurar a versão 1;
  - selo de 1ª compra e miniaturas no produto real;
  - vídeo enviado pelo painel aparecendo na loja;
  - assistente: "tem estampa de mãe?" traz peças e a coleção Mães;
  - instalação, painel no celular, demos, sem erros de JavaScript dos módulos.
  - Vídeos em `docs/demo/`, capturas em `docs/capturas/r2-*`.
- **`check:loja`**: em computador e celular, módulos montados, sem erros, sem rolagem horizontal e, no celular, **botões flutuantes sem cobrir a barra de compra, o aviso de cookies nem a ajuda da INK**. Vista: 18 de 18 (com carrinho, assistente e cabeçalho ligados).

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
- O carrinho com itens da réplica é simulado, na estrutura real capturada da Vista.

## Analytics

Na **rodada 1**, as verificações pelo proxy chegaram a enviar visitas e eventos (GTM, gtag, pixel) da Vista a partir de `localhost`. Nesta rodada:
- o proxy local remove os scripts externos de analytics (GTM, Google Analytics, Meta, Segment, Konduto/k-analytix, Cloudflare Insights) e, nos scripts da própria loja, troca os domínios de rastreamento por um endereço inválido (o código da loja continua funcionando);
- o rastreio próprio da INK (ahoy) envia POST para `/ahoy/visits` e `/ahoy/events` no domínio da loja: o proxy recusa (405), também com o carrinho liberado. `mimis-production.rsvcloud.com` é o serviço de imagens da INK, não rastreio;
- a réplica não os tem;
- os roteiros no Chrome bloqueiam esses domínios.

## O que falta / decisões pendentes

1. **Cupom real:** a Vista usa o texto provisório `TESTE10`. Cadastre o cupom na INK e troque no painel.
2. **Produção:**
   - painel com domínio e login próprios (hoje só em `127.0.0.1`);
   - banco gerenciado e KV para a configuração no edge (hoje SQLite e salto HTTP);
   - armazenamento de mídia (R2);
   - rota de teste aprovada.
3. **API da INK:** homologar com um token real de uma loja com plano de API. Ficaram para decidir: "Também disponível em" (agrupamentos de estampa da API) e o assistente respondendo frete por CEP (`/v1/stores/shipping_simulation`, valor estimado sobre uma camiseta padrão).
4. **Cobrança:** manual, fora do produto, nesta fase.
