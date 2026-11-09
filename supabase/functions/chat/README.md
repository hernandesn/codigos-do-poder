# Edge Function `chat`

Núcleo reutilizável em `supabase/functions/_shared/chat_core.ts` (sem `Deno.serve`). A função HTTP está em `supabase/functions/chat/index.ts`. O banco entra por `ATLAS_CHAT_DB_URL` com o papel `chat_fn` (migração `004_chat_funcao.sql`).

## Antes do deploy

Conferir se os slugs ainda existem:

- `qwen/qwen3.7-flash` (Básico)
- `z-ai/glm-5.3` (Avançado)

```sh
curl -s https://openrouter.ai/api/v1/models | python3 -c 'import json,sys; ids={m["id"] for m in json.load(sys.stdin)["data"]}; print("qwen/qwen3.7-flash", "qwen/qwen3.7-flash" in ids); print("z-ai/glm-5.3", "z-ai/glm-5.3" in ids)'
```

Use uma chave OpenRouter **só do atlas**, com limite de crédito na conta (sugestão: US$ 10). O teto de US$ 3/dia no código é a outra trava. Não grave a chave neste repositório.

`custo_estimado` é `max_tokens` de saída vezes o preço por token do modelo (Básico 900 × US$ 0,0005/900; Avançado 1800 × US$ 0,004/1800). A reserva usa esse valor. Se a resposta custar mais, o commit grava o custo real e o dia pode passar do teto nessa pergunta que já estava em vôo. A próxima reserva vê o gasto e responde `orcamento_esgotado` sem chamar o OpenRouter. Erro ou aborto depois de qualquer token liquida esse custo no orçamento e devolve o crédito do usuário. Sem token, os dois são liberados.

`verify_jwt` fica `true` em `supabase/config.toml`. O gateway recusa JWT inválido antes do código. O handler também recusa: HS256 sem `JWT_SECRET` ou `SUPABASE_JWT_SECRET`, ES256 sem JWKS conferido em `SUPABASE_URL` (`/auth/v1/.well-known/jwks.json`), `exp` ausente ou vencido, `iss` diferente de `<SUPABASE_URL>/auth/v1`, `aud` ou `role` diferentes de `authenticated`, e qualquer outro `alg`. `user_metadata` não autoriza.

Antes de cada chamada o handler faz `GET https://openrouter.ai/api/v1/key` com a chave de inferência do app. A chamada só segue se `limit` for um número até 3, `limit_reset` for `daily` (meia-noite UTC, não o dia de São Paulo), `include_byok_in_limit` for false e ainda houver saldo na chave maior que a reserva. Configuração ausente ou inesperada responde `chave_recusada` e não chama o modelo. O app ainda reserva antes da chamada, reduz o teto configurado a 3 e só deixa uma chamada paga por vez; o lease dura mais que o aborto de 60s para a segunda não sair com a primeira ainda no provedor. O commit grava o custo informado, sem cortá-lo. Uma chamada em andamento pode liquidar acima da reserva: a chave nativa também pode. `CHAT_DAILY_BUDGET_USD` acima de 3 não autoriza mais que 3. Se um commit órfão não couber em `gasto + reservado`, ele não grava; se couber, grava o valor inteiro.

## Segredos

O painel do projeto ou o terminal do Hernandes. Este diretório não recebe os valores.

- `OPENROUTER_API_KEY`
- `ATLAS_CHAT_DB_URL` — pooler **transaction**, porta **6543**, usuário `chat_fn.<project-ref>`. O host sai do botão Connect do painel (não dá para montar o índice do pooler só com a região).
- `CHAT_DAILY_BUDGET_USD` = `3`, se ainda não existir.

Não definir `CHAT_DB` nem `CHAT_EXPOSE_STATE` em produção. Esses dois só existem para o teste local com banco em memória.

## Teste local sem gasto

```sh
deno test --allow-net --allow-env --allow-read \
  supabase/functions/_shared/chat_core_test.ts \
  supabase/functions/_shared/contrato_ux3a_test.ts \
  supabase/functions/chat/local_serve_test.ts
```

