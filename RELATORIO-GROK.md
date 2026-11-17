# RELATORIO-GROK — chat-fix-selecao

Base: `d411613` (“v12 307a1605”). Sem deploy, sem push, sem rede, sem mudança de custo, cota, rate limit, auth, CORS, SQL ou segredos.

O bug de produção era a seleção do mural (`sfa`, `minas1941`) zerar o texto da pergunta. “qual a ligação de Soros e Lula?” caía no recorte de febre amarela e o fallback montava Fatos dessas raízes.

## A — Recuperação pelo texto

`prepareChat` chama `recuperarContexto(db, mensagem, entityIds, pauta)`. A query é sempre `pautaSearchQuery` ou `normalizeQuery`, mesmo com seleção. O retry por `cleanContextQuery` (vazio e mais de 3 palavras) permanece. `expandPautaContext` e `onlyGenericRootMatch` continuam no contexto final, como antes.

Ordem:

1. `chatContext([], query)` e, se couber, a consulta limpa.
2. “Fundação X”: se a query casa `\bfundacao (?:d[aeo]s? )?([a-z][a-z-]{2,})`, busca de novo com esse trecho trocado por “X foundation”. Só substitui se alguma raiz tem `tipo === 'fundacao'` e o nome contém X. Fundação Getulio Vargas, sem esse nó, fica no recorte original.
3. Até 3 nomes próprios da mensagem original, não cobertos pelo recorte textual, vão para `chatContext([], N)`. Resposta vazia entra em `ausentes` com a grafia original (“Lula”). Acerto novo (o nome da raiz contém N como palavras inteiras) entra no corte: raízes textuais nomeadas, na ordem, mais os acertos, sem repetir, no máximo 3. Se o conjunto muda, `chatContext(ids, null)` e `origem = 'nomes'`.
4. Com `entityIds`, busca também a seleção. Se o texto tem alguma raiz fora dela, o texto vence (`texto` ou `nomes`). Se o texto está vazio, é genérico ou todas as raízes já estão na seleção, a origem volta a ser `selecao`.
5. Teto de chamadas `chatContext` dentro de `recuperarContexto`: 8 desde a rodada 2 (era 6). Erro de banco segue `fail('rede')`. `prepared` ganha `origem` e `ausentes`. O `meta` não mudou de formato.

Nome coberto: segmento do nome da raiz (corte em `·`, `(`, `)`, ` - `, sem artigo inicial e sem sufixo S.A./Ltda.) igual a N; ou N com 2+ palavras contido no nome. Ano de 4 dígitos da pergunta também segura a raiz (golpe64 com 1964). “e” separa nomes; “&” e de/da/do/dos/das juntam. Cabeças Operação/Família/Casa/Caso/Jornal/O/A saem do início. Brasil, EUA, Império, Governo e Século sozinhos são ignorados, assim como romanos (XIX).

Na fixture real, com a seleção de febre amarela, a pergunta Soros/Lula devolve a raiz `soros`, `ausentes: ["Lula"]` e origem diferente de `selecao`. Sintéticos: casa Rothschild → raiz `rothschild` (AP_E44/AP_E47); Operação Brother Sam + 1964 → `golpe64` + `caso_op13`; Lemann/3G/BTG/Americanas mantém `jorge_paulo_lehmann`, `capital_3g`, `americanas_br`.

## B — Fallback só sem seleção e com pergunta de ligação

`fallbackSemLigacao` só roda se `origem !== 'selecao'`, `entityIds` está vazio e `perguntaDeLigacao` é verdadeira. Nos outros `sem_base` / blocos vazios / sem id válido: evento `error` `fora_da_base`, mesmo código, HTTP e cobrança de antes (não debita). Mensagem: “X não está na base do atlas.” (ou “X e Y não estão…”) se há ausentes; senão “Não encontrei na base do atlas o que a pergunta pede.” A rejeição antecipada de `prepareChat` (recorte vazio ou genérico, antes do modelo) continua com “Não encontrei isso na base do atlas.”

