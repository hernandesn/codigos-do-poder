-- Busca de entidades em perguntas livres. Sem extensões ou alterações nas tabelas.
-- Corpo da 002 preservado, exceto search_roots; ids explícitos mantêm o mesmo caminho.
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
    WITH cleaned_query AS (
      SELECT coalesce(string_agg(w.word, ' ' ORDER BY w.ord), '') AS cleaned
      FROM regexp_split_to_table(
        regexp_replace(
          translate(lower(v_query),
                    'áàâãäåéèêëíìîïóòôõöúùûüçñýÿ',
                    'aaaaaaeeeeiiiiooooouuuucnyy'),
          '[^a-z0-9 ]', ' ', 'g'
        ), ' +'
      ) WITH ORDINALITY AS w(word, ord)
      WHERE NOT v_has_ids
        AND v_query <> ''
        AND w.word <> ''
        AND w.word <> ALL (ARRAY[
          'que', 'quem', 'qual', 'quais', 'o', 'a', 'os', 'as', 'um', 'uma',
          'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
          'entre', 'sobre', 'fale', 'falar', 'me', 'conte', 'relacao', 'relacoes',
          'ligacao', 'ligacoes', 'com', 'para', 'por', 'foi', 'era', 'eh', 'sao',
          'quando', 'onde', 'como', 'porque', 'historia'
        ])
    ),
    candidates AS (
      SELECT s.entity_id, 0 AS match_rank
      FROM search_entities(v_query, NULL, NULL, NULL, 8) s
      WHERE NOT v_has_ids AND v_query <> ''
      UNION ALL
      SELECT s.entity_id, 1 AS match_rank
      FROM cleaned_query q
      CROSS JOIN LATERAL search_entities(q.cleaned, NULL, NULL, NULL, 8) s
      WHERE NOT v_has_ids AND q.cleaned <> ''
      UNION ALL
      SELECT e.entity_id, 2 AS match_rank
      FROM cleaned_query q
      CROSS JOIN entities e
      WHERE NOT v_has_ids AND q.cleaned <> ''
        AND char_length(split_part(e.normalized_name, ' · ', 1)) >= 5
        AND (' ' || q.cleaned || ' ')
          LIKE ('% ' || split_part(e.normalized_name, ' · ', 1) || ' %')
    ),
    distinct_candidates AS (
      SELECT e.entity_id, e.canonical_name, e.entity_type, e.research_cluster,
             split_part(e.normalized_name, ' · ', 1) AS base_name,
             min(c.match_rank) AS match_rank
      FROM candidates c
      JOIN entities e ON e.entity_id = c.entity_id
      GROUP BY e.entity_id, e.canonical_name, e.entity_type, e.research_cluster, e.normalized_name
    )
    SELECT c.entity_id, c.canonical_name, c.entity_type, c.research_cluster,
           (row_number() OVER (
             ORDER BY (c.base_name = btrim(lower(v_query))) DESC, c.match_rank, char_length(c.base_name) DESC, c.entity_id
           ))::integer AS ord
    FROM distinct_candidates c
    WHERE (
      -- Nome exato da pergunta nunca é descartado por nomes mais longos.
      c.base_name = btrim(lower(v_query))
      OR c.base_name = (SELECT q.cleaned FROM cleaned_query q)
      OR NOT EXISTS (
        SELECT 1
        FROM distinct_candidates longer
        WHERE char_length(longer.base_name) > char_length(c.base_name)
          AND strpos(longer.base_name, c.base_name) > 0
      )
    )
    ORDER BY (c.base_name = btrim(lower(v_query))) DESC, c.match_rank, char_length(c.base_name) DESC, c.entity_id
    LIMIT 3
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

-- CREATE OR REPLACE preserva o ACL; reafirma o acesso restrito da função.
REVOKE ALL ON FUNCTION public.chat_context(text[], text, integer, integer) FROM PUBLIC;

DO $revoke_api$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.chat_context(text[], text, integer, integer) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.chat_context(text[], text, integer, integer) FROM authenticated';
  END IF;
END
$revoke_api$;

GRANT EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) TO atlas_reader, service_role;

INSERT INTO schema_migrations (version, name)
VALUES ('005', 'Chat context free-text entity matching')
ON CONFLICT (version) DO NOTHING;
