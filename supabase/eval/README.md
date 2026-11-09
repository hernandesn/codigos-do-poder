# Harness de avaliação do chat (Fase 0)

Mede, pergunta a pergunta, o mesmo caminho de produção do chat: `handleChatRequest` → `prepareChat` → `streamPrepared` → `sanitizeAnswer`. O banco de produção não é chamado.

O recorte entra por monkeypatch de `MemoryChatDb.prototype.chatContext`, refeito depois de `resetMemoryForTests` a cada pergunta. Com `--sync-sql` (ou `ATLAS_SYNC_SQL`), o método delega a `public.chat_context(ids, query, 60, 40)` num PGlite em memória. Sem sync, cada pergunta pode trazer `contexto_fixture` (JSON no formato do payload de `chat_context`). Sem sync e sem fixture, a pergunta fica `recorte_indisponivel` e não chama o handler. Se o sync estiver carregado, a fixture é ignorada (`fixture_ignorada`).

## Instalar

```bash
cd supabase/eval && npm i
```

A única dependência de dev é `@electric-sql/pglite`. Deno não é necessário. O Node precisa aceitar `node --experimental-strip-types`.

## Rodar

Mock, sem chave e sem rede externa. O mock sobe em `127.0.0.1` numa porta livre. Se a pergunta não tiver `mock_resposta`, a resposta cita a primeira relação do recorte que foi para o prompt (já limitado a 8000 caracteres). Recorte vazio ou expectativa `fora_da_base` viram `sem_base`. Expectativa `sem_ligacao` com duas ou mais raízes e sem caminho devolve `sem_base` para o fallback do núcleo agir; nos outros casos o mock escreve o bloco de lacuna «O atlas não documenta ligação direta entre ...». O caminho padrão não cita id fora do recorte.

`--mock-perfil limpo` é o padrão. `--mock-perfil ruim` acrescenta, em cada resposta sintética, uma citação de id inexistente e um bloco `documentado` sem fonte. `mock_resposta` explícito não recebe essa injeção. `--juiz` é aceito e gravado como desativado: não chama modelo.

```bash
node --experimental-strip-types supabase/eval/harness.mjs \
  --golden supabase/eval/golden/seed_v0.1.jsonl \
  --modo mock \
  --sync-sql /caminho/para/006_sync_atlas_dataset.sql \
  --ids-base /caminho/para/ids_banco_chat.json \
  --out supabase/eval/out
```

OpenRouter só roda se `OPENROUTER_API_KEY` existir no ambiente. O valor não é impresso. Sem a chave o processo sai com código 3 e a mensagem `falta OPENROUTER_API_KEY no ambiente`. O banco continua local.

```bash
node --experimental-strip-types supabase/eval/harness.mjs \
  --golden supabase/eval/golden/seed_v0.1.jsonl \
  --modo openrouter \
  --sync-sql /caminho/para/006_sync_atlas_dataset.sql
```

Outras flags: `--modelo basico|avancado` (padrão `basico`), `--repeticoes N`, `--cambio-brl` (padrão 5.40, gravado como `cambio_brl_usado`), `--preco-entrada-usd-por-mtok` e `--preco-saida-usd-por-mtok`, `--ids-base`, `--mock-perfil limpo|ruim`, `--juiz`. O preço padrão de saída vem de `CHAT_OUTPUT_USD_PER_TOKEN` do núcleo, convertido para US$ por milhão de tokens. O preço padrão de entrada é 0: o núcleo não publica preço de entrada. `CHAT_COST_ESTIMATE_USD` é a reserva do pedido, não o preço de entrada. O agregado traz tokens, US$ calculado, R$ pelo `cambio_brl_usado` e `custo_real_usd`, a soma do `usage.cost` / `custo_real` quando o servidor informa.

Os arquivos `resultados_<timestamp>.json` e `resumo_<timestamp>.md` caem em `--out` (padrão `supabase/eval/out/`, no `.gitignore`).

Testes do harness:

```bash
cd supabase/eval && npm test
```