## C — “em relação a” não é pergunta de ligação

`perguntaDeLigacao` tira `em relacao a|ao|aos|as` da query normalizada antes do regex. “Qual a relação entre X e Y”, “qual a ligação de Soros e Lula”, vínculo e parentesco continuam verdadeiros. “em relação à ancilostomíase” e “em relação ao golpe” são falsos.

## D — Prompt e saneamento

1. `boundContextJson` não muda (testes de encolhimento seguem vendo ids reais). `buildSystemPrompt` e o mapa de `prepareChat` usam `apelidarRecorte`: cada id de entidade, relação e fonte vira `[n]`, inclusive origem, destino, fontes, `ligacoes_entre_raizes` e lacunas. O mapa fica em `prepared.apelidos` e não vai ao `meta`, ao log nem ao cliente. Antes de `normalizeCitations`, `traduzirApelidos` aceita `[n]`, `n`, `#n` e o id real. Apelido no campo errado segue a pertença do recorte. Apelido inexistente é removido com aviso `citacao_removida`.
2. `reatribuirPorNome`, antes do saneamento, guarda o id inválido (para o aviso) e, se o texto cita duas entidades com relação no recorte, acrescenta essa relação e as fontes citáveis. Com uma só, cita a entidade e a primeira relação dela que tem fonte. Sem casar, continua `sem_id_valido`.
3. Ausentes no system prompt, no máximo uma linha, nomes só com letras, dígitos, espaço, `&` e `-`, 60 caracteres, até 3. No final com sucesso, se nenhum bloco diz “não está na base”, entra um bloco documentado com ids vazios.
4. `ocultarIdsVisiveis` roda em texto, justificativa, `em_aberto` e avisos do modelo, antes de `publicChatText`. Só id que parece código (tem `_`, dígito ou `-`, ou é todo maiúsculo com ≥2 letras) é trocado, numa passada só: entidade vira o nome antes de `·`; relação e fonte somem. Palavra só de minúsculas fica. `[n]` de 1 a 3 dígitos some. Anos comuns ficam. Avisos do sistema (`Relação ${id} está como…`) e o texto da pauta montado depois não passam por essa limpeza.
5. `em_aberto` fecha o último bloco com `\n\n`, também na pauta. Pauta e pressão recebem o JSON já passado por `traduzirApelidos`, para `buildPautaAnswer` ver o id real no lugar de `[n]`. `pauta.ts` não mudou.
6. Duas linhas novas sempre: `Cite só "[n]".` e `Não ponha ids no texto.` A de ausentes só quando há nomes. As linhas de segurança e a de id puro (`walther_ms`, `E219`, `PR1-NF22`) permanecem. O saneamento aceita os dois formatos.

## Funções novas exportadas

`recuperarContexto`, `nomesProprios`, `apelidarRecorte`, `traduzirApelidos`, `reatribuirPorNome`, `sanearModelo`, `ocultarIdsVisiveis`, `sanitizarAusentes`, `fraseAusentes`, `mensagemForaDaBase`.

## Testes

Runner: `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs` (Node 25). Deno não está nesta máquina; os arquivos continuam com import `.ts` e sem API de Node.

A suíte no commit base não foi reexecutada. O arquivo novo tem 18 testes (os 12 pedidos, Rothschild/Brother Sam/Lemann, o tamanho do prompt, três da revisão de ids crus, e a pauta que cita a relação por `[n]`). Total registrado: 125. Resultado desta revisão: **122 passed, 0 failed, 3 skipped**. Os 3 skips são os de sempre (`Deno.serve` / HTTP): limite 402/403, rate limit com `Deno.serve`, e `functions serve` local.

Ajustes em testes antigos, porque o comportamento pedido mudou:

