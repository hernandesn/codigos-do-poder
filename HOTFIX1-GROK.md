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

## Hotfix1d

Sobre `79af07d`. Aprovado pelo dono: o Básico passa para DeepSeek. Na função só muda `chat_core.ts`. Auth, CORS, SQL e limites diários não mudam. O teto `CHAT_OUTPUT_USD_PER_TOKEN` e `CHAT_MAX_TOKENS.basico` (2600) não mudam. As frases das seções anteriores que dizem que o Básico continua no Qwen, que o Básico não repete e que a repetição curta exige 1 s ficam como histórico; esta seção as substitui.

### 0. Achados da revisão Codex do 1c (79af07d, REPROVADO)

Texto depois de «tokens used» em `~/.grokbot-codex/chat-hotfix-v17c-codex.log`.

- ALTA (revisão `:3017`): o retry do Avançado seguido de `modelo_ocupado` fazia 3 chamadas, acima de `CHAT_MAX_ATTEMPTS` = 2, e a liquidação passava a reserva. Corrigido. `chamadasModelo` sobe antes de cada `stream()` (`chat_core.ts:3367`). `podeRepetir` (`3418`) e o `continue` de ocupado (`3390-3392`) exigem `chamadasModelo < 2`. O mesmo contador cobre 429/ocupado, qualidade, poucos blocos, ids e Básico curto. `fecharValor` (`3251-3256`) limita a soma à reserva, exceto quando um `usage.cost` conhecido já passa dela (SEC-01). Teste: `chat_hotfix1_test.ts:902` (`hotfix1d custo por tentativa, teto de chamadas e JSON ruim devolve a primeira`), trecho «poucos blocos mais 429» (`939-947`): 2 chamadas, commit `0.0002` ≤ reserva.
- MÉDIA (`:2907`/`:2914`): custo conhecido e desconhecido por tentativa, inclusive zero. Corrigido. Livro `gastos` (`3239`), `costNow` (`3258-3263`), `custoNoCatch` (`3264-3272`), `fecharTentativa` (`3273-3281`), `registrarFalha` (`3282-3291`). `usage.cost` 0 é conhecido. 1ª com cost 0 + 2ª `noCharge` liquida 0. Erro sem texto depois de tentativa paga soma `chatPartialSpendUsd` da tentativa atual com 0 caracteres. Sem delta e sem custo conhecido positivo, o erro continua no teto (SPEC2 SSE / SEC-01). Teste: o mesmo `chat_hotfix1_test.ts:902`.
- MÉDIA (`:3050`/`:3070`): 1ª resposta válida + 2ª com JSON irrecuperável devolve a 1ª. Corrigido em `3420-3422` (vale para todo retry que já guardou texto). Se a repetição era de ids, cai na resposta documental em vez de republicar o texto sem id (`3403-3407`, `3421`). Teste: o mesmo `chat_hotfix1_test.ts:902`, trecho do JSON ruim.
- MÉDIA (`:2348`): com seleção, «Explique o contrato detalhadamente» e «Quais os principais fatos?» não podem ser recusadas. Corrigido. `pedidoGenericoSelecao` (`2633-2637`) deixa passar explique/resuma/detalhe/fatos/principais/contrato/documento/isso/eles/elas. Receita, futebol, clima e programação continuam fora. Teste: `chat_hotfix1_test.ts:959`. «explique uma receita de bolo» segue «Não encontrei isso na base do atlas.».
- MÉDIA (`:2267`/`:2274`): «Qual a relação com a Odebrecht e quais foram as ações da Rockefeller?» vai ao modelo. Corrigido. `CORTE_COORDENADO` inclui «e quais» antes de «e qual» e «e quem» (`2556`). `temImperativo` inclui descreva/descrevam/apresente/apresentem/compare/comparem (`2562-2564`). Na dúvida, não recusa. O Q14 original continua recusado. Teste: `chat_hotfix1_test.ts:975`.
- MÉDIA (`:1759`/`:1807`/`:1817`): filtros derrubavam conteúdo legítimo. Corrigido. `deslizesDeIdioma` mascara nome do recorte e sequência Capitalizada + Board/Fund/Foundation/Trust (`1884-1897`). `spansProtegidos` protege URL e «and» entre nomes (`1958-1968`), então «Bill and Melinda Gates» não cai. O eco de «documentos anexos» só casa com «nos/dos documentos anexos fornecidos» ou «a esta conversa» (`1992`), e `casaForaDeUrl` (`1999`) não filtra URL. Teste: `chat_hotfix1_test.ts:997`.
- BAIXA (`:3059`): piso de 1 s do retry curto. Não é bug à parte. O item 6 troca essa condição por uma que não depende de relógio. Registrado aqui e coberto pelo teste de 1 bloco aos 0 ms.

### 1. Modelo do Básico

`BASICO_MODEL_SLUG` (`chat_core.ts:25`) = `deepseek/deepseek-v4.1-flash-1017`. `CHAT_REASONING.basico` continua `{ effort: 'none' }` (`32`). Avançado continua `z-ai/glm-5.3` com `{ effort: 'minimal', exclude: true }`. `CHAT_MAX_TOKENS.basico` continua 2600 (`36`). O teto `CHAT_OUTPUT_USD_PER_TOKEN.basico` continua `0.0005/900` (`39-41`).

Preço de lista, em USD/token, informado pelo dono como tabela OpenRouter de 2026-11-17. Não houve consulta de rede nesta sessão.

| modelo | prompt | completion | origem |
| --- | --- | --- | --- |
| Básico (DeepSeek V4.1 Flash) | 0.000000036 | 0.0000005 | lista OpenRouter de 2026-11-17, dada pelo dono |
| Avançado (GLM) | 0.0000000699 | 0.0000014 | o mesmo de antes: objeto `tokenizer_sem_teto` em `chat_core_test.ts` |

