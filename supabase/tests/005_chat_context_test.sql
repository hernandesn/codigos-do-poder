-- Aceitação após a migração 005; executar dentro de BEGIN ... ROLLBACK.
-- Somente leitura, usando as entidades já presentes na base do atlas.

DO $$
DECLARE
  context jsonb := public.chat_context('{}'::text[], 'quem e walther moreira salles?');
BEGIN
  ASSERT jsonb_array_length(context->'raizes') >= 1, 'pergunta sobre Walther sem raízes';
  ASSERT context->'raizes' @> '[{"id":"walther_ms"}]'::jsonb, 'Walther não foi selecionado';
END $$;

DO $$
DECLARE
  context jsonb := public.chat_context('{}'::text[], 'fale sobre a familia rothschild');
BEGIN
  ASSERT jsonb_array_length(context->'raizes') >= 1, 'família Rothschild sem raízes';
END $$;

DO $$
DECLARE
  context jsonb := public.chat_context('{}'::text[], 'qual a relacao entre soros e rothschild?');
BEGIN
  ASSERT jsonb_array_length(context->'raizes') BETWEEN 1 AND 3, 'relação Soros/Rothschild sem raízes ou acima do teto';
  ASSERT (
    SELECT count(*) = count(DISTINCT root->>'id')
    FROM jsonb_array_elements(context->'raizes') root
  ), 'raízes repetidas';
END $$;

DO $$
DECLARE
  context jsonb := public.chat_context('{}'::text[], 'o que e o banco moreira salles');
BEGIN
  ASSERT jsonb_array_length(context->'raizes') >= 1, 'Banco Moreira Salles sem raízes';
  ASSERT context->'raizes' @> '[{"id":"banco_ms"}]'::jsonb
      OR context->'raizes' @> '[{"id":"banco_moreira_salles"}]'::jsonb,
    'Banco Moreira Salles não foi selecionado';
END $$;

DO $$
DECLARE
  context jsonb := public.chat_context('{}'::text[], 'walther moreira salles');
BEGIN
  ASSERT jsonb_array_length(context->'raizes') >= 1, 'busca nominal sem raízes';
  ASSERT context->'raizes' @> '[{"id":"walther_ms"}]'::jsonb, 'busca nominal perdeu Walther';
END $$;

DO $$
BEGIN
  ASSERT jsonb_array_length(
    public.chat_context('{}'::text[], 'qual a previsao do tempo amanha')->'raizes'
  ) = 0, 'ruído selecionou uma entidade';
END $$;

DO $$
DECLARE
  roots jsonb := public.chat_context(ARRAY['walther_ms'], NULL)->'raizes';
  expected jsonb;
BEGIN
  SELECT jsonb_build_array(jsonb_build_object(
    'id', entity_id, 'nome', canonical_name, 'tipo', entity_type, 'cluster', research_cluster
  )) INTO expected
  FROM public.entities WHERE entity_id = 'walther_ms';

  ASSERT expected IS NOT NULL, 'fixture walther_ms ausente';
  ASSERT roots = expected, 'raízes explícitas alteradas';
  ASSERT public.chat_context(ARRAY['walther_ms'], 'qual a relacao entre soros e rothschild?')->'raizes' = roots,
    'query interferiu no caminho de ids explícitos';
END $$;