O teste de integração com o atlas só roda se `ATLAS_SYNC_SQL_TEST` apontar para o sync. Os testes unitários usam a fixture `ctx_rockefeller_golpe64.json` e não leem `ATLAS_SYNC_SQL`.

## Golden set

JSONL (uma pergunta por linha; linhas vazias e linhas `//` são ignoradas) ou JSON (array). Campos: `id`, `pergunta`, `expectativa` (`documentado`, `inferencia`, `sem_ligacao`, `fora_da_base`), `entidades_esperadas`, `fontes_esperadas`, `conexoes_esperadas`, `deve_conter`, `nao_deve_conter`. Opcionais: `categoria`, `entidades_contexto` (no máximo 3 ids), `voz_aion_obrigatoria`, `contexto_fixture`, `mock_resposta`, `notas`. `entidades_esperadas` aceita string ou objeto `{id, id_pendente?}`. `id_pendente` não tira a pergunta do conjunto. Entrada inválida sai com código 2.

O padrão é `golden/seed_v0.1.jsonl`. `provisorio_v0.jsonl` fica como exemplo do formato antigo (listas de strings).

`deve_conter` e `nao_deve_conter` são rubricas. Um token que existe no conjunto de ids da referência, ou um id estrutural (underscore, hífen com dígito, sigla maiúscula com dígito), precisa aparecer citado — ou não aparecer, no `nao_deve_conter`. A lista de palavras a ignorar (`base`, `fonte`, `id`, `alta` e o restante do mesmo grupo) vale no primeiro laço, não só no vizinho. Token com menos de 6 caracteres, sem `_`, `-` ou dígito, só vira id se for o item inteiro ou vizinho explícito de uma lista (`walther_ms, light ou ms`). Id estrutural (`E219`, `PR3-E056`) continua no meio da prosa. Vizinho de lista (`walther_moreira_salles, walter_ms ou heitor`) entra na mesma regra. Item com até 3 palavras e sem id é busca literal, sem acento e sem caixa. O resto vai para `rubrica_manual` com status `nao_avaliado_automaticamente` e não reprova. `--juiz` não avalia esse resto.

## O que entra na nota

- Grounding: entidade, relação e fonte citadas no `final` estão no recorte enviado ao modelo; bloco `documentado` tem ao menos uma fonte desse recorte. O bloco de lacuna sem ids, com «não documenta ligação» ou «não há fonte», não conta como bloco sem fonte. `citacao_removida` nos avisos conta como grounding quebrado.
- Citação válida: com `--ids-base`, o id precisa existir nesse arquivo. Entidade vale em `entidades` ou `casos`. Sem o arquivo, a referência continua sendo o sync (`entities`, `relationships`, `sources`, `investigation_cases`) ou, na falta dele, a fixture. Cada id inválido traz `motivo`: `formato_quebrado` (não casa `^[A-Za-z0-9_.:-]{1,120}$`, começa com `id_` ou é o literal `id`), `campo_errado` (existe em outro conjunto da referência) ou `inexistente`. As três classes entram em `ids_invalidos` e saem com código 1. O resumo e o agregado contam cada classe. O resultado grava `referencia_ids` (caminho, contagens, `_meta`) e `divergencia_ids`: por tipo, quantos ids estão só no PGlite/recorte ou só na referência, com até 50 ids de cada lado. Id esperado que não está na referência gera aviso `id_esperado_inexistente` e não sai com código 2. O texto bruto do modelo também é avaliado: no mock ele é o que o servidor local enviou; no OpenRouter ele é reconstruído dos eventos `delta` (o núcleo emite `delta`; o harness também aceita `token`). Id ausente da referência no bruto ou no final torna a citação inválida.
- `fora_da_base`: recusa se o `final` vem sem blocos, se o bruto tem `sem_base`, se o erro tem code `fora_da_base`, ou se o texto casa «não há fonte» / «não encontrei». Precisão e revocação usam só as perguntas `fora_da_base` como positivas. `sem_ligacao` fica de fora dessa matriz.
- `sem_ligacao`: passa se a resposta reconhece a ausência (`não documenta ligação`, `não há fonte`, `sem_base`, ou o texto do fallback do núcleo) e não afirma ligação. Afirma se um bloco `documentado` ou `inferencia` cita relação cujo par origem/destino liga as entidades esperadas direto ou por um intermediário, ou se o texto afirma a ligação. A taxa entra em `sem_ligacao_ok` por pergunta e no agregado. O limiar é 100% e só gera alerta.
- Recall de entidades, fontes e `conexoes_esperadas` (relações citadas em `relacoes` ou em `base`). Rubricas automáticas à parte das manuais. Latência p50/p95, custo em US$ e R$, checklist pt-BR e voz AION (fato com fonte, inferência com `base` e `justificativa`, pergunta em aberto). A voz é obrigatória quando `categoria` é `voz_aion` ou a pergunta pede para separar fato e inferência. Nas outras, só se registra.
- A latência vai do POST até o evento `final` ou `error`, com `performance.now()`. O percentil é o PERCENTILE.INC: amostra ordenada, posição `p*(n-1)`, interpolação linear. Com uma amostra o percentil é esse valor; sem amostras fica indefinido.
- Limiares em `limiares.json` só geram alerta. Não mudam o código de saída.

