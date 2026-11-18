-- UX3b: contexto do chat, roles de leitura/escrita e RLS.
-- Idempotente. Não carrega dados documentais (isso fica no migrate_json_to_postgres.py).
-- A DSN não entra neste arquivo.
--
-- CREATE ROLE não pode rodar dentro de um bloco de transação nem de um DO.
-- As roles são criadas antes do BEGIN, só se ainda não existirem.
-- O restante da migração é uma transação só.
--
-- Pendência UX3c: NÃO conceder atlas_reader nem chat_writer a authenticator aqui.

SELECT cmd
FROM (
  SELECT 'CREATE ROLE atlas_reader NOLOGIN' AS cmd
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_reader')
  UNION ALL
  SELECT 'CREATE ROLE chat_writer NOLOGIN'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_writer')
) AS roles_to_create
\gexec

BEGIN;

CREATE SCHEMA IF NOT EXISTS chat_private;

COMMENT ON SCHEMA chat_private IS
  'Uso interno do chat. Não expor na API do Supabase (só public entra no PostgREST). Sem texto de pergunta.';

CREATE TABLE IF NOT EXISTS chat_private.chat_rate_events (
  user_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_rate_events_user_key_at_idx
  ON chat_private.chat_rate_events (user_key, at);

CREATE TABLE IF NOT EXISTS chat_private.chat_logs (
  id bigserial PRIMARY KEY,
  conversa_id text,
  user_key text,
  modelo text,
  tokens_in integer,
  tokens_out integer,
  custo_usd numeric(10, 6),
  latencia_ms integer,
  entidades text[],
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE chat_private.chat_logs IS
  'Metadados de uso do chat. Não há coluna para o texto da pergunta.';

-- A normalização da query (NFKD, sem acentos, minúsculas) é do chamador,
-- como documentado em search_entities na migração 001. Esta função não
-- remove acentos. Se entity_ids vier vazio e query estiver preenchida,
-- as raízes saem de search_entities(query, NULL, NULL, NULL, 8), no máximo 8.
-- entity_ids explícito usa no máximo 3 ids, na ordem recebida.
-- Id ausente não é erro: a raiz é ignorada; se nenhuma existir, as listas voltam vazias.
--
-- Vizinhança lida direto de relationships (não via graph_neighborhood):
-- graph_neighborhood ordena por id e corta nós/evidências com outros tetos.
-- Aqui o grau 1 é a aresta incidente a uma raiz (afirmação completa) e o grau 2
-- é a aresta que toca um vizinho direto sem tocar a raiz (afirmação resumida).
-- Ordem: grau, intensidade (weight) desc., confiança (alta > media > baixa).
-- max_relationships e max_sources são cortados em 60 e 40 mesmo se o chamador pedir mais.
CREATE OR REPLACE FUNCTION public.chat_context(
  entity_ids text[],
  query text DEFAULT NULL,
  max_relationships integer DEFAULT 60,
  max_sources integer DEFAULT 40
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET statement_timeout = '3s'
SET search_path = public
AS $chat$
DECLARE
  v_rel_cap integer := least(greatest(coalesce(max_relationships, 60), 0), 60);
  v_src_cap integer := least(greatest(coalesce(max_sources, 40), 0), 40);
  v_query text := btrim(coalesce(query, ''));
  v_has_ids boolean := coalesce(cardinality(entity_ids), 0) > 0;
  v_result jsonb;
BEGIN
  WITH requested AS (
    SELECT btrim(u.entity_id) AS entity_id, u.ord::integer AS ord
    FROM unnest(coalesce(entity_ids, ARRAY[]::text[])) WITH ORDINALITY AS u(entity_id, ord)
    WHERE v_has_ids
      AND u.ord <= 3
      AND btrim(coalesce(u.entity_id, '')) <> ''
  ),
  explicit_roots AS (
    SELECT e.entity_id, e.canonical_name, e.entity_type, e.research_cluster, min(r.ord) AS ord
    FROM requested r
    JOIN entities e ON e.entity_id = r.entity_id
    GROUP BY e.entity_id, e.canonical_name, e.entity_type, e.research_cluster
  ),
  search_roots AS (
    SELECT s.entity_id, s.canonical_name, s.entity_type, s.research_cluster, s.ord::integer AS ord
    FROM search_entities(v_query, NULL, NULL, NULL, 8)
      WITH ORDINALITY AS s(entity_id, canonical_name, entity_type, research_cluster, matched_as, ord)
    WHERE NOT v_has_ids
      AND v_query <> ''
  ),
  roots AS (
    SELECT entity_id, canonical_name, entity_type, research_cluster, ord FROM explicit_roots
    UNION ALL
    SELECT entity_id, canonical_name, entity_type, research_cluster, ord FROM search_roots
  ),
  rel_d1 AS (
    SELECT r.relationship_id, r.source_entity_id, r.target_entity_id, r.relation_type,
           r.weight, r.period_label, r.assertion, r.limitation, r.review_status,
           r.confidence, 1 AS grau
    FROM relationships r
    WHERE r.source_entity_id IN (SELECT entity_id FROM roots)
       OR r.target_entity_id IN (SELECT entity_id FROM roots)
  ),
  neighbors AS (
    SELECT endpoint_id AS entity_id
    FROM (
      SELECT source_entity_id AS endpoint_id FROM rel_d1
      UNION
      SELECT target_entity_id FROM rel_d1
    ) AS endpoints
    WHERE endpoint_id NOT IN (SELECT entity_id FROM roots)
  ),
  rel_d2 AS (
    SELECT r.relationship_id, r.source_entity_id, r.target_entity_id, r.relation_type,
           r.weight, r.period_label, r.assertion, r.limitation, r.review_status,
           r.confidence, 2 AS grau
    FROM relationships r
    WHERE (
      r.source_entity_id IN (SELECT entity_id FROM neighbors)
      OR r.target_entity_id IN (SELECT entity_id FROM neighbors)
    )
    AND NOT EXISTS (
      SELECT 1 FROM rel_d1 d1 WHERE d1.relationship_id = r.relationship_id
    )
  ),
  ranked AS (
    SELECT rel.*,
           row_number() OVER (
             ORDER BY rel.grau,
                      rel.weight DESC,
                      CASE lower(btrim(coalesce(rel.confidence, '')))
                        WHEN 'alta' THEN 3
                        WHEN 'media' THEN 2
                        WHEN 'média' THEN 2
                        WHEN 'baixa' THEN 1
                        ELSE 0
                      END DESC,
                      rel.relationship_id
           ) AS rn,
           count(*) OVER () AS total_rels
    FROM (
      SELECT * FROM rel_d1
      UNION ALL
      SELECT * FROM rel_d2
    ) AS rel
  ),
  chosen AS (
    SELECT * FROM ranked WHERE rn <= v_rel_cap
  ),
  evidence_rows AS (
    SELECT ev.relationship_id, ev.source_id, ev.evidence_level, ev.passage_locator,
           ev.excerpt_text, ev.independence_key, c.rn
    FROM evidence ev
    JOIN chosen c ON c.relationship_id = ev.relationship_id
  ),
  source_rank AS (
    SELECT source_id, min(rn) AS first_rn
    FROM evidence_rows
    GROUP BY source_id
  ),
  chosen_sources AS (
    SELECT source_id, first_rn,
           row_number() OVER (ORDER BY first_rn, source_id) AS src_rn,
           count(*) OVER () AS total_sources
    FROM source_rank
  ),
  kept_sources AS (
    SELECT source_id FROM chosen_sources WHERE src_rn <= v_src_cap
  ),
  entity_degree AS (
    SELECT entity_id, 0 AS grau, ord
    FROM roots
    UNION ALL
    SELECT entity_id, 1, NULL::integer
    FROM neighbors
    WHERE entity_id IN (
      SELECT source_entity_id FROM chosen
      UNION
      SELECT target_entity_id FROM chosen
    )
    UNION ALL
    SELECT endpoint_id, 2, NULL::integer
    FROM (
      SELECT source_entity_id AS endpoint_id FROM chosen
      UNION
      SELECT target_entity_id FROM chosen
    ) AS endpoints
    WHERE endpoint_id NOT IN (SELECT entity_id FROM roots)
      AND endpoint_id NOT IN (SELECT entity_id FROM neighbors)
  )
  SELECT jsonb_build_object(
    'raizes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.entity_id,
        'nome', r.canonical_name,
        'tipo', r.entity_type,
        'cluster', r.research_cluster
      ) ORDER BY r.ord, r.entity_id)
      FROM roots r
    ), '[]'::jsonb),
    'entidades', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.entity_id,
        'nome', e.canonical_name,
        'tipo', e.entity_type,
        'cluster', e.research_cluster,
        'grau', d.grau,
        'nota', CASE WHEN d.grau >= 2 THEN NULL ELSE e.note END
      ) ORDER BY d.grau, e.canonical_name, e.entity_id)
      FROM (
        SELECT entity_id, min(grau) AS grau
        FROM entity_degree
        GROUP BY entity_id
      ) AS d
      JOIN entities e ON e.entity_id = d.entity_id
    ), '[]'::jsonb),
    'relacoes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.relationship_id,
        'origem', c.source_entity_id,
        'destino', c.target_entity_id,
        'tipo', c.relation_type,
        'afirmacao', CASE
          WHEN c.grau = 1 THEN c.assertion
          WHEN char_length(c.assertion) <= 180 THEN c.assertion
          ELSE left(c.assertion, 177) || '...'
        END,
        'periodo', c.period_label,
        'estado', c.review_status,
        'confianca', c.confidence,
        'limite', c.limitation,
        'fontes', coalesce((
          SELECT jsonb_agg(er.source_id ORDER BY er.source_id)
          FROM evidence_rows er
          WHERE er.relationship_id = c.relationship_id
        ), '[]'::jsonb),
        'grau', c.grau
      ) ORDER BY c.rn)
      FROM chosen c
    ), '[]'::jsonb),
    'fontes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.source_id,
        'titulo', s.title,
        'editor', s.publisher,
        'url', s.source_url,
        'tipo', s.source_type,
        'localizador', s.passage_locator,
        'acesso', s.access_note,
        'publicado_em', coalesce(s.published_at_raw, s.published_on::text),
        'consultado_em', s.accessed_on,
        'evidencias', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'relationship_id', er.relationship_id,
            'evidence_level', er.evidence_level,
            'passage_locator', er.passage_locator,
            'excerpt_text', er.excerpt_text,
            'independence_key', er.independence_key
          ) ORDER BY er.relationship_id)
          FROM evidence_rows er
          WHERE er.source_id = s.source_id
        ), '[]'::jsonb)
      ) ORDER BY ks.first_rn, s.source_id)
      FROM kept_sources k
      JOIN chosen_sources ks ON ks.source_id = k.source_id
      JOIN sources s ON s.source_id = k.source_id
    ), '[]'::jsonb),
    'casos', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.case_id,
        'titulo', c.title,
        'periodo', c.period_label,
        'esfera', c.sphere,
        'mecanismo', c.mechanism,
        'conclusao', c.conclusion
      ) ORDER BY c.case_id)
      FROM investigation_cases c
      WHERE c.case_id IN (
        SELECT ice.case_id
        FROM investigation_case_entities ice
        WHERE ice.entity_id IN (SELECT entity_id FROM roots)
        UNION
        SELECT icr.case_id
        FROM investigation_case_relationships icr
        JOIN relationships r ON r.relationship_id = icr.relationship_id
        WHERE r.source_entity_id IN (SELECT entity_id FROM roots)
           OR r.target_entity_id IN (SELECT entity_id FROM roots)
      )
    ), '[]'::jsonb),
    'limites', jsonb_build_object(
      'relacoes', (SELECT count(*) FROM chosen),
      'fontes', (SELECT count(*) FROM kept_sources),
      'truncado',
        coalesce((SELECT max(total_rels) > v_rel_cap FROM ranked), false)
        OR coalesce((SELECT max(total_sources) > v_src_cap FROM chosen_sources), false)
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$chat$;

COMMENT ON FUNCTION public.chat_context(text[], text, integer, integer) IS
  'Contexto documental do chat. Query vazia de entity_ids usa search_entities; a normalização NFKD sem acentos e em minúsculas é feita pelo chamador. Tetos absolutos: 60 relações e 40 fontes.';

REVOKE ALL ON SCHEMA chat_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA chat_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_private FROM PUBLIC;
GRANT USAGE ON SCHEMA chat_private TO chat_writer;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA chat_private TO chat_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chat_private TO chat_writer;

DO $revoke_api$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA chat_private FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA chat_private FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_private FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA chat_private FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA chat_private FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_private FROM authenticated';
  END IF;
END
$revoke_api$;

REVOKE ALL ON SCHEMA chat_private FROM atlas_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA chat_private FROM atlas_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_private FROM atlas_reader;

-- chat_writer não escreve (nem lê) a base pública.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM chat_writer;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM chat_writer;

GRANT USAGE ON SCHEMA public TO atlas_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM atlas_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_reader;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM atlas_reader;

GRANT EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) TO atlas_reader;
GRANT EXECUTE ON FUNCTION public.search_entities(text, text, integer, integer, integer) TO atlas_reader;
GRANT EXECUTE ON FUNCTION public.graph_neighborhood(text, integer, integer, integer) TO atlas_reader;

