-- Read-only acceptance, as atlas_reader, inside the runner's transaction.
CREATE TEMP TABLE spec3_timings (
  ordinal integer GENERATED ALWAYS AS IDENTITY,
  label text NOT NULL,
  elapsed_ms numeric NOT NULL
);
CREATE FUNCTION pg_temp.timed_context(label text, ids text[] DEFAULT '{}',
  q text DEFAULT NULL, rel_cap integer DEFAULT 60, src_cap integer DEFAULT 40)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz := clock_timestamp();
  context jsonb;
  elapsed numeric;
BEGIN
  context := public.chat_context(ids, q, rel_cap, src_cap);
  elapsed := extract(epoch FROM clock_timestamp() - started) * 1000;
  INSERT INTO spec3_timings(label, elapsed_ms) VALUES (label, elapsed);
  ASSERT elapsed < 500, format('%s levou %s ms (limite 500 ms)', label, elapsed);
  RETURN context;
END $$;

DO $$
DECLARE
  q text;
  context jsonb;
  first_ids text[];
  link jsonb;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    'qual a relação dos Rockefeller com o golpe de 64',
    'qual a relacao dos Rockefeller com o golpe de 64',
    'qual a relação dos Rockefellers com o golpe de 64',
    'qual a relação dos Rockefeller com o golpe de 1964',
    'qual a relação dos Rockefeller com o golpe militar',
    'qual a relação dos Rockefeller com a revolução de 64',
    'qual a relação dos Rockefeller com a ditadura militar'
  ] LOOP
    context := pg_temp.timed_context(q, q => q);
    ASSERT context->'raizes' @> '[{"id":"golpe64"},{"id":"david_r"}]',
      format('temas ausentes em %s: %s', q, context->'raizes');
    ASSERT jsonb_array_length(context->'raizes') BETWEEN 2 AND 3, 'teto de raízes';
    ASSERT jsonb_array_length(context->'ligacoes_entre_raizes') > 0, 'sem caminhos';
    ASSERT context->'ligacoes_entre_raizes' @> '[{"via":"ipes"}]', 'intermediário IPES ausente';
    ASSERT context->'entidades' @> '[{"id":"ipes"}]', 'IPES fora do recorte';
    SELECT array_agg(r->>'id') INTO first_ids
      FROM jsonb_array_elements(context->'relacoes') WITH ORDINALITY t(r, n) WHERE n <= 3;
    ASSERT 'E219' = ANY(first_ids), format('E219 não prioritária: %s', first_ids);
    ASSERT 'PR4-E017' = ANY(first_ids) OR 'PR4-E018' = ANY(first_ids), 'contato/carta não prioritária';
    FOR link IN SELECT value FROM jsonb_array_elements(context->'ligacoes_entre_raizes') LOOP
      ASSERT NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(link->'relacoes') id
        WHERE NOT context->'relacoes' @> jsonb_build_array(jsonb_build_object('id', id))
      ), 'caminho cita relação ausente';
    END LOOP;
    ASSERT context->'fontes'->0->>'id' IN (
      SELECT jsonb_array_elements_text(r->'fontes')
      FROM jsonb_array_elements(context->'relacoes') WITH ORDINALITY t(r,n) WHERE n <= 3
    ), 'primeira fonte não documenta os caminhos prioritários';
  END LOOP;
END $$;

DO $$
DECLARE
  fixture record;
  context jsonb;
BEGIN
  FOR fixture IN SELECT * FROM (VALUES
    ('quem e walther moreira salles?', 'walther_ms'),
    ('walther moreira salles', 'walther_ms'),
    ('quem foi heitor lyra', 'heitor_lyra'),
    ('o que e o banco moreira salles', 'banco_moreira_salles'),
    ('rothschild', 'rothschild'),
    ('fale sobre a familia rothschild', 'rothschild'),
    ('familia rockefeller', 'rockefeller'),
    ('os rockefeller', 'rockefeller')
  ) t(q, id) LOOP
    context := pg_temp.timed_context(fixture.q, q => fixture.q);
    ASSERT context->'raizes' @> jsonb_build_array(jsonb_build_object('id', fixture.id)),
      format('raiz %s ausente: %s', fixture.id, context->'raizes');
    ASSERT context->'raizes'->0->>'id' = fixture.id, format('melhor nome/exato deve vir primeiro em %s: %s', fixture.q, context->'raizes');
  END LOOP;
  context := pg_temp.timed_context('ano no sufixo', q => '1964');
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(context->'raizes') r
    WHERE r->>'nome' LIKE '%1964%'), 'ano não casou com o nome completo';
  context := pg_temp.timed_context('soros e rothschild', q => 'qual a relacao entre soros e rothschild?');
  ASSERT context->'raizes' @> '[{"id":"rothschild"}]', format('tema Rothschild ausente: %s', context->'raizes');
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(context->'raizes') r
    WHERE r->>'id' IN ('george_soros', 'soros', 'alex_soros')), 'tema Soros ausente';
  ASSERT jsonb_array_length(context->'raizes') BETWEEN 2 AND 3, 'temas diversos';
  ASSERT (SELECT count(*) = count(DISTINCT r->>'id')
    FROM jsonb_array_elements(context->'raizes') r), 'raízes repetidas';
