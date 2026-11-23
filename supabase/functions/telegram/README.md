# Telegram — implementação local, ainda não publicada

Bot: **@aion_codigosdopoder_bot** — https://t.me/aion_codigosdopoder_bot.

`index.ts` conecta as dependências de produção; `handler.ts` recebe dependências injetáveis e não lê ambiente. Não há service_role, criação de contas ou alteração na função `chat`. O adaptador `chat_final.ts` deste clone importa o `chat_core.ts` local (núcleo anterior, preservado de propósito). Quem chama `runChat` da v18, com os mesmos `prepareChat` e `streamPrepared`, e quem preserva modelos, preços, teto global de US$ 3/dia, cota, rate por user_id, recusas e logs SEC-01–04 é o clone `chat/`. Esta cópia em `site/` não comprova esses controles. A contabilidade diária do núcleo continua em America/Sao_Paulo; apenas o novo rate Telegram usa America/Cuiaba. Não alterar a fronteira da cota existente nesta tarefa. O núcleo (`chat/**` e `chat_core.ts`) não foi editado.

## Autenticação e rotas

Somente **telegram** usa `verify_jwt=false`: o Telegram não envia JWT. `chat` continua com JWT ligado pelo padrão. Antes de ler o corpo ou obter conexão de banco, o webhook compara os digests SHA-256 do header `X-Telegram-Bot-Api-Secret-Token` e do secret já resolvido, percorrendo sempre os mesmos 32 bytes, sem saída antecipada por prefixo. Secret ausente/incorreto retorna 401 mesmo se o corpo exceder o limite. Com secret correto, SEC-03 limita bytes e tempo de recebimento. Em produção, `webhookSecretValue` trata secret ausente ou com menos de 32 caracteres como ausente; o handler não impõe esse piso, para os testes injetarem um valor sintético. Se o token do bot não estiver configurado, a função responde 503 `configuracao_ausente` depois do secret e dos ignores, e antes de `db()`/claim/núcleo/envio.

POST na raiz da função processa exclusivamente `message` com texto, `chat.type=private`, remetente humano e id do chat igual ao remetente. Grupos, canais, edições, callback_query, my_chat_member, mídia e formatos desconhecidos retornam 200 vazio sem DB/envio. `update_id` é reclamado atomicamente antes de qualquer efeito. Mensagens acima de 2000 caracteres recebem aviso e não seguem ao núcleo. O envio ao Telegram continua em trechos de até 4096 unidades UTF-16, com pré-visualização de link desligada.

O rate adicional permite até 8 pedidos/minuto e 100/dia por telegram_id para `/start`, perguntas, texto longo, abertura e consultas do mini app. `/desvincular` não entra nesse rate: depois do secret, da checagem de token e do claim, executa o unlink mesmo com o limite esgotado, não chama o modelo, não grava overflow e pode enviar a confirmação fixa. Bloqueios das outras mensagens não gravam evento de rate nem enviam aviso pelo bot (para evitar amplificação). O claim de update continua registrado para impedir reprocessamento. O rate do núcleo por usuário continua independente e compartilhado com o site. As exceções privadas já existentes do núcleo não eliminam o rate Telegram.

Comandos: `/start` explica o vínculo; `/start <código>` consome código forte; `/desvincular` remove o vínculo do remetente. Sem vínculo, perguntas recebem instruções. Com vínculo, o user_id vem exclusivamente de `telegram_links`.

Rotas do mini app (POST, com CORS das origens já aceitas):

- `/app/session`: `Authorization: tma <initData>` validado; registra o hash em `telegram_initdata_replay` e devolve uma prova aleatória de 256 bits. Reabrir o mesmo initData válido, do mesmo telegram_id e ainda no prazo, rotaciona a prova e devolve 200; a prova anterior deixa de valer. InitData ausente, forjado ou vencido continua 401. Sem token configurado, falha fechado.
- `/app/status`: mesmo header tma mais `X-Telegram-App-Session`; consulta o vínculo atual, sem chamar modelo.
- `/app/chat`: mesmos headers; somente mensagem/modelo são encaminhados ao núcleo; resposta JSON `{final}` ou `{code,message}`. Não confia em user_id, telegram_id, contexto ou conversa do corpo.

O HMAC usa `HMAC_SHA256(key="WebAppData", message=bot_token)` para derivar a chave, todos os campos exceto `hash` ordenados para a mensagem e comparação de digest em laço fixo. Rejeita parâmetros duplicados, usuário inválido, initData maior que 16 KiB, idade acima de uma hora e futuro acima de 30 segundos. Base documental fornecida no job: `spec/HMAC-INITDATA.md`; referência oficial: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app. Nenhuma consulta à referência foi feita neste job local.