DO $rls$
DECLARE
  open_tables text[] := ARRAY[
    'knowledge_base_metadata',
    'entities',
    'sources',
    'entity_aliases',
    'investigation_cases',
    'relationships',
    'evidence',
    'investigation_case_sources',
    'investigation_case_relationships',
    'investigation_case_entities',
    'events',
    'entity_summaries',
    'investigation_paths',
    'investigation_path_entities',
    'research_backlog',
    'research_backlog_sources',
    'corporate_structure_snapshots',
    'corporate_structure_lines',
    'corporate_structure_sources',
    'financial_series',
    'dataset_updates'
  ];
  closed_tables text[] := ARRAY['schema_migrations', 'dataset_imports'];
  private_tables text[] := ARRAY['chat_rate_events', 'chat_logs'];
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY open_tables || closed_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS atlas_public_read ON public.%I', tbl);
  END LOOP;

  FOREACH tbl IN ARRAY open_tables LOOP
    EXECUTE format(
      'CREATE POLICY atlas_public_read ON public.%I FOR SELECT TO atlas_reader, anon, authenticated USING (true)',
      tbl
    );
  END LOOP;

  -- schema_migrations e dataset_imports: RLS sem política para anon/authenticated.
  -- atlas_reader lê; a API anônima não.
  FOREACH tbl IN ARRAY closed_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS atlas_reader_read ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY atlas_reader_read ON public.%I FOR SELECT TO atlas_reader USING (true)',
      tbl
    );
  END LOOP;

  FOREACH tbl IN ARRAY private_tables LOOP
    EXECUTE format('ALTER TABLE chat_private.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_select ON chat_private.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_insert ON chat_private.%I', tbl);
    EXECUTE format(
      'CREATE POLICY chat_writer_select ON chat_private.%I FOR SELECT TO chat_writer USING (true)',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY chat_writer_insert ON chat_private.%I FOR INSERT TO chat_writer WITH CHECK (true)',
      tbl
    );
  END LOOP;
END
$rls$;

INSERT INTO schema_migrations (version, name)
VALUES ('002', 'Chat context, reader and writer roles, private chat schema, row level security')
ON CONFLICT (version) DO NOTHING;

COMMIT;
