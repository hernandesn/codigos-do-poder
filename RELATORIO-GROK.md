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
5. Teto de 6 chamadas `chatContext` dentro de `recuperarContexto`. Erro de banco segue `fail('rede')`. `prepared` ganha `origem` e `ausentes`. O `meta` não mudou de formato.

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
- Nomes além de 3 buscas, ou além do teto de 6 chamadas, não entram em `ausentes`. Não dá para avisar “não está na base” de um nome que não foi consultado.
- `expandPautaContext` continua fora desse teto.
- Apelidar um recorte cheio de ids muito curtos pode alongar o JSON (`rf` → `[1]`). No sintético e em Soros ele encolheu. Se passar de 8000, o encurtamento de texto posterior ainda roda.
- Reatribuição de pessoa sem fonte citável continua descartando o bloco.
- A regex de fundação captura uma palavra: “Fundação Getulio Vargas” consulta “getulio foundation vargas”, não “getulio vargas foundation”.