`CHAT_MODEL_PRICE_USD_PER_TOKEN.basico` (`89-91`). Os dois preços do Básico são ≤ `0.0005/900` (≈ 5,56e-7), então `max_price` não filtra o endpoint. A reserva do Básico continua `roundUsd(2600 × 0.0005/900)` = 0.001444.

Asserções de slug atualizadas, e só elas: `chat_core_test.ts:175` e `:257`, `chat_r2_test.ts:185`, `pauta_test.ts:177`. As fixtures de catálogo do Qwen em `proveProviderSpend` ficam.

Teste: `chat_hotfix1_test.ts:831` (`hotfix1d preço de lista do DeepSeek cabe no teto do Básico`).

### 2. Regressão R3 (Walther–IBEC)

Resposta substantiva não vira recusa.

- `traduzirApelidos` (`1706-1731`) aceita o id real em qualquer caixa (`idCanonico`, `1656`), o apelido `[n]`/`#n`/`n`, `R<n>`/`F<n>`/`E<n>` só do tipo certo (`idPorRotulo`, `1668`) e slug por nome normalizado, iniciais ou prefixo único (`idPorSlug`, `1687`). O resto continua desconhecido.
- Sem id válido e com texto, `reatribuirPorNome` (`1764`) também usa sigla e segmento (`entidadesNoTexto`, `1745`; `siglasDe`, `1734`). IBEC entre parênteses entra por `segmentosDe`.
- Ainda sem id e com ≥ 2 blocos de texto: se o prazo ≤ `CHAT_RETRY_DEADLINE_MS` (25 s) e ainda houver tentativa, uma repetição com o mesmo corpo e o lembrete `LEMBRETE_IDS` (`2716`, `3430-3435`). Se a repetição falhar, `respostaDocumental` (`2692`) monta a resposta do recorte e cobra. `fora_da_base` depois do modelo só com `sem_base` sem bloco válido ou sem texto (`3510-3524`). Recusa meta não conta como substantivo (`textoSubstantivo`, `2515`).

Testes: `chat_hotfix1_test.ts:840` (slugs e R13/F14, 1 chamada, ids reais) e `:873` (sem nome aos 5 s → 2 chamadas; aos 30 s → documental com «Contrato de 1936», nunca `fora_da_base`).

### 3. Pergunta final e fecho sem insinuação

Prompt em `chat_core.ts:1358`. A frase antiga («A pergunta final só liga nomes que o recorte liga…») permanece. A nova pede ligação aberta, sem fato novo, sem ocultação, culpa, «quem sabia» nem «nunca». Para o prompt fixo não passar do baseline de 5810 caracteres (`chat_fix_selecao_test.ts:645`), os parênteses de exemplo em `pontes_entre_raizes` e no cargo de conselho foram enxugados (`1354-1355`). As frases que os testes procuram continuam. O fixo do Básico ficou em 5628.

Filtro `FRASE_INSINUA` (`2098`), case-insensitive. «sabia do buraco» aceita até quatro palavras no meio, para apanhar «sabia do tamanho do buraco». Na pergunta, `limparPergunta` (`2185-2189`) troca o texto por «Que outros vínculos documentados ligam X a Y no atlas?» (`perguntaNeutra`, `2152`). No fecho, só a frase que contém «O que liga tudo» e casa com o filtro sai (`2134`).

Teste: `chat_hotfix1_test.ts:1036`. As quatro frases da especificação saem; o fato de 1936 fica.

### 4. Mapa de idioma

`deslizesDeIdioma` (`1884-1953`). Ordem: máscara de nome, «funding loan» entre aspas vira um placeholder e só volta no fim (`1899`, `1952`), depois as expressões compostas (`1906-1908`), depois as palavras soltas (`1930-1944`). «and» entre duas palavras já traduzidas vira «e» (`1946-1950`); entre nomes próprios não. `concordarDoacao` (`1860-1880`) acerta artigo e particípio de doação/doações.

`semCodigosDeFicha` (`2042-2069`) tira as locuções «na ficha da operação», «na ficha do caso», «da ficha da operação», «segundo a ficha», «na mesma ficha» e reescreve «a ficha do X registra» só quando havia código. «ficha de compromisso» e o título da fonte ficam.

A asserção existente `chat_hotfix1_test.ts:712` passou de «O grant pagou o contrato.» para «A doação pagou o contrato.». É a concordância pedida neste item, não um afrouxamento.

Teste novo: `chat_hotfix1_test.ts:997`. «Rothschild & Co Gestion», «Open Society Foundations», «International Health Board», «National Science Board», «Bill and Melinda Gates» e a URL ficam.

### 5. Referência pendente

`ANAFORA_SEM_ANTECEDENTE` e `semAnaforaPendente` (`2072-2095`). Roda em `filtrarProsaVisivel` (`2130`) e em `semForaDaBase` (`2288`), para a frase seguinte não perder o antecedente quando o filtro anterior já colou o resto. Com menos de 2 frases restantes, cai o bloco. Teste: o mesmo `chat_hotfix1_test.ts:997`, trecho da anáfora (`1025-1033`).

### 6. Retry do Avançado por poucos blocos

Sem piso de 1 s. `querRetryCurto` (`2733-2739`): o argumento `repetirCurto` vence; senão, `CHAT_RETRY_CURTO=0` desliga. O runner põe essa variável em `chat_core_node_test.mjs:31`, antes dos imports, para os testes antigos (SPEC4 inclusive) continuarem numa chamada. `rodarModelo` passa `repetirCurto: true` (`chat_hotfix1_test.ts:556`). O teto de 25 s permanece (`3418`, `3440-3449`). Vale para os dois modelos.

Teste: `chat_hotfix1_test.ts:949-956` (1 bloco aos 0 ms → 2 chamadas), dentro de `hotfix1d custo…`.

### 7. Básico curto