- F1c(b): `em_aberto` esperado com `\n\n`.
- A2: com seleção a query deixa de ser `null`; a busca textual pode passar de uma chamada; pergunta curta não é limpa; o teto assertado é 6.
- `streamSemLigacao`, CRED1 e REL1 passam `entidades: []`. Com a seleção padrão `maua`, o fallback de ligação ficaria desligado e esses testes deixariam de exercê-lo.
- Citação: `texto intacto id:golpe64` vira `texto intacto id:Golpe de 1964` porque `golpe64` tem dígito. O campo de citação inventado continua removido. `normalizeCitations` não mexe na prosa.
- SPEC4 voltou ao texto da v12: “do arquivo” permanece, porque `arquivo` é só letras minúsculas.
- Teto de 15% do prompt fixo: o piso v12 já era 1373/1341 (teto antigo 1383/1374). As duas linhas novas levam o fixo a 1412/1380. A base do teste passou a ser esse tamanho medido.

## Tamanho do system prompt (básico)

Medido por `1373 + boundContextJson` (fixo v12, sem as linhas novas) contra `buildSystemPrompt` atual. O JSON apelidado continua ≤ 8000.

| Recorte | Antes | Depois | JSON | JSON apelidado |
| --- | ---: | ---: | ---: | ---: |
| Sintético (walther_ms, soros, george_soros, AP_E39, SOE01, SO05) | 2102 | 2086 | 729 | 674 |
| Fixture `\|soros` | 7822 | 7742 | 6449 | 6330 |

O fixo cresce 39 caracteres (1373→1412 no básico, 1341→1380 no avançado). O prompt com recorte encolhe: o apelido economiza mais do que as duas linhas.

## Riscos

- O prompt pede id puro e, ao mesmo tempo, `[n]`. Os dois são aceitos de propósito, para não apagar as instruções que os testes travam. O modelo pode citar qualquer um dos dois.
- No texto visível, só sai o id que parece código: tem `_`, dígito ou `-`, ou é todo maiúsculo com pelo menos duas letras (`AP_E39`, `golpe64`, `BP02`, `IPES`). Palavra só de letras minúsculas (`soros`, `arquivo`, `marinho`, `rockefeller`, `rf`, `nm`) fica. A troca é uma passada, então um nome que contém outro id não é reprocessado. Um id minúsculo vazado no texto continua visível.
- Nomes além de 3 buscas, ou além do teto de 8 chamadas, não entram em `ausentes`. Não dá para avisar “não está na base” de um nome que não foi consultado.
- `expandPautaContext` continua fora desse teto.
- Apelidar um recorte cheio de ids muito curtos pode alongar o JSON (`rf` → `[1]`). No sintético e em Soros ele encolheu. Se passar de 8000, o encurtamento de texto posterior ainda roda.
- Reatribuição de pessoa sem fonte citável continua descartando o bloco.
- A regex de fundação captura uma palavra: “Fundação Getulio Vargas” consulta “getulio foundation vargas”, não “getulio vargas foundation”.

## Rodada 2 — relevância antes do corte

HEAD de partida: `831ecb7`. A média ao vivo era 3,31. O corte não mudou: `shrinkContextLists` e o teto de 8000 continuam iguais. O que mudou é a ordem em que o recorte chega nesse corte.

### Causa

`boundContextJson` fica com as primeiras relações, entidades e fontes. O SQL devolve até 60 relações sem olhar a pergunta, então o degrau que cabe (cerca de 8–10 relações, 5–8 entidades, 3–5 fontes) era o começo dessa lista.

- Q10, raiz `rothschild`: AP_E44, AP_E47 e AP_E48 estão nas posições 50–52. O prompt ficava com o banco otomano (ORI01).
- Q12, raiz `rf`: PR3-E018..E030 (doações) estão por volta de 31–43. O modelo dizia que a base não documenta doações.
- Q4 com `[ipes, ibec, ibad]` não traz PR4-E015 (ibec→ibad) dentro das 60. A chamada `["ibec","ibad"]` traz. Com ids explícitos, `ligacoes_entre_raizes` vem vazio.
- Q3 tem a entidade `bib` = “Banco de Investimento do Brasil · BIB”. O modelo escreveu “Banco Industrial e Bancário”.
- Soros/Lula: a raiz `soros` só tem SOE01..SOE46 biográficas. SOE30..SOE33 (Open Society e o Brasil) vêm de `chatContext([], "open society foundations brasil")`.
- O texto visível saía com “(relação )”, “relações, ,”, “Relação  indica” e apelidos “(1-5)”, “(R18)”, “(R9)”.

