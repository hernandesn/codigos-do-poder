# Supabase do chat (Códigos do Poder)

Cópia do que está em produção no projeto Supabase do atlas. Serve de registro e para revisão.
Nada aqui tem chave, senha ou URL de banco: tudo isso fica nos secrets da função e no painel do Supabase.

- `functions/chat/` e `functions/_shared/`: a edge function `chat` (versão 6, `verify_jwt` ligado).
  Inclui a lista de origens CORS (`CORS_ORIGINS` em `_shared/chat_core.ts`) e a nova repetição única
  com espera curta quando o OpenRouter devolve 429 (código `modelo_ocupado`).
  Testes: `deno test --allow-env --allow-read --allow-net=127.0.0.1 functions/`.
- `migrations/`: 001 a 005 e 007, na ordem em que foram aplicadas.
  O número 006 foi a sincronização de dados do atlas, gerada por script; não é migration de esquema.
  Em 007, a linha do usuário liberado foi omitida de propósito.
- `scripts/gerar_sync_atlas.py`: gera o SQL de sincronização (006) a partir de `dados/base-investigativa.json`
  e dos dados do site. O SQL gerado (cerca de 3,7 MB) não fica no repositório, e o JSON de base também não.