A mesma repetição do item 6, com soma de custo. A asserção que era «Básico com 1 bloco não repete» / 1 chamada passou a 2 chamadas e commit `0.0002 + 0.0003` (`chat_hotfix1_test.ts:792-793`), no teste `hotfix1c Avançado com poucos parágrafos repete só dentro do prazo`. É a regra nova, não um afrouxamento. O eco do hotfix1c ganhou dois parágrafos para continuar em 1 chamada.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**158 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Os 8 testes a mais são os deste hotfix.

## Hotfix1e

Sobre `5f1cd25`. A revisão Codex desse commit deu REPROVADO e a simulação ficou em 3,69 (meta ≥ 3,9). Na função só muda `chat_core.ts`. Auth, CORS, SQL e limites não mudam. O Básico continua `deepseek/deepseek-v4.1-flash-1017` (`chat_core.ts:25`). O que o Hotfix1d diz sobre liquidar um `usage.cost` acima da reserva fica como histórico; esta seção substitui esse comportamento.

### 1. ALTA — liquidação acima da reserva

Achado Codex `:3254`. `liquidar` (`chat_core.ts:3347`) devolve `min(real, reserva)`. O real integral segue para `custo_real` (`3704`) e para `custo_usd` do log. Quando o real passa a reserva em mais de 1e-9, um `console.info` grava `{ evento: 'chat_custo_acima_reserva', reserva, real }` (`3351`). `commitBudget` na saída boa usa `liquidar(custo)` (`3656`); `unwind` liquida do mesmo jeito. SSE aceito sem delta e sem custo conhecido continua no teto (`custoNoCatch`, `3364`).

Teste: `chat_hotfix1_test.ts:1176` (`hotfix1e custo acima da reserva…`). Reserva forçada `0.132960`, cost `0.133960` → commit `0.132960`, `custo_real` e log `0.133960`, evento com os dois números.

SEC-01 modo `real` (`chat_core_test.ts:1971`): a reserva do Básico é ~0,030347, então `gasto` passou a `Math.min(0.5, ceiling)`. `custo_real` continua `0.5`. As outras três modalidades (sucesso sem usage, interrupção, aborto) continuam no teto.

### 2. ALTA — fallback documental

Achado Codex `:2695`. `respostaDocumental` (`2789`) só publica relação com confiança alta ou estado `retrato_documental` / `historico` / `identificacao` (`relacaoDocumentada`, `2774`). Contestada, sem prova, alegação, acusação, hipótese, inferência, rascunho ou confiança baixa sai (`relacaoContestada`). Acusação contra pessoa (id ou nome no texto) também sai (`acusaPessoa`, `2763`), inclusive na nota. Relação aproveitada leva `limite` e `confiança` no texto: `afirmação (confiança alta; limite)`. A campanha de 1936 continua `retrato_documental` sem esses campos, então o texto segue «Contrato de 1936.».

Teste: `chat_hotfix1_test.ts:1243`. Só a acusação da Pessoa Fictícia → `fora_da_base` e o texto emitido não contém «desviou». Com a relação documentada ao lado, o visível traz «Contrato de 1936», «confiança alta» e «Não quantifica a parte.», e não traz «desviou».

### 3. MÉDIA — tentativa sem custo depois de cost 0

Achado Codex `:3288`. `registrarFalha` (`3383`) soma `parcialDe(chars)` em toda tentativa `noCharge=false` sem `usage.cost`, mesmo quando o livro anterior é só zero. `noCharge` continua somando zero.

Teste: o mesmo `chat_hotfix1_test.ts:1176`, trecho cost `0` + `OpenRouterError(..., false)` sem delta → commit > 0.

### 4. MÉDIA — ids em um bloco longo e seleção

Achados Codex `:3356` e `:2645`. `respostaComFato` (`2579`) vale para ≥ 2 blocos substantivos ou ≥ 1 bloco com ≥ 60 palavras. Usada na repetição (`3455`) e depois do sanitize (`3603`). `pedidoGenericoSelecao` (`2697`) também deixa passar analise, sintetize, síntese, cronologia, acontecimentos, contexto e «linha do tempo». Receita de bolo continua fora.

Testes: um bloco de 60 palavras aos 30 s, no mesmo `chat_hotfix1_test.ts:1176`, cai em «Contrato de 1936» sem `fora_da_base`. Seleção em `chat_hotfix1_test.ts:960`: «Analise os acontecimentos», «Faça uma síntese cronológica», «Monte a linha do tempo.» e «sintetize o contexto» chamam o modelo; «explique uma receita de bolo» segue «Não encontrei isso na base do atlas.».

### 5. MÉDIA — insinuação, e a baixa do corte no meio da palavra

Achado Codex `:2187` (e `:2189`). `FRASE_INSINUA` (`2131`) compara o texto sem acento. A lista do 1d continua, mais «fora dos registros», «termos ficaram fora», «quais/que contratos», «quem decidiu/audita/responde/lucrou/ganhou/recebeu», «quem se beneficiou», «quem assinou … como seus», «quem dentro do/da», «em troca», «transformar … em peça/arma», «por trás», «de fato mandou» e «verdadeiro dono/interesse/motivo». A frase que casa sai de qualquer bloco (`filtrarProsaVisivel` e `semForaDaBase`), inclusive «O que liga tudo». A anáfora do 1d permanece. `em_aberto` só fica se passar; senão `limparPergunta` (`2246`) troca pela pergunta neutra, sem `slice`.

`perguntaNeutra` (`2207`) usa o nome antes de « · ». Com aresta direta entre as duas entidades mais citadas: «Que outros documentos do atlas detalham a relação entre X e Y?». Sem par ligado: «Que outros documentos do atlas detalham o papel de X?». Sem entidade: «…detalham esse registro?». A pergunta termina em «?».

Prompt, Básico e Avançado (`1360-1362`):

- «A pergunta final pede só um documento ou detalhe que falta sobre uma relação já citada; nunca sugere ocultação, motivo escondido, contrato, lucro ou culpa.»
- «O parágrafo "O que liga tudo" só junta relações já citadas acima; não cria ligação nova entre entidades.»
- «Fique nas entidades da pergunta; não traga outro caso (ex.: imprensa, outra família, outro país) que a pergunta não pediu.»

