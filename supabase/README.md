# Supabase do chat (Códigos do Poder)

Cópia do que está em produção no projeto Supabase do atlas. Serve de registro e para revisão.
Nada aqui tem chave, senha ou URL de banco: tudo isso fica nos secrets da função e no painel do Supabase.

- `functions/chat/` e `functions/_shared/`: a edge function `chat` (versão 8, `verify_jwt` ligado).
  Inclui a lista de origens CORS (`CORS_ORIGINS` em `_shared/chat_core.ts`) e a nova repetição única
  com espera curta quando o OpenRouter devolve 429 (código `modelo_ocupado`).
  Testes: `deno test --allow-env --allow-read --allow-net=127.0.0.1 functions/`.
- `migrations/`: 001 a 005, 007 e 008, na ordem em que foram aplicadas.
  A 008 reescreve `chat_context`: aceita plural, ano abreviado ("golpe de 64") e alguns apelidos de eventos;
  quando a pergunta cita dois temas, escolhe raízes ligadas entre si, coloca primeiro as relações que as ligam
  (direto ou por um intermediário) e devolve `ligacoes_entre_raizes`.
  O número 006 foi a sincronização de dados do atlas, gerada por script; não é migration de esquema.
  Em 007, a linha do usuário liberado foi omitida de propósito.
- `scripts/gerar_sync_atlas.py`: gera o SQL de sincronização (006) a partir de `pesquisa/dados/base-investigativa.json`
  (árvore única; os caminhos partem da raiz, de qualquer diretório). Saída padrão:
  `pesquisa/database/sync/006_sync_atlas_dataset.sql`, ignorada pelo git (cerca de 4 MB).

## Testes

- Função: `deno test --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/` (ou, sem Deno,
  `node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs`).
- SQL, num Postgres em memória (PGlite, offline): `npm i @electric-sql/pglite` e
  `node supabase/tests/run_pglite.mjs` (lê a saída padrão do gerador; `ATLAS_SYNC_SQL=/caminho/006.sql` sobrepõe).
  `python3 supabase/tests/test_layout_arvore_unica.py` gera o SQL de um cwd qualquer e roda o PGlite sem `ATLAS_SYNC_SQL`.

Na v8, quando a pergunta cita dois temas sem ligação documentada e o modelo diz que não há base,
a função responde com o que a base tem sobre cada tema e avisa que a ligação direta não está documentada.
