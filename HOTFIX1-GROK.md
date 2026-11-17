# HOTFIX1 do chat v17 (base e981dc6)

Pacote local no branch `hotfix1`. Sem deploy, sem push, sem rede. `handler.ts` não muda: em `supabase/functions/chat/handler.ts:166` o evento de `prepareChat` já segue inteiro para o cliente, inclusive `code`, `message` e HTTP 200 de `fora_da_base`.

Arquivo de produção: `supabase/functions/_shared/chat_core.ts`. Fixture montada (não é captura de produção): `supabase/functions/chat/fixtures/ctx_hotfix1.json`, campo `_nota`. O recorte de Rockefeller é cópia da chave de doações com «rockefeller foundation» em `ctx_r2.json`.

## 1. Ligação com nome ausente (Q14)

`prepareChat`, depois do LAT-FORA e antes de ordenar o recorte ou reservar orçamento (`chat_core.ts:2488-2491`).

Critério, os três juntos:

- `recovered.ausentes` não está vazio.
- `entityIds` está vazio.
- Toda oração interrogativa (a que termina em `?`) é pergunta de ligação e cita um nome ausente (`soLigacaoComAusente`, `chat_core.ts:2093-2101`). O Hotfix1b apertou o corte: uma oração interrogativa respondível, mesmo sem citar o ausente, manda a pergunta ao modelo.

Recusa com `fail('fora_da_base', mensagemForaDaBase(ausentes))`. Um nome vira «X não está na base do atlas.». Desde o Hotfix1b esta recusa corre antes de `reserveCredits` (nada é reservado). `reserveBudget` não é chamado, o OpenRouter não é chamado e não há log de custo.

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

A recusa é `fail('fora_da_base')` com a mensagem genérica «Não encontrei isso na base do atlas.», sem reserva de crédito, sem reserva de orçamento e sem chamada ao modelo. O Hotfix1b também conta nota e nome de fonte, e trata quando/onde/quem/como/por que/quanto como referência à seleção.

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

Palavra inteira, maiúscula inicial preservada, nesta ordem: `decades`→`décadas`, `decade`→`década`, `centuries`→`séculos`, `century`→`século`, `members`→`membros`, `voting`→`votação`. O Hotfix1b tirou `board`→`conselho`. A troca não ocorre dentro de nome próprio (palavra ao lado com inicial maiúscula). Depois continuam `havão`→`haviam` e `(é|era|foi) member de/da/do`→`membro`. «decade de» passa a ser coberto por `decade` inteiro.

«Passaram duas decades depois.» fica «Passaram duas décadas depois.» `https://example.com/decades/board` e o título «Board decades report» permanecem.

## 5. Latência do Básico

`CHAT_RETRY_DEADLINE_MS = 25_000` (`chat_core.ts:19`). O relógio do stream é `input.now ?? Date.now`, e o início é `input.startedAt ?? Date.now`.

A segunda volta de qualidade só ocorre se o texto está em laço (`saidaEmLaco`) ou o JSON não fecha e `parseModelJson(repararJsonTruncado(text))` também falha (`jsonPodeReparar`, `chat_core.ts:3111-3112`), e ainda:

- a volta atual é a primeira,
- as tentativas HTTP cobertas pela reserva não se esgotaram (`CHAT_MAX_ATTEMPTS` = 2),
- o sinal não abortou,
- o tempo desde o início é ≤ 25 s.

JSON truncado e reparável segue com `repararJsonTruncado`, sem segunda chamada. Laço aos 30 s usa o texto atual (ilegível → `modelo_indisponivel`, 1 chamada). Laço aos 5 s faz 1 repetição.

`CHAT_MAX_TOKENS.basico` passou de 3600 para 2600 (`chat_core.ts:36`), acima do máximo observado de 2194. Avançado permanece 6000. `chatSpendCeilingUsd` lê esse teto, então a reserva cai junto. `CHAT_COST_ESTIMATE_USD.basico` fica `roundUsd(2600 × 0,0005/900)` = 0,001444 (`chat_core_test.ts` e `pauta_test.ts` atualizados para o valor novo).

## Testes