### Mudanças

`ordenarRecortePorPergunta` roda no contexto final de `prepareChat`, antes de `apelidarRecorte` e `buildSystemPrompt`, também na pauta. Não apaga nada. Empate mantém a ordem de chegada. Pontuação pedida: +10 se origem e destino estão em `nomeados`; +4 por ponta nomeada; +2 por termo da pergunta (token de busca e radical: “oes/aes/aos” vira “ao”, “s” final cai; radicais iguais ou o menor é prefixo do maior com pelo menos 6 letras); +2 para século XIX→ano 18xx, século XX→19xx, “recente(s)”→ano ≥ 2015. Entidades: raízes, pontas das relações já ordenadas, o resto. Fontes: as das relações ordenadas, depois o resto.

Sinais a mais, porque pontuação igual deixa o começo do SQL e o degrau de 10 relações ou estoura 8000 ou corta o alvo:

- +2 se o termo de Brasil só casa no cluster (a nota conta como texto, para SOE07/SOE34/SOE47 não passarem na frente de SOE32). +6 se a relação menciona Brasil. +4 se o século XIX pedido é também o do Brasil. Com ausentes, a mensagem de ordenação ganha “brasil”, para Soros/Lula receber esse bônus.
- +4 se a pergunta diz “recente” e o estado é `retrato_documental`. Em Q12 isso coloca o retrato curto PR3-E018 como 9ª relação fora das obrigatórias, no lugar da PR16 longa, e o degrau de 10 relações cabe com PR3-E025..E030.
- +4 se a afirmação cita o nome composto de uma entidade nomeada que não é ponta (E017, “Rothschild & Co”).
- Pergunta de participações do IBEC em empresas brasileiras: +24 na relação de até 320 caracteres que tem `bib` numa ponta (E186, grupo_gerdau→bib, 295) e +20 nas de até 280. PR2-E008 tem o mesmo banco e 727 caracteres, com cinco fontes longas; no topo ela estoura o degrau de 8 entidades e o nome do BIB some. A ordem que cabe, medida na fixture, é E186, PR2-E013, PR2-E016, PR3-E056, E152, E154: 7968 caracteres, 10 relações, com “Banco de Investimento do Brasil”.

Nomes na recuperação, teto agora 8:

- Raízes finais: nomeadas por nome, na ordem do texto, depois acertos de busca, por último as que só entram por ano. Q4 busca `ipes,ibec,ibad` (golpe64 fica por último e sai do corte de 3). A chave `ibec,ipes,ibad` não existe na fixture.
- Até 3 pares de nomeados sem aresta direta: `chatContext([a, b], null)` e entram só as relações cujas duas pontas são exatamente esse par, com as entidades e as fontes. Q4 ganha PR4-E015 (ibec→ibad). PR4-E014 está em `ibec,ibad` como ibec→ipes, então o par estrito não a copia; o teste pede PR4-E015.
- Ausentes com raiz no recorte: `chatContext([], "${nome curto} brasil")` para a primeira raiz e para até uma vizinha. A vizinha prefere conjunto, fundação e instituição antes de empresa, senão a vaga ia para a Soros Fund Management (`sfm`) e a chave não existe. A vizinha que serve é a Open Society Foundations. Entram relações que mencionam Brasil nas pontas, na afirmação ou no período, na frente. `rankBrasil` sobe R$ (não US$), “brasil” na afirmação e o nome da ponta que casa um termo da pergunta (SOE33, Alex Soros).
- Prompt: a linha de inferência agora pede o nome exatamente como no recorte, sem expandir nem traduzir sigla. Com ausentes, a linha pede para dizer que o nome não está na base e resumir o que a base tem sobre o outro nome no Brasil. `Cite só "[n]".` e `Não ponha ids no texto.` continuam.

