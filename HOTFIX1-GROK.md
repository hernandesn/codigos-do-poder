# HOTFIX1 do chat v17 (base e981dc6)

Pacote local no branch `hotfix1`. Sem deploy, sem push, sem rede. `handler.ts` não muda: em `supabase/functions/chat/handler.ts:166` o evento de `prepareChat` já segue inteiro para o cliente, inclusive `code`, `message` e HTTP 200 de `fora_da_base`.

Arquivo de produção: `supabase/functions/_shared/chat_core.ts`. Fixture montada (não é captura de produção): `supabase/functions/chat/fixtures/ctx_hotfix1.json`, campo `_nota`. O recorte de Rockefeller é cópia da chave de doações com «rockefeller foundation» em `ctx_r2.json`.

## 1. Ligação com nome ausente (Q14)

`prepareChat`, depois do LAT-FORA e antes de ordenar o recorte ou reservar orçamento (`chat_core.ts:2488-2491`).

Critério, os três juntos:

- `recovered.ausentes` não está vazio.
- `entityIds` está vazio.
- Toda oração (corte em `?`, `.`, `!` e quebra de linha) que cita um nome ausente é `perguntaDeLigacao`, e ao menos uma oração cita (`soLigacaoComAusente`, `chat_core.ts:2043-2054`). Oração que não cita o ausente não entra na conta. Se nenhuma cita, a pergunta segue ao modelo.

Recusa com `fail('fora_da_base', mensagemForaDaBase(ausentes))`. Um nome vira «X não está na base do atlas.». O crédito já reservado volta por `releasePair`. `reserveBudget` não é chamado, o OpenRouter não é chamado e não há log de custo. `releaseBudget` roda no par, sem hold, e não muda gasto nem reserva.

Exemplos:

- «Qual a relação da família Odebrecht com a Fundação Rockefeller?» A busca de texto e a variante `rockefeller foundation` devolvem a Fundação Rockefeller (`tipo: fundacao`). A busca `|odebrecht` (e `|familia odebrecht`) devolve vazio. Ausente: «Odebrecht». A única oração é pergunta de ligação. Resultado: HTTP 200, `fora_da_base`, «Odebrecht não está na base do atlas.», 0 chamadas ao modelo, crédito devolvido, orçamento sem hold.
- «qual a ligação de Soros e Lula? pq Soros comemorou a vitória de Lula?» A segunda oração cita Lula e não é pergunta de ligação. Com e sem seleção `["sfa","minas1941"]` o pedido segue ao modelo. Os testes SOE30–SOE33 continuam.

## 1b. Timeout não liquida o teto

`chatPartialSpendUsd` (`chat_core.ts:86-98`) usa o mesmo preço de `chatSpendCeilingUsd` (`CHAT_OUTPUT_USD_PER_TOKEN`, sem número novo):

```
preço = CHAT_OUTPUT_USD_PER_TOKEN[modelo]
tokensEntrada = bytes UTF-8 de JSON.stringify(body) + CHAT_TEMPLATE_TOKEN_ALLOWANCE
bruto = (2 × tokensEntrada × max(0, tentativas HTTP enviadas) + ceil(max(0, caracteres) / 3)) × preço
custo = min(prepared.estimate, ceil(bruto × 1e6) / 1e6)
```

`tentativasEnviadas` sobe só quando `stream()` começa de fato (`chat_core.ts:2698`). `charsGerados` soma os deltas de todas as tentativas (`chat_core.ts:2710`) e não zera quando o texto da repetição é descartado.

No `catch` (`custoNoCatch`, `chat_core.ts:2639-2645`; liquidação e log em `2751-2755`):

- `usage.cost` presente: a conta antiga (`custoConhecido`, inclusive a metade do teto da tentativa anterior sem custo).
- Sem delta, sem usage e erro `noCharge`, e sem tentativa anterior já cobrada: 0, e `unwind` solta o hold.
- Com caracteres gerados: a fórmula acima.
- Sem caracteres e sem `usage.cost`, fora desse `noCharge`: `prepared.estimate`. Esse caminho cobre interrupção e aborto sem delta (SEC-01) e o SSE 429 aceito sem custo (SPEC2). O sucesso sem `usage.cost` também continua em `prepared.estimate` (`costNow`, `chat_core.ts:2638`).

## 2. Fora do tema com seleção (S-15)

`selecaoForaDaPergunta` (`chat_core.ts:2074-2083`), chamada em `prepareChat` (`chat_core.ts:2493-2496`). `textoVazio` é o vazio da busca por texto, gravado antes da seleção substituir o recorte (`chat_core.ts:1133`).

Critério, todos juntos:

- `entityIds` não está vazio.
- A busca por texto da própria pergunta (as chamadas que `recuperarContexto` faz antes da seleção) veio vazia.
- `contextSearchTokens` tem mais de 1 termo. Com 0 ou 1 termo não há recusa por este critério.
- A mensagem não referencia a seleção: `essa(s)`, `esse(s)`, `esta(s)`, `este(s)`, `isso`, `isto`, `selecionad*`, `entidade(s)`, `mural`, `ligação`/`relação`, `liga`, `conecta*`, `compar*`, `resum*`, `expli*`, `fale`, `conte`, `quem`, `o que é`, `o que foi` (`referenciaSelecao`, `chat_core.ts:2058-2061`).
- Nenhum termo, depois de `radicalSimples`, casa com nome de entidade/raiz, afirmação ou período do recorte da seleção (`casaRadical`, o mesmo uso de `ordenarRecortePorPergunta`).