A prova de sessão fica em memória no cliente. Cada carga chama `/app/session` de novo: o mesmo initData válido, do mesmo telegram_id e ainda no prazo, recebe outra prova, e a anterior deixa de resolver o vínculo. O banco guarda somente o hash da prova vigente. A autenticação HMAC e a data são verificadas em toda chamada. Rebind/desvínculo invalidam a prova antiga pelo `binding_id` e pelo `session_hash`. Um init_hash já gravado para outro telegram_id é recusado. Roubo simultâneo de initData e da prova vigente equivale a roubo de sessão e ainda exige tratamento operacional.

## Banco, transporte e falhas

Migração 013 cria somente tabelas privadas com RLS e nove RPCs SECURITY DEFINER, search_path fixo `pg_catalog, chat_private` e EXECUTE apenas para chat_fn. A nona, `telegram_revoke_codes`, sob o mesmo advisory lock da emissão, grava `revoked_at` daquele usuário e apaga códigos ainda não usados. `telegram_issue_code(uuid, text, bigint)` só grava se o `iat` do JWT já autenticado for posterior a esse marco. Sem grants diretos de tabela a chat_fn, chat_writer, anon ou authenticated. O banco é acessado por `ATLAS_CHAT_DB_URL`, como na chat, pelo papel chat_fn. Queries parametrizadas, sem identificadores vindos de usuário. O rollback comentado na própria 013 inclui `DROP FUNCTION IF EXISTS chat_private.telegram_revoke_codes(uuid)` e `DROP TABLE IF EXISTS chat_private.telegram_link_revocations`. A 012 não entra no PR do site: já é de outro trabalho e só acompanha o harness local deste clone.

`createTelegramSender` exige fetch explicitamente injetado. Produção fornece o fetch e lê o token do ambiente tardiamente; testes fornecem somente token falso e fetch fake. A única URL de envio tem host/path fixos de sendMessage, token validado como segmento, redirects proibidos, texto puro sem parse_mode, `disable_web_page_preview` e `link_preview_options.is_disabled`, chunks de até 4096 unidades UTF-16 sem partir emoji. Sem retries de envio que possam duplicar mensagem. URLs e erros remotos não entram em logs.

Idempotência prioriza **at-most-once**: falha depois de claim pode deixar um update sem resposta; repetir o mesmo update não gasta novamente. Não promete entrega exatamente uma vez. Uma resposta pode levar até o prazo do modelo mais envio; o Telegram pode repetir o webhook enquanto aguarda e a repetição é descartada. Cada trecho enviado tem timeout de dez segundos. Não existe worker/outbox nesta primeira versão. Planejar retenção operacional dos IDs de updates e métricas antes de alta escala; as sessões expiradas são removidas em novas aberturas, códigos antigos do usuário são substituídos a cada emissão.

Logs do transporte contêm somente evento, classificação fixa e UUID gerado no servidor. Não imprimem perguntas, initData, códigos, prova, token, telegram_id ou erro cru do driver. Logs/contabilidade do núcleo preservam o contrato SEC-04 existente.

## Ambiente — apenas nomes

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_LINK_PEPPER`, `ATLAS_CHAT_DB_URL`, `JWT_SECRET`, `SUPABASE_JWT_SECRET`, `SUPABASE_URL`, `CHAT_DAILY_BUDGET_USD`, `OPENROUTER_API_KEY`, `OPENROUTER_KEY_URL`, `OPENROUTER_URL`.

## Testes offline

Na raiz do clone chat:

```sh
node supabase/functions/_shared/telegram_node_test.mjs
node supabase/functions/_shared/chat_core_node_test.mjs
deno test --no-remote supabase/functions/_shared/telegram_auth_test.ts supabase/functions/_shared/chat_final_test.ts supabase/functions/telegram/handler_test.ts supabase/functions/telegram-link/handler_test.ts
PGLITE_PATH=<pacote-local>/dist/index.js node supabase/tests/run_telegram_pglite.mjs
```

O runner Node proíbe rede e leitura de ambiente pelas dependências Deno, e apaga do processo os nomes de token, secret, pepper, chave e DSN sem imprimi-los. O comando Deno novo não concede env nem net; todos os valores são sintéticos e injetados. PGLite cria papéis vazios e banco WASM descartável, aplica as migrações deste clone (sem a 012 e sem a 014) mais a 013 e a 015, verifica RLS/ACL, unicidade, código expirado/reusado, rebind, revogação, idempotência, rate sem overflow e a reabertura da sessão. Não aponta a DSN ou produção. O papel vazio service_role no harness existe apenas porque migrações antigas o referenciam; nenhuma chave é usada.

Os passos de implantação **futura** e o rollback comentado estão no `RELATORIO.md` da pasta do job e no cabeçalho da 013. Não executar sem o sim do Hernandes; não fazer redeploy da chat.