`ocultarIdsVisiveis`, depois da troca de id que parece código: some `[n]`, `[n-m]`, `[n, m]`, `#n` e `R` seguido de 1 a 3 dígitos (`R$` fica). Parêntese ou colchete que, depois disso, só tem espaço, vírgula, ponto-e-vírgula, traço, dígito ou as palavras relação/fonte/id/ref/cf/ver/e sai inteiro, com o espaço de antes. Vírgulas repetidas, espaço antes de pontuação e espaço duplo são normalizados. Ano e valor não entram nessa limpeza.

### Testes

`chat_fix_selecao_r2_test.ts` usa `ctx_r2.json`. FakeDb de chave desconhecida devolve recorte vazio. Runner: o mesmo `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`. Resultado: **132 passed, 0 failed, 3 skipped**. Os skips continuam os de `Deno.serve`.

O arquivo novo cobre Q10 (AP_E44, AP_E47, AP_E48), Q12 (PR3-E025..E030), Q9 (E001, PR13-E006, E017), Q4 (raiz `ibad` e PR4-E015), Q3 (nome do BIB e a linha de nomes exatos), Soros/Lula com e sem `[sfa, minas1941]` (SOE30..SOE33 e ausentes `["Lula"]`), o saneamento (inclusive `R$ 359.971 em 2021`), a ordenação isolada e o teto de 8.

Ajustes em testes já existentes: o teto assertado passou de 6 para 8 (`chat_core_test.ts` e `chat_fix_selecao_test.ts`). Brother Sam agora também reconhece a chave `caso_op13,golpe64`, porque o ano vai por último na montagem das raízes; o payload segue `golpe64,caso_op13`. Lemann rejeita só o refetch de 3 ids que inclui `btg_pactual`; um par de 2 ids pode contê-lo.

### Tamanho do system prompt

Antes = 1412 (fixo do `831ecb7`) + JSON apelidado do recorte da fixture na ordem do SQL, já passado por `boundContextJson`. Depois = `buildSystemPrompt` de `prepareChat` com a fixture. O “antes” de Q4 é a chave antiga `golpe64,ipes,ibec`; o de Soros é `soros|`, sem a busca de Brasil.

| Pergunta | Antes | Depois | Delta |
| --- | ---: | ---: | ---: |
| Q10 Rothschild, século XIX | 7208 | 8158 | +950 |
| Q12 doações Rockefeller | 8121 | 9094 | +973 |
| Q4 IBEC, IPES, IBAD | 8582 | 9105 | +523 |
| Q3 IBEC e empresas | 7627 | 8914 | +1287 |
| Q9 RIT e Rothschild & Co | 9101 | 7069 | −2032 |
| Soros/Lula | 7742 | 7841 | +99 |

O JSON do recorte continua ≤ 8000. O prompt inteiro passa disso porque soma as instruções. Q9 encolhe: a ordenação troca o começo longo do SQL por E001, PR13-E006 e E017. Q3 e Q12 crescem porque o degrau de 10 relações agora cabe e traz o BIB e as doações.

### Riscos da rodada 2

- A ordenação não aumenta o teto. Relação longa com a mesma pontuação ainda cai no degrau seguinte.
- Os bônus de cluster, Brasil, século, retrato e o corte curto do IBEC existem para o degrau de 8000. Um recorte com outros tamanhos pode ordenar diferente.
- A chave de refetch segue nome no texto, depois acerto, depois ano: `ipes,ibec,ibad`, não a ordem da pergunta `ibec,ipes,ibad`.
- O par estrito não copia PR4-E014 de `ibec,ibad`, porque essa aresta é ibec→ipes.
- A vizinha institucional pula a primeira empresa. Em Soros, isso evita a Soros Fund Management e usa a Open Society Foundations.
- “soros brasil” não está na fixture; a busca útil é “open society foundations brasil”.
- A linha de nomes exatos foi fundida na de inferência para o teste de tamanho do prompt sintético continuar passando (2099 ≤ 2102).