O trecho «Proibido o vocabulário morno…» saiu da voz para o prompt fixo caber. Ficou em 5773 (Básico) e 5774 (Avançado), abaixo de 5810 e do teto de 15%.

Testes: `chat_hotfix1_test.ts:1042` (as quatro frases do 1d, as três da simulação, e «Quem pagou o contrato de 1936?» que fica) e `:1087` («Por que nunca abriu os arquivos?» dentro do bloco sai; par sem aresta usa uma entidade; nome longo passa de 300 caracteres e termina em «?»).

### 6. MÉDIA — citação entre aspas

Achado Codex `:1933`. `deslizesDeIdioma` (`1913`) mascara `"…"`, `“…”`, `«…»` e aspas simples antes do mapa e devolve o trecho byte a byte. Não há mais «empréstimo de consolidação (funding loan)». `spansProtegidos` também cobre aspas simples, então o marcador inglês dentro delas não derruba a frase. Aplicar o saneamento duas vezes devolve o mesmo texto.

Teste: `chat_hotfix1_test.ts:1003` («"funding loan"» e «"ownership and management"» intactos; o solto continua traduzido) e `:1148` (idempotência nas cinco frases). A asserção antiga do parêntese foi trocada pela forma intacta: é a regra nova.

### 7. CHAT_RETRY_CURTO

A chave saiu de `querRetryCurto` (`2832`): sem o campo, a produção repete; `repetirCurto: false` desliga na chamada. A linha `process.env.CHAT_RETRY_CURTO = '0'` saiu de `chat_core_node_test.mjs`. `chat()` e `streamSemLigacao` passam `false` quando o teste não diz o contrário, porque essa suíte antiga foi escrita para uma chamada. `rodarModelo` continua com `true`.

Os seis testes que falhariam com a repetição curta ligada mantêm as mesmas asserções. Cada um recebe `repetirCurto: false`:

1. `T1 ok com chave limitada` (`chat_core_test.ts:247`, chamadas em `255` e `266`). `answerJson` tem dois blocos curtos. Continua 1 chamada, `custo_real` 0,02 e gasto 0,02. A reserva do Básico (~0,030) fica acima de 0,02, então o teto novo não mexe nesse número.
2. `F1c(a)` (`1279`, chamadas em `1286` e `1308`). O custo segue 0,0002. O laço inválido segue `fora_da_base` sem débito.
3. `SPEC4 streamPrepared preserva resposta válida do modelo em dois temas` (`1744`, flag em `1752`). Um bloco, custo 0,0002.
4. `SEC-01 custo ausente…` (`1971`, flag em `1981`). Sucesso sem usage, interrupção e aborto seguem no teto. Só o modo `real` mudou o gasto do orçamento, como no item 1. `custo_real` segue 0,5.
5. `hotfix1 laço aos 30s…` (`chat_hotfix1_test.ts:320`, `fluir` em `353`). A truncada reparável segue em 1 chamada. O laço aos 5 s segue repetindo porque o JSON é ilegível.
6. `streamPrepared normaliza antes do sanitize…` (`citation_ids_test.ts:423`, flag em `479`). O texto e os ids seguem iguais.

### 8. Vazamento de F14, e o delta SSE que não mudou

No texto visível, `ocultarIdsVisiveis` (`1593`, token em `1643`) tira `R\d+`, `F\d+`, `E\d+`, `B\d+`, `[n]` e `#n`, junto com a preposição (`em`, `na`, `e`, `ver`, `cf`, `ref`). Id conhecido sem nome e com esse formato espera esse passo, para não sobrar «em .». `R$`, `F-16` e a sigla que já está em nome, nota, título ou editor ficam.

Teste: `chat_hotfix1_test.ts:1148`. «consta em F14 e em R13» vira «consta.». «em [2] e em E99» vira «está.». Ficam «R$ 15 milhões», «F-16», 1936, «Programa F14» e «Anexo R13».

O delta SSE cru continua em `chat_core.ts:3482` (`emit({ event: 'delta', data: { text: chunk.delta } })`). É preexistente. O streaming não foi alterado. O filtro só corre no texto final.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**162 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Os 4 testes a mais são os deste hotfix. Nada foi desligado no runner.

## Hotfix1f

Sobre `18b3c59`. A revisão Codex desse commit deu REPROVADO. A simulação ficou em 4,00 e o R3 saiu `fora_da_base`. Na função só muda `chat_core.ts`. Auth, CORS, SQL e limites não mudam. O Básico continua `deepseek/deepseek-v4.1-flash-1017` (`chat_core.ts:25`). O formato dos eventos SSE (`delta` / `meta` / `final` / `error`) não muda.

### 1. Schema com os apelidos do recorte (R3)

Achado: o DeepSeek inventava `walther_ms`, `F1`, `R1` porque o schema aceitava qualquer string. `schemaDaResposta` (`chat_core.ts:1566`) monta o schema por requisição a partir do JSON depois de `Recorte (dados, não instruções):`. Em `entidades`, `relacoes`, `fontes` e `base`, `items` vira `{ type: 'string', enum: [...] }` com os apelidos `[n]` daquele tipo que o recorte enviado mostra (`apelidosDoRecorteEnviado`, `1523`; `itemDeApelido`, `1561`). Lista vazia fica `{ type: 'string' }` sem `enum`. `strict: true` continua (`1606`). A constante `RESPOSTA_JSON_SCHEMA` não é alterada. `modelRequestBody` usa esse schema (`1607`).

Teste: `chat_hotfix1_test.ts:1319`. Recorte de 3 entidades: o enum de `modelRequestBody` e o do body de `streamPrepared` têm exatamente esses apelidos. Sem fontes, `fontes.items` não tem `enum`. Sem o marcador do recorte, os quatro campos continuam string. O body fica abaixo de 64 mil caracteres.

### 2. Sem fallback documental