## Códigos de saída

- 0: toda corrida foi avaliável, não há citação inválida e não há grounding quebrado em pergunta `documentado`.
- 1: alguma citação inválida (`formato_quebrado`, `campo_errado` ou `inexistente`) contra a referência (`--ids-base`, ou sync/fixture se o arquivo não foi passado), ou grounding quebrado numa pergunta `documentado` avaliável. Grounding quebrado em `inferencia` ou `sem_ligacao` só gera alerta. Se também houver corrida não avaliável, a saída continua 1.
- 2: argumento ou golden inválido, sync ilegível, fixture ausente, `--ids-base` ilegível.
- 3: a avaliação não ocorreu. Uma corrida não é avaliável quando o HTTP é diferente de 200, quando o erro é `chave_recusada`, `sem_login`, `orcamento_esgotado`, `rede`, `sem_evento`, `modelo_indisponivel`, `modelo_ocupado`, `limite_chave` ou `rate_limit`, ou quando o JSON do modelo não parseia. O motivo é `GS-xxx: avaliacao_nao_ocorreu (<codigo>)`. `fora_da_base` é resposta válida e continua avaliável. Nessas linhas, recall, pt-BR, voz e custo ficam nulos: saem das médias e das matrizes de `fora_da_base` e `sem_ligacao`. No resumo o grounding delas é `nao_avaliado`. O agregado traz `avaliaveis` e `nao_avaliaveis`. Também sai 3 o modo `openrouter` sem `OPENROUTER_API_KEY`, e qualquer exceção não tratada.

## Sync SQL

O arquivo `006_sync_atlas_dataset.sql` é gerado por `supabase/scripts/gerar_sync_atlas.py` e fica fora do repositório. O harness aplica as migrações 001–005 (o `\gexec` da 002 vira `;`), o sync e a 008, e roda `ANALYZE`. A 007 não entra: ela depende de `auth.users`.

## Limitações

- PGlite não é o Supabase. Não há `verify_jwt` da borda: o harness assina um JWT HS256 local e o `iss` usa `SUPABASE_URL` só como emissor. Não há fetch para esse host. O resultado conta tentativas bloqueadas.
- O texto bruto do modelo é pontuado e não é gravado. O que vai para o disco passa por `redactSecrets` e por um filtro próprio de chave, autorização, JWT e URL de banco. O JWT usado no pedido não é gravado.
- pt-BR e voz AION são heurísticas (stopwords, acento, `<think>`, linguagem especulativa em bloco documentado).
- O mock determinístico não é um modelo: no perfil limpo cita a primeira relação do recorte limitado, ou deixa o fallback de `sem_ligacao` agir. Recall e rubricas de uma corrida mock medem esse caminho, não a qualidade de um modelo.
- O arquivo de ids e o sync ficam fora do repositório. O harness não abre conexão com o banco de produção.
