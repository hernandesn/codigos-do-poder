-- UX3b-003: fecha as pendências de pesquisa e a função do chat.
-- O restante da base continua com leitura pública. Idempotente.
-- A DSN não entra neste arquivo.
--
-- Conferido antes de revogar: o corpo de chat_context não lê
-- research_backlog nem research_backlog_sources. A função é
-- SECURITY INVOKER; quem chama, pela Edge Function, é atlas_reader.

BEGIN;

-- 1. A view passa a respeitar a RLS de quem consulta (advisor 0010).
ALTER VIEW public.relationship_evidence SET (security_invoker = true);

-- 2. search_path fixo (advisor 0011).
--    chat_context já nasce com search_path = public na 002.
ALTER FUNCTION public.search_entities(text,text,integer,integer,integer) SET search_path = public;
ALTER FUNCTION public.graph_neighborhood(text,integer,integer,integer)   SET search_path = public;

-- 3a. Pendências de pesquisa fora do acesso público.
--     Recria a política só para atlas_reader.
DROP POLICY IF EXISTS atlas_public_read ON public.research_backlog;
DROP POLICY IF EXISTS atlas_public_read ON public.research_backlog_sources;
DROP POLICY IF EXISTS atlas_reader_read ON public.research_backlog;
DROP POLICY IF EXISTS atlas_reader_read ON public.research_backlog_sources;

CREATE POLICY atlas_reader_read ON public.research_backlog
  FOR SELECT TO atlas_reader
  USING (true);

CREATE POLICY atlas_reader_read ON public.research_backlog_sources
  FOR SELECT TO atlas_reader
  USING (true);

REVOKE ALL ON public.research_backlog, public.research_backlog_sources FROM anon, authenticated;

-- 3b. Função do chat só para a Edge Function (atlas_reader).
--     search_entities e graph_neighborhood seguem executáveis por anon.
REVOKE EXECUTE ON FUNCTION public.chat_context(text[],text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chat_context(text[],text,integer,integer) TO atlas_reader;

-- 4. O público só lê. Escrita e TRUNCATE saem do grant, nas tabelas
--    atuais e nas que o postgres criar depois.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

-- 5. chat_private nunca exposto.
REVOKE ALL ON SCHEMA chat_private FROM PUBLIC, anon, authenticated;

INSERT INTO schema_migrations (version, name)
VALUES ('003', 'Close research backlog and chat_context, read-only public grants, invoker view, fixed search_path')
ON CONFLICT (version) DO NOTHING;

COMMIT;