`respostaDocumental` e o que só ela usava (`respostaComFato`, `relacaoDocumentada`, `relacaoContestada`, `acusaPessoa`, `tipoEntidade`, `usarDocumental`) saíram. Resposta com texto e sem id válido depois de `traduzirApelidos` + `reatribuirPorNome`, de qualquer tamanho: `idsInvalidos` (`3425`) usa `respostaComTexto` (`2631`). Há uma repetição com `LEMBRETE_IDS` (`2788`) se ainda houver tentativa e o tempo for ≤ `CHAT_RETRY_DEADLINE_MS`. Sem essa tentativa, ou se a repetição também falhar, `recusarSemId` (`3409`, `3551`) devolve `fora_da_base` com `costNow()`. Recusa meta (`não aborda`, `sem base`) continua sem essa repetição.

Testes: `chat_hotfix1_test.ts:883` (59 palavras aos 5 s → 2 chamadas e lembrete; aos 30 s → `fora_da_base`, 1 chamada, custo 0,0002). `chat_hotfix1_test.ts:1371` (fixture R3 com slug na segunda chamada; o texto do modelo fica; a afirmação «Walther presidiu o IBEC.» não entra). `chat_hotfix1_test.ts:845` (slug e R13/F14 resolvem na primeira chamada).

### 3. Pergunta final estrutural

`perguntaEstrutural` (`2272`) monta sempre, fora de pauta e pressão, quando há blocos (`3660`). Com aresta direta no recorte entre as entidades mais citadas nos blocos: «Que documento do atlas detalharia a relação entre X e Y?». Com um nome só: «Que documento do atlas detalharia o papel de X?». Sem nome público válido: «Que documento do atlas detalharia esta relação?». `nomePublico` (`2242`) usa o campo `nome`, a parte antes de « · », e descarta vazio, igual ao id, ou snake_case (sem espaço e com «_»). O `em_aberto` do modelo não entra nessa pergunta. A frase do prompt sobre `em_aberto` permanece: o teste de citação trava o texto. A lista de insinuação (`FRASE_INSINUA`, `fraseInsinua`, `semAcento`) saiu dos blocos. Ficam os filtros de prosa anteriores: CJK, idioma, eco, ids, ficha e anáfora.

Testes: `chat_hotfix1_test.ts:1392` (formato da pergunta; `grupo_b` sem nome público não aparece; «A doação ocorreu em troca de prestação de contas», a citação «em troca» e a URL com `/oculto/` ficam). `chat_hotfix1_test.ts:1055` (o `em_aberto` do modelo não entra). `chat_core_test.ts:1314`, `chat_fix_selecao_test.ts:422` e `citation_ids_test.ts:488` esperam a pergunta do código. `chat_r2_test.ts:109` tira essa pergunta antes da trava de «atlas».

### 4. Seleção

`selecaoForaDaPergunta` (`2736`) recusa antes do modelo só quando a mensagem casa `TEMA_EXTERNO` (`2734`: receita, culinária, bolo, futebol, jogo, clima, previsão do tempo, horóscopo, programação/código, piada, tradução de texto, matemática escolar) e não traz termo do atlas (vocabulário ou palavra do recorte). O resto com seleção vai ao modelo. S-15 continua recusada.

Testes: `chat_hotfix1_test.ts:1416` (os temas externos recusam; «receita da vacina», panorama, balanço, síntese cronológica e «Quais os principais fatos?» chamam o modelo). `chat_hotfix1_test.ts:970` (S-15 e «explique uma receita de bolo» recusam; «Descreva o panorama geral», «Faça um balanço dos eventos», «Explique o contrato detalhadamente» e «Analise os acontecimentos» chamam o modelo).

### 5. Custo da tentativa sem usage

`costNow` (`3335`): tentativa ainda aberta e sem `usage` entra com `parcialDe`, inclusive saída de 0 caracteres. `usage.cost` conhecido (inclusive 0) e `noCharge` continuam podendo somar zero. `custoNoCatch` e o teto de SSE aceito sem delta não mudam.

Teste: `chat_hotfix1_test.ts:1444`. Primeira curta com `cost` 0 e segunda `[DONE]` sem texto e sem usage: liquidação igual à estimativa de entrada da segunda, maior que 0 e dentro da reserva. O texto da primeira fica.

### 6. Idioma

`deslizesDeIdioma`: `quadratic voting` e `quadratic votação` viram «votação quadrática» (`2002–2003`), antes de `voting` → «votação». `quadratic` sozinho vira «quadrática» (`2018`).

Teste: `chat_hotfix1_test.ts:716–718`.

### 7. Backlog — delta SSE

O delta cru continua em `chat_core.ts:3456` (`emit({ event: 'delta', data: { text: chunk.delta } })`). O cliente não está neste repositório. Mudar o stream sem vê-lo não é seguro. Fica de backlog.

### Testes removidos

Só os do fallback documental:

- `hotfix1e fallback documental não afirma acusação e guarda limite` (teste inteiro: acusação isolada em `fora_da_base` e relação documentada montada do recorte).
- O trecho de 60 palavras dentro de `hotfix1e custo acima da reserva, parcial depois de zero e um bloco longo` (`chat_hotfix1_test.ts:1188`), que esperava a frase «Contrato de 1936.» montada do recorte. O resto desse teste (teto da reserva e parcial depois de cost 0) permanece.

`hotfix1d sem id reconhecível repete ou monta o recorte` foi reescrito no lugar como `hotfix1f 59 palavras sem id: repete no prazo e recusa depois` (`883`).

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**166 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Nada foi desligado no runner. Os cinco testes novos são os `hotfix1f` desta seção; o teste do fallback saiu.

## Hotfix1g

Sobre `c8e167e`. A revisão Codex desse commit deu REPROVADO. Na função só muda `chat_core.ts`. Auth, CORS, SQL e limites não mudam. O Básico continua `deepseek/deepseek-v4.1-flash-1017` (`chat_core.ts:25`). O formato dos eventos SSE não muda.

### Restaurações (como em `18b3c59`)