A recusa é `fail('fora_da_base')` com a mensagem genérica «Não encontrei isso na base do atlas.», sem reserva de orçamento e sem chamada ao modelo. O crédito volta como no item 1.

Exemplos, seleção `["sfa","minas1941"]` (recorte de febre amarela / vacina 17D em `ctx_r2.json`):

- «Me passa uma receita de bolo de cenoura com cobertura de chocolate?» Texto vazio, seis termos, nenhum casa, sem dêixis. `fora_da_base`, 0 chamadas.
- «o que liga essas entidades?» e «resuma» vão ao modelo (`liga`/`essas`/`entidades` e `resum*`). «bolo» tem um termo só e também vai.
- Soros/Lula com essa seleção: a busca por texto acha recorte, então este critério não dispara.
- «A vacina 17D circulou no Brasil em 1937?»: «vacina» casa com a afirmação do recorte e vai ao modelo. «17d» tem 3 letras e não entra em `contextSearchTokens`.

## 3. Básico (qwen)

CJK (`\p{Script=Han}`, Hiragana, Katakana, Hangul) no texto visível de bloco e da pergunta final (`CJK_VISIVEL`, `chat_core.ts:1710`; queda de frase em `1808-1809`, a mesma de `semForaDaBase`). Frase com CJK sai. Bloco vazio sai. `console.info` grava só `{ evento: 'chat_cjk_removido', n }`. O evento final não leva CJK. Delta já emitido permanece.

«A 介入ção da fundação foi ampla. A campanha começou em 1916.» fica «A campanha começou em 1916.»

Prompt do Básico e do Avançado, fundido nas linhas que já existiam (o fixo passou de 5810/5811 para 5803/5804):

- `chat_core.ts:1326` — «Escreva só em português do Brasil, sem caracteres de outros alfabetos e sem palavras em inglês.»
- `chat_core.ts:1330` — «Fique no tema exato da pergunta; não puxe outros temas do recorte (doações, outros países, outras famílias) se a pergunta não pedir.»
- `chat_core.ts:1341` — «A pergunta final só liga nomes que o recorte liga; nunca insinue controle, comando ou financiamento entre entidades sem relação no recorte.»

O alvo «Entre 450 e 700 palavras» e o corte `CHAT_MAX_WORDS.basico` de 1000 palavras ficam como estavam. `BASICO_MODEL_SLUG` continua `qwen/qwen3.7-flash`.

## 4. Deslizes de idioma

`deslizesDeIdioma` (`chat_core.ts:1713-1723`), aplicado em `ortografia` só fora de URL (`chat_core.ts:1738`). Título de fonte passa por `publicChatText` / `fonteDetalhe`, não por esta troca.

Palavra inteira, maiúscula inicial preservada, nesta ordem: `decades`→`décadas`, `decade`→`década`, `centuries`→`séculos`, `century`→`século`, `members`→`membros`, `board`→`conselho`. Depois continuam `havão`→`haviam` e `(é|era|foi) member de/da/do`→`membro`. «decade de» passa a ser coberto por `decade` inteiro.

«Passaram duas decades depois.» fica «Passaram duas décadas depois.» `https://example.com/decades/board` e o título «Board decades report» permanecem.

## 5. Latência do Básico

`CHAT_RETRY_DEADLINE_MS = 25_000` (`chat_core.ts:19`). O relógio do stream é `input.now ?? Date.now`, e o início é `input.startedAt ?? Date.now`.

A segunda volta de qualidade só ocorre se o texto está em laço (`saidaEmLaco`) ou o JSON não fecha e `repararJsonTruncado` também falha (`chat_core.ts:2725-2731`), e ainda:

- a volta atual é a primeira,
- as tentativas HTTP cobertas pela reserva não se esgotaram (`CHAT_MAX_ATTEMPTS` = 2),
- o sinal não abortou,
- o tempo desde o início é ≤ 25 s.

JSON truncado e reparável segue com `repararJsonTruncado`, sem segunda chamada. Laço aos 30 s usa o texto atual (ilegível → `modelo_indisponivel`, 1 chamada). Laço aos 5 s faz 1 repetição.

`CHAT_MAX_TOKENS.basico` passou de 3600 para 2600 (`chat_core.ts:36`), acima do máximo observado de 2194. Avançado permanece 6000. `chatSpendCeilingUsd` lê esse teto, então a reserva cai junto. `CHAT_COST_ESTIMATE_USD.basico` fica `roundUsd(2600 × 0,0005/900)` = 0,001444 (`chat_core_test.ts` e `pauta_test.ts` atualizados para o valor novo).

## Testes

Runner: `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

Resultado: **137 passed, 0 failed, 3 skipped, 9 ignored**.

Skipped (o runner offline não tem `Deno.serve`; já eram estes três):

- 402 e 403 de limite não vazam a chave
- rate_limit traz os segundos e modelo precoce é 503
- functions serve local sem OpenRouter real

Ignored (já estavam em `Deno.test.ignore` em `chat_core_test.ts`, fallback `sem_ligacao`): SPEC4 streamPrepared sem_base em dois temas; CRED1 sem_ligacao no Avançado, no Básico com cota esgotada, saldos concorrentes, release noop, falha no release, release recusado; REL1 ponta a ponta; SPEC4 streamPrepared com blocos vazios.

Novos testes em `chat_hotfix1_test.ts`, importado em `chat_core_node_test.mjs:34`. Asserções antigas, inclusive o vazamento de `chat_r2_test.ts` e SEC-01/SPEC2, seguem iguais.