END $$;

DO $$
DECLARE q text; context jsonb;
BEGIN
  FOREACH q IN ARRAY ARRAY['qual a receita de bolo de cenoura', 'asdf qwer',
    'me conte uma piada', 'qual a previsao do tempo amanha', 'banco estado familia',
    'rockefellerxyz', '', 'x''; DROP TABLE entities; --'] LOOP
    context := pg_temp.timed_context('ruído: ' || q, q => q);
    ASSERT context->'raizes' = '[]',
      format('ruído selecionou entidade: %s: %s', q, context->'raizes');
  END LOOP;
END $$;

DO $$
DECLARE fixture record;
BEGIN
  FOR fixture IN SELECT * FROM spec3_explicit_before LOOP
    ASSERT pg_temp.timed_context('ids: ' || fixture.ids::text, fixture.ids, fixture.q,
      fixture.rel_cap, fixture.src_cap) - 'ligacoes_entre_raizes' = fixture.context,
      'caminho explícito difere do resultado da 005';
  END LOOP;
END $$;

DO $$
DECLARE context jsonb;
BEGIN
  context := pg_temp.timed_context('ligação direta', q => 'david rockefeller e jacob rothschild');
  ASSERT context->'ligacoes_entre_raizes' @> '[{"via":null,"relacoes":["E003"]}]', 'ligação direta ausente';
  context := pg_temp.timed_context('temas sem ligação', q => 'heitor lyra e golpe de 64');
  ASSERT context->'raizes' @> '[{"id":"heitor_lyra"},{"id":"golpe64"}]', 'temas sem ligação ausentes';
  ASSERT context->'ligacoes_entre_raizes' = '[]', 'não inventar caminho';
  context := pg_temp.timed_context('três temas', q => 'rockefeller e golpe de 64 e heitor lyra');
  ASSERT context->'raizes' @> '[{"id":"golpe64"},{"id":"david_r"},{"id":"heitor_lyra"}]', 'três temas não cobertos';
  ASSERT jsonb_array_length(context->'raizes') = 3, 'máximo de três temas';
  context := pg_temp.timed_context('limites pequenos', q => 'rockefeller e golpe de 64', rel_cap => 2, src_cap => 1);
  ASSERT jsonb_array_length(context->'relacoes') = 2, 'limite de relações';
  ASSERT jsonb_array_length(context->'fontes') = 1, 'limite de fontes';
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(context->'ligacoes_entre_raizes') l,
      jsonb_array_elements_text(l->'relacoes') id
    WHERE NOT context->'relacoes' @> jsonb_build_array(jsonb_build_object('id',id))
  ), 'limite deixou caminho incompleto';
  ASSERT (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=public', 'statement_timeout=3s']
    FROM pg_proc WHERE oid = 'public.chat_context(text[],text,integer,integer)'::regprocedure), 'configuração de segurança';
  ASSERT has_function_privilege('atlas_reader', 'public.chat_context(text[],text,integer,integer)', 'EXECUTE'), 'grant atlas_reader';
  ASSERT has_function_privilege('service_role', 'public.chat_context(text[],text,integer,integer)', 'EXECUTE'), 'grant service_role';
  ASSERT NOT has_function_privilege('anon', 'public.chat_context(text[],text,integer,integer)', 'EXECUTE'), 'anon executa';
  ASSERT NOT has_function_privilege('authenticated', 'public.chat_context(text[],text,integer,integer)', 'EXECUTE'), 'authenticated executa';
END $$;