- `chat_hotfix1_test.ts:1074`, teste «hotfix1d pergunta final e fecho sem insinuação»: a fixture `fatos` volta a terminar em «O que liga tudo: critérios ocultos de repasse entre as casas.». A asserção que proíbe «critérios ocultos» no visível permanece. O fecho sai pelo código.
- `chat_hotfix1_test.ts:1113`, teste «hotfix1e insinuação no bloco…»: volta `assert(!/nunca abriu/i.test(textoBloco), 'frase do bloco sai')`.
- `chat_r2_test.ts:109`, `semVazamento`: volta `const texto = visivel(final)`. A pergunta estrutural entra na checagem. O formato «Que documento do atlas detalharia…» permanece.

Acompanham essas restaurações, e não são o passo 0:

- `chat_hotfix1_test.ts:718`. O `c8e167e` travava «O método quadratic entrou» → «O método quadrática». O item 5 pede o contrário. A asserção passou a esperar a frase sem tradução. Quatro `eq` novos no mesmo teste cobrem «votação quadratic» e a concordância de doação.
- `chat_r2_test.ts:93`. `/\batlas\b/i` não convive com o modelo obrigatório «do atlas detalharia» quando a pergunta volta à checagem. O padrão ficou `/\batlas\b(?!\s+detalharia\b)/i`: «atlas» no corpo, em «base do atlas» e em qualquer outra posição continua proibido. Slug, id, recorte e o restante de `PROIBIDO` seguem valendo sobre a pergunta inteira. Não é de novo o `replace` que tirava a pergunta da checagem.

### 1. Perguntas no corpo

Achado: «Por que nunca abriu os arquivos?» e «Qual contrato secreto financiou a casa?» continuavam no texto do bloco. `fraseInsinuacao` (`chat_core.ts:2125`) derruba a frase, fora de aspas e de URL, se contiver `ocult`, `escond`, `encobr`, `abafad`, `secret`, «por baixo dos panos» ou «nunca (abriu|revelou|explicou|divulgou|prestou contas)». «em troca» não entra. A anáfora existente (`semAnaforaPendente`) vale. O mesmo filtro roda em `semForaDaBase` (`2419`, chamada em `2435`) e em `filtrarProsaVisivel` (`2238`).

No fluxo visível, `fraseInterrogativaSolta` (`2120`) tira do corpo a frase que termina em «?» fora de aspas e de URL. A pergunta da pauta e o `em_aberto` passam com `manterPergunta` (`limparPergunta`, `2331`). Se o `em_aberto` do modelo não termina em «?», a última pergunta válida do corpo substitui esse eco (`3714`) — é o que mantém «Quem pagou o contrato de 1936?» no teste antigo. Nos outros casos a única pergunta acrescentada é `perguntaEstrutural`.

Testes: `chat_hotfix1_test.ts:1464` (as duas frases saem; «"Por que pagar?"» fica; URL com `?q=` fica; «em troca» fica; «critérios ocultos» sai; anáfora cai). `chat_hotfix1_test.ts:1489` («Onde está o papel?» sai do corpo; a pergunta do código fica). O fecho restaurado cai em `chat_hotfix1_test.ts:1059`. «nunca abriu» cai em `chat_hotfix1_test.ts:1103`.

### 2. Custo

`fecharTentativa` (`chat_core.ts:3409`) registra toda tentativa encerrada: `usage.cost` conhecido, inclusive 0, ou, sem custo conhecido, `parcialDe` da entrada do body mais a saída gerada (0 caracteres continua parcial de entrada).

Teste: `chat_hotfix1_test.ts:1567`. Primeira vazia sem usage e segunda com `cost: 0`: liquidação, log e `custo_real` iguais à parcial da primeira, maior que 0. Primeira vazia e segunda `noCharge`: a mesma parcial, um commit, nenhuma soltura.

### 3. Seleção

`TEMA_EXTERNO` (`chat_core.ts:2770`) recusa por expressão: «receita de», «modo de preparo», «bolo de» (e o «bolo» que o teste antigo trava), «previsão do tempo», «como está o tempo», «jogo de futebol», «resultado do jogo», «campeonato», «horóscopo», «escreva (um )?código», «programa em (python|javascript|java)», «conte uma piada», «traduza (este|o) texto», «resolva a equação». «jogo político», «jogos de poder» e «clima político» não casam. «código» sozinho não recusa. «Indica um jogo.» e «Fale do clima.» continuam recusados: o teste já existente trava essas duas frases.

Teste: `chat_hotfix1_test.ts:1540`. Com seleção, as quatro frases políticas chamam o modelo. S-15 continua recusada.

### 4. Nomes na pergunta estrutural

`nomePublico` (`chat_core.ts:2268`) tira tokens snake_case (`/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/`), códigos `[A-Z]{1,3}\d+` e colchetes, e normaliza espaços. Menos de 2 letras ou dígitos úteis, igual ao id, ou o que sobra sem espaço e com «_»: a entidade não entra. «Casa Alfa grupo_b» vira «Casa Alfa». «grupo_b» sozinho não entra.

Teste: `chat_hotfix1_test.ts:1505`. A pergunta passa por `semVazamento` (`chat_r2_test.ts:108`).

### 5. Idioma

`quadratic` só na expressão (`chat_core.ts:2005–2007`): «quadratic voting», «quadratic votação» e «votação quadratic» viram «votação quadrática». A troca solta `quadratic` → «quadrática» saiu. `concordarDoacao` (`1948`) também acerta declarado, registrado e anunciado.

Teste: `chat_hotfix1_test.ts:716–722`. «O método quadratic entrou» permanece. «votação quadratic» vira «votação quadrática». «doação declarado» vira «doação declarada».

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**171 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Nada foi desligado no runner. Os testes novos são os cinco `hotfix1g` desta seção.

