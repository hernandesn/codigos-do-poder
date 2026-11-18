-- Busca temática e caminhos documentados de até dois saltos, sem extensões.
-- IDs explícitos preservam o recorte e a ordenação da 005.
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
  WITH RECURSIVE requested AS (
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
  -- The lists mirror cleanContextQuery in chat_core.ts. Generic words may
  -- improve a score, but cannot select an entity without a distinctive token.
  query_words AS (
    SELECT DISTINCT CASE WHEN word ~ '^[3-9][0-9]$' THEN '19' || word ELSE word END AS word
    FROM regexp_split_to_table(regexp_replace(translate(lower(v_query),
      'áàâãäåéèêëíìîïóòôõöúùûüçñýÿ', 'aaaaaaeeeeiiiiooooouuuucnyy'),
      '[^a-z0-9 ]', ' ', 'g'), ' +') word
    WHERE NOT v_has_ids AND word <> '' AND word <> ALL (ARRAY[
      'que', 'quem', 'qual', 'quais', 'o', 'a', 'os', 'as', 'um', 'uma',
      'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
      'entre', 'sobre', 'fale', 'falar', 'me', 'conte', 'relacao', 'relacoes',
      'ligacao', 'ligacoes', 'com', 'para', 'por', 'foi', 'era', 'eh', 'sao',
      'quando', 'onde', 'como', 'porque', 'historia'
    ])
  ),
  tokens AS (
    SELECT word, word AS variant FROM query_words
    WHERE length(word) >= 4 OR word ~ '^[0-9]{4}$'
    UNION
    SELECT word, left(word, -1) FROM query_words
    WHERE word ~ '^[a-z]{4,}s$'
  ),
  event_aliases(entity_id, label) AS (
    -- Local dictionary: no dataset writes, no extension or alias-table dependency.
    -- Stopwords and abbreviated years have already been normalized above.
    VALUES ('golpe64', 'golpe 1964'), ('golpe64', 'golpe militar'),
           ('golpe64', 'revolucao 1964'), ('golpe64', 'ditadura militar'),
           ('rockefeller', 'familia rockefeller'), ('rockefeller', 'rockefeller')
  ),
  labels AS (
    SELECT entity_id, normalized_name AS label, false AS alias FROM entities WHERE NOT v_has_ids
    UNION ALL
    SELECT entity_id, split_part(normalized_name, ' · ', 1), false FROM entities
    WHERE NOT v_has_ids AND strpos(normalized_name, ' · ') > 0
    UNION ALL
    SELECT entity_id, normalized_alias, true FROM entity_aliases WHERE NOT v_has_ids
    UNION ALL
    SELECT entity_id, label, true FROM event_aliases WHERE NOT v_has_ids
  ),
  label_words AS (
    SELECT l.*, ARRAY(
      SELECT DISTINCT w FROM regexp_split_to_table(regexp_replace(translate(lower(l.label),
        'áàâãäåéèêëíìîïóòôõöúùûüçñýÿ', 'aaaaaaeeeeiiiiooooouuuucnyy'),
        '[^a-z0-9 ]', ' ', 'g'), ' +') w
      WHERE length(w) >= 4 OR w ~ '^[0-9]{4}$'
      ORDER BY w
    ) AS words
    FROM labels l
  ),
  label_matches AS (
    SELECT l.*, ARRAY(
      SELECT DISTINCT t.word FROM tokens t WHERE t.variant = ANY(l.words) ORDER BY t.word
    ) AS covered
    FROM label_words l
  ),
  candidates AS MATERIALIZED (
    SELECT DISTINCT ON (e.entity_id) e.entity_id, e.canonical_name, e.entity_type, e.research_cluster,
           m.covered,
           lower(v_query) IN (e.normalized_name, split_part(e.normalized_name, ' · ', 1)) AS literal_exact,
           cardinality(m.covered)::numeric / greatest(cardinality(m.words), 1) AS score,
           split_part(e.normalized_name, ' · ', 1) = lower(v_query)
             OR m.words = ARRAY(SELECT word FROM query_words ORDER BY word) AS exact
    FROM label_matches m JOIN entities e USING (entity_id)
    WHERE cardinality(m.covered) > 0
      AND (NOT m.alias OR cardinality(m.covered) >= cardinality(m.words))
      AND (m.alias OR EXISTS (
        SELECT 1 FROM unnest(m.covered) w WHERE w <> ALL (ARRAY[
          'familia', 'banco', 'estado', 'golpe', 'militar', 'revolucao', 'ditadura',
          'fundacao', 'instituto', 'empresa', 'grupo', 'nacional', 'brasil', 'brasileiro', 'politica',
          'tempo', 'previsao', 'amanha', 'ontem', 'hoje'
        ])
      ))
    ORDER BY e.entity_id, exact DESC, score DESC, cardinality(m.covered) DESC
  ),
  candidate_edges AS MATERIALIZED (
    -- One indexed adjacency lookup per candidate; never search beyond two hops.
    SELECT c.entity_id, r.relationship_id,
           CASE WHEN r.source_entity_id = c.entity_id THEN r.target_entity_id
                ELSE r.source_entity_id END AS neighbor
    FROM candidates c
    JOIN relationships r ON r.source_entity_id = c.entity_id OR r.target_entity_id = c.entity_id
  ),
  candidate_links AS (
    SELECT a.entity_id, b.entity_id AS other, 2 AS proximity
    FROM candidate_edges a JOIN candidates b ON b.entity_id = a.neighbor
    UNION
    SELECT a.entity_id, b.entity_id, 1
    FROM candidate_edges a JOIN candidate_edges b ON b.neighbor = a.neighbor
    WHERE a.entity_id <> b.entity_id
  ),
  thematic_links AS MATERIALIZED (
    SELECT l.entity_id, l.other, max(l.proximity) AS proximity
    FROM candidate_links l
    JOIN candidates a ON a.entity_id = l.entity_id
    JOIN candidates b ON b.entity_id = l.other
    WHERE NOT a.covered && b.covered
    GROUP BY l.entity_id, l.other
  ),
  picks(ids, covered) AS (
    SELECT ARRAY[]::text[], ARRAY[]::text[]
    UNION ALL
    SELECT p.ids || c.entity_id, ARRAY(SELECT DISTINCT w FROM unnest(p.covered || c.covered) w)
    FROM picks p
    CROSS JOIN LATERAL (
      SELECT c.* FROM candidates c
      WHERE NOT c.entity_id = ANY(p.ids) AND NOT c.covered <@ p.covered
      -- A case title containing both names must not swallow separate actor themes.
      -- A literal entity name still wins, including an explicitly named case.
      ORDER BY c.literal_exact DESC, (c.entity_type = 'operacao'), c.exact DESC,
        coalesce((SELECT max(l.proximity) FROM thematic_links l
                  WHERE l.entity_id = c.entity_id AND l.other = ANY(p.ids)), 0) DESC,
        c.score DESC,
        (SELECT count(*) FROM unnest(c.covered) w WHERE NOT w = ANY(p.covered)) DESC,
        coalesce((SELECT max(l.proximity) FROM thematic_links l WHERE l.entity_id = c.entity_id), 0) DESC,
        length(c.canonical_name), c.entity_id
      LIMIT 1
    ) c
    WHERE cardinality(p.ids) < 3
  ),
  search_roots AS (
    SELECT c.entity_id, c.canonical_name, c.entity_type, c.research_cluster, u.ord::integer
    FROM (SELECT ids FROM picks ORDER BY cardinality(ids) DESC LIMIT 1) p
    CROSS JOIN LATERAL unnest(p.ids) WITH ORDINALITY u(entity_id, ord)
    JOIN candidates c ON c.entity_id = u.entity_id
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
  root_edges AS (
    SELECT root.entity_id AS root, r.relationship_id,
           CASE WHEN r.source_entity_id = root.entity_id THEN r.target_entity_id
                ELSE r.source_entity_id END AS neighbor
    FROM roots root
    JOIN relationships r ON r.source_entity_id = root.entity_id OR r.target_entity_id = root.entity_id
    WHERE NOT v_has_ids
  ),
  root_paths AS (
    SELECT a.root AS de, b.entity_id AS para, NULL::text AS via,
           ARRAY[a.relationship_id] AS relacoes
    FROM root_edges a JOIN roots b ON b.entity_id = a.neighbor
    WHERE a.root < b.entity_id
    UNION ALL
    SELECT a.root, b.root, a.neighbor, ARRAY[a.relationship_id, b.relationship_id]
    FROM root_edges a JOIN root_edges b ON b.neighbor = a.neighbor
    WHERE a.root < b.root AND a.neighbor NOT IN (SELECT entity_id FROM roots)
  ),
  path_relations AS (
    SELECT DISTINCT unnest(relacoes) AS relationship_id FROM root_paths
  ),
  ranked AS (
    SELECT rel.*,
           row_number() OVER (
             ORDER BY CASE WHEN rel.relationship_id IN (SELECT relationship_id FROM path_relations) THEN 0 ELSE 1 END,
                      rel.grau,
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
      ) ORDER BY d.grau,
        CASE WHEN e.entity_id IN (SELECT via FROM root_paths) THEN 0 ELSE 1 END,
        e.canonical_name, e.entity_id)
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
    'ligacoes_entre_raizes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('de', p.de, 'para', p.para,
        'via', p.via, 'relacoes', p.relacoes) ORDER BY p.de, p.para, p.via, p.relacoes)
      FROM (
        -- One complete representative per pair (at most three): parallel edges
        -- must not multiply the prompt's path metadata. All path edges still rank first.
        SELECT DISTINCT ON (de, para) * FROM root_paths
        WHERE relacoes <@ ARRAY(SELECT relationship_id FROM chosen)
        ORDER BY de, para, (via IS NOT NULL), relacoes
      ) p
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
VALUES ('008', 'Chat context thematic matching and two-hop root connections')
ON CONFLICT (version) DO NOTHING;