Runner: `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

Resultado do Hotfix1 (antes do 1b): **137 passed, 0 failed, 3 skipped, 9 ignored**. O Hotfix1b reexecutou a mesma suíte: **142 passed, 0 failed, 3 skipped, 9 ignored**.

Skipped (o runner offline não tem `Deno.serve`; já eram estes três):

- 402 e 403 de limite não vazam a chave
- rate_limit traz os segundos e modelo precoce é 503
- functions serve local sem OpenRouter real

Ignored (já estavam em `Deno.test.ignore` em `chat_core_test.ts`, fallback `sem_ligacao`): SPEC4 streamPrepared sem_base em dois temas; CRED1 sem_ligacao no Avançado, no Básico com cota esgotada, saldos concorrentes, release noop, falha no release, release recusado; REL1 ponta a ponta; SPEC4 streamPrepared com blocos vazios.

Novos testes em `chat_hotfix1_test.ts`, importado em `chat_core_node_test.mjs:34`. Asserções antigas, inclusive o vazamento de `chat_r2_test.ts` e SEC-01/SPEC2, seguem iguais.

## Hotfix1b

Correção da revisão que reprovou o `86ab35c` e da simulação local. Só `chat_core.ts` muda na função. Auth, CORS, SQL, rate limit, preços e modelos não mudam. O protocolo SSE não muda.

### A. Recusa antes de `reserveCredits`

`recuperarContexto` passou para antes da reserva (`chat_core.ts:2506-2518`). Q14 e S-15 devolvem `fora_da_base` em `2520-2526`, e `reserveCredits` só roda em `2530`. Sem saldo, a resposta deixa de ser `sem_creditos`.

A ordem que já existia ficou: login `2471`, body `2472`, rate `2478`. O rate limit não mudou de lugar nem de regra. Não há, neste arquivo, uma ordem auth → rate → body para reordenar: o `prepareChat` já era login → body → rate, e o handler continua JWT → leitura do body → `prepareChat`. A recuperação cabe entre o rate e a reserva sem mexer nisso.

O LAT-FORA (contexto vazio ou raiz genérica) continua depois da reserva e devolve o crédito (`2545-2548`). Falha de `chatContext` agora ocorre antes de qualquer reserva (`2516-2518`); o teste `A2 falha da consulta acontece antes da reserva de crédito` em `chat_core_test.ts` passou a exigir `reserveCalls === 0`.

Teste: `chat_hotfix1_test.ts:380` (`hotfix1b sem créditos: Q14 e S-15 saem fora_da_base e não reservam`). O Q14 com crédito, no teste de cima, também exige `reserveCalls === 0`.

### B. Ligação ausente, por oração interrogativa

`soLigacaoComAusente` (`chat_core.ts:2093-2101`) só recusa quando toda oração que termina em `?` é `perguntaDeLigacao` e cita um ausente. «O que a Rockefeller financiou no Brasil?» não é ligação, então o par inteiro vai ao modelo.

Teste: `chat_hotfix1_test.ts:404` (`hotfix1b oração respondível antes da ligação com ausente vai ao modelo`) — 1 chamada.

### C. Fora do tema com seleção, mais conservador

`termoNoRecorte` (`chat_core.ts:2112-2126`) também casa nota da entidade, título e editor da fonte, além de nome, afirmação e período. `referenciaSelecao` (`2105-2109`) trata `quando`, `onde`, `quem`, `como`, `por que`/`porque` e `quanto` como referência à seleção. `expli*` saiu dessa lista: «explique uma receita de bolo» não aponta a seleção, e os termos não casam com o recorte.

Teste: `chat_hotfix1_test.ts:421` (`hotfix1b seleção: quando vai ao modelo; explique uma receita recusa`). «quando começaram as atividades?» com `["sfa","minas1941"]` chama o modelo. «explique uma receita de bolo» com a mesma seleção é `fora_da_base`, sem reserva.

### D. Truncada reparável de verdade

`jsonPodeReparar` (`chat_core.ts:3111-3112`) faz `parseModelJson(repararJsonTruncado(text))`. Se o reparo devolve texto que não é JSON, a repetição dentro de 25 s continua.

Teste: `chat_hotfix1_test.ts:440` (`hotfix1b JSON truncado irrecuperável repete uma vez dentro do prazo`) — 2 chamadas. A truncada reparável do teste anterior continua em 1 chamada.

### E. Idioma sem `board`→`conselho`

`deslizesDeIdioma` (`chat_core.ts:1725-1738`). A troca `board` saiu. `decades`, `decade`, `centuries`, `century` e `members` não trocam quando a palavra está colada a outra com inicial maiúscula (`vizinhoComInicialMaiuscula`, `1717-1721`), como em «Decades Fund». Entrou `voting`→`votação` (`1737`).

Teste: `chat_hotfix1_test.ts:304-311`. «International Health Board», «General Education Board» e «Board of Directors» ficam. «duas decades depois» vira «duas décadas depois». «O Decades Fund» fica, e a segunda ocorrência de `decades` traduz.

### F. Rótulo de campo e token com `_`

`semRotulosDeCampo` (`chat_core.ts:1758-1772`) tira, no início da frase ou do parágrafo, `em_aberto` / `em aberto`, `justificativa`, `base`, `tipo` e `texto` seguidos de `:`, com ou sem `_`, e mantém o resto. `semSnakeSolto` (`1774-1777`), aplicado no texto visível em `1847`, tira token com `_` entre letras que sobrou. `ocultarIdsVisiveis` continua só nos ids do recorte; o snake minúsculo já vira «registro» em `publicChatText` (`pauta.ts`, arquivo intocado).

Teste: o caso foi acrescentado em `chat_r2_test.ts:115` e as asserções novas estão em `127-131`, dentro de `R2 vazamento`. As asserções que já estavam nesse teste não foram afrouxadas.

### G. Delta cru com CJK

Nenhuma mudança de código e nenhuma mudança no protocolo SSE. O delta continua sendo o pedaço cru. O evento `final` é o texto que vale: o cliente do site já usa o final no lugar do que os deltas acumularam. Se o site passar a exibir o delta, o CJK que já saiu no delta fica como backlog.

### H. Custo da primeira tentativa sem `usage.cost`

Na repetição de qualidade (`chat_core.ts:2785-2786`), se a tentativa que vai ser descartada não trouxe `usage.cost`, entra `chatPartialSpendUsd` dessa tentativa (corpo enviado, tentativas HTTP e caracteres até ali, teto `prepared.estimate`). A segunda, quando traz `cost`, soma em cima. Antes esse parcial era zerado ao limpar `usage`.

Teste: `chat_hotfix1_test.ts:472` (`hotfix1b primeira tentativa sem cost soma a estimativa parcial`). O commit e o log são a parcial da primeira mais `0.0002` da segunda.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**142 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos do Hotfix1.

## Hotfix1c

Correção da 2ª revisão e da simulação local, sobre `be9d9ea`. Na função só muda `chat_core.ts`. Auth, CORS, SQL, limites, tetos (`CHAT_OUTPUT_USD_PER_TOKEN` / `max_price`) e slugs não mudam (`BASICO_MODEL_SLUG` continua `qwen/qwen3.7-flash`). A asserção do SPEC4 (`custo da API preservado` = `0.0002`) não foi alterada.

### 1. Custo de cada tentativa

`costNow` (`chat_core.ts:2907-2912`), `custoNoCatch` (`2914-2922`) e `fecharTentativa` (`2924`). Cada tentativa entra na soma que vai para `commitBudget`, para o log e para `custo_real`:

- com `usage.cost` finito e ≥ 0: esse valor;
- erro `noCharge` sem delta: 0;
- sem `usage.cost`, mas com texto gerado (ou pedido que pode ter gerado): `chatPartialSpendUsd` daquela tentativa.

Custo já conhecido não vira estimativa. No erro de parse o log usa `costNow()` (`3100-3103`), não o teto.

SPEC4 continua uma tentativa. O stream simulado termina no mesmo instante; a repetição por poucos parágrafos só abre com decorrido ≥ 1 s e ≤ 25 s (`3057-3059`). Por isso o `usage.cost` de `0.0002` segue igual no orçamento, no log e em `custo_real`. Uma resposta real do Avançado passa de 1 s e entra na regra do item 8.

Teste: `chat_hotfix1_test.ts:563` (`hotfix1c cada tentativa entra na soma: cost, noCharge e parse`). 1ª com `0.0002` + 2ª `noCharge` liquida `0.0002` nos três lugares. Duas com cost somam, mesmo quando a 2ª não melhora o texto. Três parágrafos aos 5 s são uma tentativa e o `usage.cost` aparece igual nos três. Parse inválido aos 30 s grava `0.0002`, não a estimativa.

### 2. Estimativa parcial com preço de lista

`CHAT_MODEL_PRICE_USD_PER_TOKEN` (`chat_core.ts:86-89`) e `chatPartialSpendUsd` (`97-110`). Não é o teto de saída.

```
tokensEntrada = ceil(bytes UTF-8 de JSON.stringify(body) / 4) × max(0, tentativas)
tokensSaida   = ceil(max(0, caracteres) / 3)
bruto = tokensEntrada × prompt + tokensSaida × completion
custo = min(prepared.estimate, ceil(bruto × 1e6) / 1e6)
```

Preços, em USD/token, copiados das strings de catálogo que `proveProviderSpend` já usa em `chat_core_test.ts:183-191` (não de `CHAT_OUTPUT_USD_PER_TOKEN`):

| modelo | prompt | completion | origem no teste |
| --- | --- | --- | --- |
| Básico (Qwen) | 0.00000003 | 0.00000013 | `pricing.prompt` / `pricing.completion` do Qwen |
| Avançado (GLM) | 0.0000000699 | 0.0000014 | o objeto cujo `reason` é `tokenizer_sem_teto` |

Exemplo do teste: body `{"blob":"<25 000 x>"}` = 25011 bytes, 6000 caracteres, Avançado. `ceil(25011/4)=6253`, `ceil(6000/3)=2000`. `6253×6.99e-8 + 2000×1.4e-6 = 0.003237…`, arredondado para cima em 1e-6 = **0.003238**, abaixo de 0,02.

Teste: `chat_hotfix1_test.ts:622` (`hotfix1c estimativa parcial do Avançado usa o preço de lista`).

### 3. Q14 por pedido

`CORTE_COORDENADO` (`chat_core.ts:2267`), `temImperativo` (`2273-2274`), `pedidosDaMensagem` (`2278`) e `soLigacaoComAusente` (`2295`). A recusa só ocorre quando todo pedido (oração com `?`, corte em «e o que / e qual / e quem / e como / e quando / , o que», ou imperativo explique/fale/diga/liste/mostre/conte/resuma) é pergunta de ligação e cita um ausente. Um pedido respondível segue ao modelo; a frase de ausência entra pelo fluxo de ausentes.

Teste: `chat_hotfix1_test.ts:630` (`hotfix1c Q14 é por pedido: coordenada e imperativo vão ao modelo`). «Qual a relação com a Odebrecht e o que a Rockefeller financiou no Brasil?» e «Explique o que a Rockefeller fez em 1916. Qual a relação da Odebrecht com a Rockefeller?» chamam o modelo. O Q14 continua recusado.

### 4. Seleção só quando o escopo é claramente externo

`temVocabularioAtlas` (`chat_core.ts:2332-2335`) e `selecaoForaDaPergunta` (`2343-2349`). Com seleção e busca vazia, a recusa exige ≥ 2 termos de conteúdo sem casamento e nenhum termo do vocabulário (vínculo, ligação, relação, conexão, financi*, doaç*, patrocín*, pagamento, contribu*, controle, controlad*, acionist*, sócio, conselho, cargo, fundador, fundou, empresa, banco, governo, golpe, campanha, saúde, vacina, família, herdeiro, papel, influência, origem, histórico, data, ano, quando, quem, onde, como, por que, quanto).

Teste: `chat_hotfix1_test.ts:653` (`hotfix1c seleção: vocabulário do atlas vai ao modelo; bolo continua fora`). Com `["sfa","minas1941"]`, «Qual o vínculo direto?», «Quais foram os financiadores?» e «quando começaram as atividades?» chamam o modelo. S-15 e «explique uma receita de bolo» continuam `fora_da_base`.

### 5. CJK, idioma e eco depois da pauta

`buildPautaAnswer` roda em `chat_core.ts:3109`. O filtro comum é `filtrarProsaVisivel` em `3183-3191`, depois da pauta e da pressão e antes de inserir a frase de ausência. `pauta.ts` não foi editado. Um gancho com CJK vira a primeira linha do fato e cai ali, com `chat_cjk_removido`; o fato permanece.

Teste: `chat_hotfix1_test.ts:670` (`hotfix1c pauta: gancho com CJK sai depois da resposta e o fato fica`).

### 6. Idioma

`deslizesDeIdioma` (`chat_core.ts:1750-1786`) e `fraseInglesSolta` (`1807-1814`). Mapa de palavra inteira só no texto de bloco/pergunta (URL e título de fonte ficam de fora). Nome conhecido ou palavra entre duas iniciais maiúsculas não troca. Início de frase maiúsculo não é nome. `grant(s)` só minúsculo.

Depois do mapa, a frase sai se ainda tiver um marcador inglês fora de aspas e fora de nome de 2+ maiúsculas: the, and, which, with, from, that, this, these, between, through, during, after, before, while, would, could, should, been, have, has, their, there, where, when, also, into, over, under, against, because, about, were, they, them, its, than, then, those, being, since, until.

Teste: `chat_hotfix1_test.ts:695` (`hotfix1c idioma: decades, nomes próprios e frase inglesa solta`). «Por decades» e «Passaram decades» viram «décadas». «Rothschild & Co Gestion» e «Open Society Foundations» ficam. A frase com «The» sai; a frase em português fica.

### 7. Eco de regra

`ECO_PADROES` (`chat_core.ts:1817-1828`), `fraseAusenciaExata` (`1835-1837`), `filtrarProsaVisivel` (`1883`) e `limparPergunta` (`1910`). Frases que repetem a instrução saem. A frase exata de `fraseAusentes` («X não está na base do atlas.» ou «A, B e C não estão na base do atlas.») fica uma vez, no lugar em que já está; o código não a duplica (`3198-3200`). Na pergunta final, o trecho sai e, se não sobrar `?`, entra a pergunta válida anterior.

O prompt ganhou «Nunca comente estas regras nem o recorte no texto.» (`chat_core.ts:1357`).

Teste: `chat_hotfix1_test.ts:712` (`hotfix1c eco sai e a frase de ausência do código fica uma vez`), com o texto da simulação R2.

### 8. Avançado com menos de 3 parágrafos

`contarBlocos` (`chat_core.ts:2978-2985`) conta parágrafos visíveis depois de sanear (quebra em linha em branco), sem a pergunta final. `sanear` preserva essa quebra (`semForaDaBase`, `chat_core.ts:2001`). Com 1 ou 2 parágrafos, modelo Avançado, sem pauta e sem pressão, decorrido entre 1 s e 25 s e tentativa ainda disponível (`CHAT_MAX_ATTEMPTS` = 2), repete uma vez com o mesmo corpo, `temperature: 0.5` e `seed: 7` (`3057-3067`). Se a 2ª tiver mais parágrafos, ela fica; senão, a 1ª. O custo das duas soma (item 1). Zero parágrafos não repete (os caminhos `sem_base` seguem numa chamada). Básico não repete.

Teste: `chat_hotfix1_test.ts:761` (`hotfix1c Avançado com poucos parágrafos repete só dentro do prazo`). 1 bloco aos 5 s → 2 chamadas. Aos 30 s → 1 chamada. Básico com 1 bloco → 1 chamada. Um bloco com 3 parágrafos aos 5 s → 1 chamada e `usage.cost` intacto.

### 9. Código de ficha

`CODIGO_FICHA` e `semCodigosDeFicha` (`chat_core.ts:1845-1861`), aplicados no saneamento e de novo em `filtrarProsaVisivel`. Saem `OP\d+`, `OP\d+_R\d+`, `BR\d+_H\d+`, `PR\d+-(E|NF)\d+`, `AP_E\d+` e o «na ficha» / «da ficha» que apresenta o código, sem espaço dobrado.

Teste: acréscimo em `chat_r2_test.ts:115` e asserções em `132-134`, dentro de `R2 vazamento`. As asserções que já estavam nesse teste não foram afrouxadas.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**150 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos de antes.