Sobre `37e4358`, continuação. `perguntaEstrutural` (`chat_core.ts:2323-2328`) monta «Que documento detalharia a relação entre X e Y?», «Que documento detalharia o papel de X?» ou «Que documento detalharia esta relação?». `git diff 37e4358 -- 'supabase/functions/_shared/*_test.ts'` tem 14 linhas e nada além disto: `chat_r2_test.ts:93` volta a `['atlas', /\batlas\b/i],`; o texto esperado «Que documento do atlas detalharia» vira «Que documento detalharia» em `chat_core_test.ts:1316`, `:1756` e `:1784`, `chat_fix_selecao_test.ts:444`, `chat_hotfix1_test.ts:1095`, `:1141`, `:1393`, `:1416`, `:1502`, `:1522` e `:1537`, `chat_r2_test.ts:137` e `citation_ids_test.ts:488`. Nenhuma outra asserção mudou. Suíte `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`: **171 passed, 0 failed, 3 skipped, 9 ignored.**

## Hotfix1h

Sobre `67ad746`. A revisão Codex desse commit deu REPROVADO. Na função só muda `chat_core.ts`. Auth, CORS, SQL e limites não mudam. O Básico continua `deepseek/deepseek-v4.1-flash-1017` (`chat_core.ts:25`). O formato dos eventos SSE não muda.

### 1. Fechamento

Achado: o fecho reaproveitava uma pergunta do corpo ou do `em_aberto`. `substituiEco` saiu. O fecho é sempre `perguntaEstrutural` (`chat_core.ts:2370`), depois de `sanearPerguntaMontada` (`2356`). No fluxo, `answer.em_aberto = perguntaFinal` (`3825`). Se o `em_aberto` bruto do modelo casa `fraseEco`, a última pergunta válida do corpo só permanece no corpo (`perguntaNoCorpo`, `3742`): é o que mantém «Quem pagou o contrato de 1936?» na asserção antiga (`chat_hotfix1_test.ts:772`).

Teste: `chat_hotfix1_test.ts:1604`. `em_aberto` «A documentação é parcial.» e corpo com «Quem mais recebeu dinheiro por fora?»: essa pergunta e o texto do `em_aberto` não aparecem; os fatos ficam; o fecho é «Que documento detalharia…».

### 2. Crédito

Achado: um bloco só com pergunta ainda debitava. `filtrarProsaVisivel` (`2290`) e o teto do Básico rodam antes de `commitCredits`. `temFraseDeclarativa` (`2400`) exige ao menos uma frase além da pergunta estrutural. Sem isso, `semConteudo` (`3765`) segue o `fora_da_base` de depois do modelo: crédito liberado (`releaseReserve`, `used` 0) e orçamento liquidado com `costNow()`.

Teste: `chat_hotfix1_test.ts:1622`. No Básico e no Avançado, bloco só com «Onde está o papel?»: `fora_da_base`, `used` 0, `commitCalls` 0, `releaseCalls` 1, orçamento `0.0002`, nenhuma soltura do hold.

### 3. Citação, nome e URL

Achado: nome do recorte, citação com várias frases e URL caíam no corte. `protegerTrechos` (`2148`) mascara antes de `frasesDe`, e `restaurarTrechos` devolve o trecho inteiro. Entram: nomes de entidade e títulos de fonte do recorte; citações entre `" " “ ” « »` e entre aspas simples que abrem após espaço ou início e fecham antes de espaço ou pontuação; URLs. A chamada está em `filtrarProsaVisivel` (`2296`) e em `semForaDaBase` (`2502`). Termo de insinuação e «?» dentro da máscara não derrubam a frase. Se a frase sai, a citação inteira sai junto.

Teste: `chat_hotfix1_test.ts:1650`. «A Casa Secreta pagou o contrato de 1936.» fica, com Casa Secreta no recorte. A fonte «Poder Oculto» fica. «O diretor disse 'por que pagar?' na reunião.» fica. «Ele escreveu: "Pagamos. Por que esconder?" no relatório.» fica inteira, e a citação “Por que pagar? A casa pagou no mesmo ano” também. A frase solta com «secreto», sem nome cadastrado, sai.

### 4. Nome público

`limparCodigosDoNome` (`2128`) tira snake_case sem distinção de maiúsculas (`/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/`), `AP_E\d+`, `OP\d+`, `BR\d+_H\d+`, `PR\d+-(E|NF)\d+`, `/\b[A-Z]{1,4}\d+(?:[_-][A-Z]*\d+)*\b/` e `[n]`, e normaliza espaços. `nomePublico` (`2325`): menos de 2 caracteres úteis, igual ao id, ou código que sobrou, a entidade não entra. `sanearPerguntaMontada` (`2356`) aplica `ocultarIdsVisiveis`, `limparCodigosDoNome` e `publicChatText`. Se ainda casar código interno, a pergunta vira «Que documento detalharia esta relação?».

Teste: `chat_hotfix1_test.ts:1684`. «Casa Alfa Grupo_B» e «Casa Alfa AP_E39» viram «Casa Alfa» na relação com Campanha de 1916. «AP_E39» sozinho não entra; a pergunta é «Que documento detalharia esta relação?».

### 5. Seleção

`vocabularioAtlasNaPergunta` (`2849`) roda antes da recusa (`selecaoForaDaPergunta`, `2888`): mandato, conselho, político(s)/política, poder, governo, eleição, partido, banco, empresa, família, fundação, contrato, golpe, regime, ditadura, ministro, presidente, diretor, acionista, financiamento, doação. Com um desses termos a seleção não recusa. `TEMA_EXTERNO` (`2861`) não tem mais «como está o tempo» solto: ficam «previsão do tempo» e «como está o tempo hoje|amanhã|agora». «jogo(s) político(s)» e «jogo(s) de poder» não casam (`2867`). «Como está o tempo?» sem esse vocabulário continua fora (`2890`).