O teste HTTP sobe um mock em `127.0.0.1` e aponta `OPENROUTER_URL` para ele. A chave desse teste é `local-mock-not-a-real-key`.

## Contrato SSE (UX3a)

`meta` sai antes de qualquer token. `gratis_restantes` e `saldo_pago` nesse evento são o estado **no momento da reserva, antes do débito deste pedido**. O `final` repete os dois campos com os valores **depois do commit**. Não há objeto `saldo`.

| Campo em `meta` | Tipo |
|---|---|
| `conversa_id` | string |
| `modelo` | `basico` \| `avancado` |
| `custo_estimado` | number |
| `n_entidades` | number |
| `n_fontes` | number |
| `gratis_restantes` | number, antes do débito |
| `saldo_pago` | number, antes do débito |

`final`: `conversa_id`, `blocos`, `entidades` (`{ id, nome }` — o nome vem do `chat_context`), `fontes` (só ids, o front resolve na base local), `fontes_detalhe` (só as fontes citadas: `{ titulo, url?, localizador? }`), `avisos`, `usage?`, `custo_real`, `gratis_restantes`, `saldo_pago`.

Bloco documentado: `{ tipo: "documentado", texto, entidades, relacoes, fontes }`.

Bloco inferência: `{ tipo: "inferencia", texto, base, justificativa }`. `base` são ids de relações ou entidades usados.

`avisos`: `{ tipo, relacao?, valor?, texto }`. `tipo` é `estado`, `citacao_removida` ou `outro`. Texto curto em pt-BR. Id que não está no recorte sai da resposta e gera `citacao_removida`.

Exemplo de `final` para o mock: `supabase/functions/chat/fixtures/final_exemplo.json`.

## Códigos

Erro antes do stream usa o HTTP da tabela. Erro depois do stream aberto continua HTTP 200 com evento `error`. `rede` e `abortado` não têm cópia de produto no servidor: o front mostra a mensagem. O evento ainda traz um texto curto.

| code | HTTP precoce | message |
|---|---|---|
| `sem_login` | 401 | Entre para usar o chat. |
| `sem_creditos` | 402 | Seus créditos acabaram. |
| `rate_limit` | 429 | Muitas perguntas seguidas. Tente em {retry_after_s}s. |
| `fora_da_base` | 200 (evento) | Não encontrei isso na base do atlas. |
| `modelo_indisponivel` | 503 | O modelo está indisponível agora. Tente de novo. |
| `orcamento_esgotado` | 503 | Chat temporariamente indisponível. |
| `chave_recusada` | 503 | Chat indisponível: a configuração da chave de inferência não foi aceita. |
| `limite_chave` | 503 | Chat indisponível: o limite da chave de inferência foi atingido. |
| `ocupado` | 503 | Chat temporariamente ocupado. |
| `pedido_invalido` | 400 | Pergunta inválida (até 2000 caracteres e 3 entidades). |
| `rede` / `abortado` | — | (só no front) |

`pedido_invalido` faz parte do contrato. O rate limit de 10/min e o de 200/dia são serializados por usuário dentro de `chat_rate_touch`, com `pg_advisory_xact_lock`.

`supabase functions serve` neste ambiente pede Docker. Sem Docker, o teste HTTP em `local_serve_test.ts` chama o mesmo `handleChatRequest`. Esse teste direto não exercita a verificação de JWT do gateway: `verify_jwt = true` em `config.toml` só roda na borda do Supabase. O helper local, quando confere assinatura, não substitui essa borda.

## Portões remotos

Cada um espera um sim separado. Nenhum foi executado nesta tarefa. Os comandos completos estão em `database/UX3c-relatorio.md`.

O URI do pooler, sem senha e sem host inventado:

`postgresql://chat_fn.ozeiyqpbtggvuyhplisa:[SENHA]@[POOLER-HOST-DO-PAINEL]:6543/postgres`

O host é o que o painel mostra em Connect → Transaction pooler. A senha é a do `ALTER ROLE chat_fn`, só no SQL Editor.