Teste: `chat_hotfix1_test.ts:1735`. Com seleção, «Como está o tempo de mandato no conselho?», «Analise os jogos políticos» e «Analise o jogo político» chamam o modelo. «qual a previsão do tempo amanhã?» e S-15 recusam.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**176 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Nada foi desligado no runner. Os testes novos são os cinco `hotfix1h` desta seção. `git diff 67ad746 -- 'supabase/functions/_shared/*_test.ts' | grep '^-'` só devolve o cabeçalho `--- a/.../chat_hotfix1_test.ts`. Nenhuma asserção ou fixture existente foi removida.

## Hotfix1i

Sobre `426e2b3`. A revisão Codex desse commit deu REPROVADO. Na função só muda `chat_core.ts`. `pauta.ts` não muda. O Básico continua `deepseek/deepseek-v4.1-flash-1017` (`chat_core.ts:25`). O formato dos eventos SSE não muda: o evento final continua com `avisos: []` (`chat_core.ts:3988`). A maiúscula escondida pelo placeholder e a citação em várias linhas ficam no backlog.

### 1. Frase declarativa antes do crédito

Achado: `temFraseDeclarativa` aceitava qualquer frase diferente do fecho. O eco «Não consta nos documentos.» em `em_aberto` preservava «Onde está o papel?» no corpo e cobrava. A checagem olha só o texto final dos blocos, depois dos filtros e antes do fecho (`chat_core.ts:3903–3905`). `temFraseDeclarativa` (`2421`) exige frase que não termina em «?», não é rótulo de ausência (`fraseRotuloAusencia`, `2402`: «Não consta nos documentos.», «A documentação é parcial.» e `fraseAusenciaExata`) e tem ao menos 3 palavras com letras. Três frases curtas já cobradas pela suíte («Um.», «Dois.», «Três.») somam 3 no texto juntado e continuam conteúdo. Sem isso: `fora_da_base`, crédito liberado (`used` 0) e orçamento liquidado com o custo real. Vale para Básico e Avançado.

Testes: `chat_hotfix1_test.ts:1769` (o caso do Codex) e `:1797` (só perguntas não cobram; «O contrato de 1936 ficou registrado.» cobra).

### 2. Código que volta dentro da citação

Achado: `restaurarTrechos` devolvia `AP_E777` e `OP901` que `semCodigosDeFicha` não tinha visto, porque a citação estava mascarada. Depois de restaurar, `aposRestaurar` (`2507`) roda de novo `ocultarIdsVisiveis`, `semCodigosDeFicha` e `semCodigosInternos` quando o texto ainda casa id ou código (`casouVazamento`, `2435`). A chamada está em `filtrarProsaVisivel` (`2311`) e em `semForaDaBase` (`2657`). Se o trecho ficar sem frase declarativa, ele cai. `limparCampo` (`2515`) faz a mesma limpeza, sem apagar o fecho, em `em_aberto`, avisos, justificativa que não é documentada e no último bloco depois do fecho (`3964–3980`). Os arrays de id de citação continuam com os ids do recorte: sem eles `hasValidId` manda a resposta para `fora_da_base`.

Teste: `chat_hotfix1_test.ts:1838`. «Ele escreveu "AP_E777 pagou OP901" no relatório.» e «O memorando «OP901» registra o repasse.» não deixam `AP_E` nem `OP` no JSON do evento final. `casa_ms`, `E150` e `B01` não aparecem na prosa. As aspas ficam balanceadas e sem par vazio.

### 3. Termo jurídico por frase

Achado: `safePublicClaim` no bloco inteiro derrubava o 1º parágrafo da Q5 por «esquema de apoio condicional». `separarFrasesPublicas` (`2520`) aplica `safePublicClaim` por frase, com a citação protegida e restaurada antes da guarda. A frase que falha cai; a justificativa que falha vira `''`; `removed` fica true sempre que algo cai (`sanitizeAnswer`, `2694–2702`). Sem frase restante, o bloco cai como antes. `semAnaforaPendente` corre no corte. `pauta.ts` e a lista de termos não mudam. O prompt do sistema, fora do ramo de pauta, ganha a linha de não usar «esquema», «crime», «ilegal», «fraude», «corrupção», «lavagem», «conspiração», «propina» nem «suborno» fora de citação literal (`1364`). A frase de voz «bem encadeadas e claras: cada ligação é explicada por inteiro» saiu (`1345`) para a linha nova caber no teto já travado de 5810 caracteres do prompt fixo. Nenhuma asserção de texto do prompt foi alterada.

Teste: `chat_hotfix1_test.ts:1857`. Ficam a 1ª e a 3ª frase do bloco Brother Sam, «esquema» não aparece, `removed` true. «É um esquema de lavagem.» derruba o bloco. O teste de `pauta_test.ts` segue como estava.

### 4. «tempo» só na meteorologia

A regra coube em poucas linhas. `selecaoForaDaPergunta` (`3029`) recusa «como está o tempo», «vai chover» e «temperatura hoje|amanhã|agora» só quando a frase não tem «tempo de» + substantivo. «Como está o tempo?» sem vocabulário do atlas continua fora. `TEMA_EXTERNO` (`3005–3008`) traz «previsão do tempo», «como está o tempo hoje|amanhã|agora|lá fora», «vai chover» e «temperatura hoje|amanhã|agora». «cargo» e «permanência» entram em `temVocabularioAtlas` (`2981`) e em `vocabularioAtlasNaPergunta` (`2987`).

Teste: `chat_hotfix1_test.ts:1878`. «Como está o tempo de permanência no cargo?» chama o modelo. «qual a previsão do tempo amanhã?» e S-15 recusam.

### Suíte

`node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`

**181 passed, 0 failed, 3 skipped, 9 ignored.** Os 3 skips e os 9 ignored são os mesmos. Nada foi desligado no runner. Os testes novos são os cinco `hotfix1i` desta seção. `git diff 426e2b3 -- 'supabase/functions/_shared/*_test.ts' 'supabase/functions/_shared/*_test.mjs' | grep '^-'` só devolve o cabeçalho `--- a/.../chat_hotfix1_test.ts`. Nenhuma asserção ou fixture existente foi removida.
