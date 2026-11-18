-- Prova local da 014. Roda como superusuário do PGlite, depois o harness troca de papel.
-- Sandbox não concede plano. trial_ja_usado recusa quem já teve assinatura neste ambiente.

CREATE FUNCTION pg_temp.ev(
  ambiente text, event_id text, tipo text, recurso text, sub text, cus text,
  chk text, ref text, valor numeric, venc date, nxt date, quando timestamptz
) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT chat_private.asaas_aplicar_evento(
    ambiente, event_id, tipo, recurso, sub, cus, chk, ref, valor, venc, nxt, quando
  );
$$;

DO $t$
DECLARE
  u_free uuid := '11111111-1111-4111-8111-111111111111';
  u_sand uuid := '22222222-2222-4222-8222-222222222222';
  u_plus uuid := '33333333-3333-4333-8333-333333333333';
  u_trial uuid := '44444444-4444-4444-8444-444444444444';
  u_jan uuid := '55555555-5555-4555-8555-555555555555';
  u_flow uuid := '66666666-6666-4666-8666-666666666666';
  u_div uuid := '77777777-7777-4777-8777-777777777777';
  u_cross uuid := '99999999-9999-4999-8999-999999999999';
  u_null uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  u_prep uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  u_desc uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  u_can uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  u_both uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  u_inad uuid := 'abababab-abab-4aba-8aba-abababababab';
  u_solic uuid := 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
  u_exp uuid := 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
  u_known uuid := 'dededede-dede-4ded-8ded-dededededede';
  u_texp uuid := 'efefefef-efef-4efe-8efe-efefefefefef';
  u_ativa uuid := '12121212-1212-4121-8121-121212121212';
  u_hist uuid := '13131313-1313-4131-8131-131313131313';
  u_leap uuid := '16161616-1616-4161-8161-161616161616';
  u_fora uuid := '18181818-1818-4181-8181-181818181818';
  u_data uuid := '19191919-1919-4191-8191-191919191919';
  u_dia uuid := '20202020-2020-4202-8202-202020202020';
  u_preco uuid := '21212121-2121-4121-8121-212121212121';
  u_curto uuid := '23232323-2323-4232-8232-232323232323';
  u_mantem uuid := '24242424-2424-4242-8242-242424242424';
  u_susp uuid := '25252525-2525-4252-8252-252525252525';
  u_diva uuid := '26262626-2626-4262-8262-262626262626';
  u_incerto uuid := '27272727-2727-4272-8272-272727272727';
  u_rev uuid := '28282828-2828-4282-8282-282828282828';
  u_tcan uuid := '29292929-2929-4292-8292-292929292929';
  u_est uuid := '30303030-3030-4303-8303-303030303030';
  u_env uuid := '31313131-3131-4313-8313-313131313131';
  u_ord uuid := '32323232-3232-4323-8323-323232323232';
  u_ord2 uuid := '34343434-3434-4343-8343-343434343434';
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_fim date;
  v_ini date;
  v jsonb;
  v_id uuid;
  v_id2 uuid;
  v_def text;
  v_prep text;
  v_ped text;
  v_ger bigint;
  v_tent uuid;
  n integer;
  pago date;
  q0 timestamptz := timestamptz '2026-11-18 08:00:00-03';
  q1 timestamptz := timestamptz '2026-11-18 10:00:00-03';
  q2 timestamptz := timestamptz '2026-11-18 12:00:00-03';
  q3 timestamptz := timestamptz '2026-11-18 13:00:00-03';
  q4 timestamptz := timestamptz '2026-11-18 14:00:00-03';
  q5 timestamptz := timestamptz '2026-11-18 15:00:00-03';
  q6 timestamptz := timestamptz '2026-11-18 16:00:00-03';
  q7 timestamptz := timestamptz '2026-11-18 17:00:00-03';
  q8 timestamptz := timestamptz '2026-11-18 18:00:00-03';
  q9 timestamptz := timestamptz '2026-11-18 19:00:00-03';
  q10 timestamptz := timestamptz '2026-11-18 20:00:00-03';
  q11 timestamptz := timestamptz '2026-11-18 21:00:00-03';
  q12 timestamptz := timestamptz '2026-11-18 22:00:00-03';
BEGIN
  INSERT INTO auth.users (id) VALUES
    (u_free),(u_sand),(u_plus),(u_trial),(u_jan),(u_flow),(u_div),(u_cross),(u_null),
    (u_prep),(u_desc),(u_can),(u_both),(u_inad),(u_solic),(u_exp),(u_known),(u_texp),
    (u_ativa),(u_hist),(u_leap),(u_fora),(u_data),(u_dia),(u_preco),(u_curto),
    (u_mantem),(u_susp),(u_diva),(u_incerto),(u_rev),(u_tcan),(u_est),
    (u_env),(u_ord),(u_ord2);

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'chat_private.assinaturas'::regclass) THEN
    RAISE EXCEPTION 'rls assinaturas';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'chat_private.asaas_clientes'::regclass) THEN
    RAISE EXCEPTION 'rls clientes';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'chat_private.asaas_eventos'::regclass) THEN
    RAISE EXCEPTION 'rls eventos';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'chat_private.asaas_trials'::regclass) THEN
    RAISE EXCEPTION 'rls trials';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'chat_private.asaas_cancelamentos'::regclass) THEN
    RAISE EXCEPTION 'rls cancelamentos';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'chat_private' AND tablename IN ('assinaturas', 'asaas_clientes', 'asaas_eventos', 'asaas_trials', 'asaas_cancelamentos')
  ) THEN RAISE EXCEPTION 'policy indevida'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'chat_private'
      AND table_name IN ('assinaturas', 'asaas_clientes', 'asaas_eventos', 'asaas_trials', 'asaas_cancelamentos')
      AND column_name IN ('payload', 'cpf', 'cnpj', 'cartao', 'email', 'body', 'valor', 'credit_card')
  ) THEN RAISE EXCEPTION 'coluna sensível'; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '014') THEN
    RAISE EXCEPTION 'schema_migrations 014';
  END IF;

  BEGIN
    INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status)
    VALUES ('live', u_free, 'basico', 'checkout');
    RAISE EXCEPTION 'ambiente livre';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status)
    VALUES ('sandbox', u_free, 'avancado', 'checkout');
    RAISE EXCEPTION 'plano avancado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  v_fim := v_hoje + 40;
  v_ini := (v_fim - interval '1 month')::date;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate, trial_ate) VALUES
    ('sandbox', u_sand, 'plus', 'ativa', 'sub_sand', v_hoje + 400, NULL),
    ('producao', u_plus, 'plus', 'ativa', 'sub_plus', v_fim, NULL),
    ('producao', u_trial, 'basico', 'trial', 'sub_trial', NULL, v_hoje),
    ('producao', u_texp, 'basico', 'trial', 'sub_texp', NULL, v_hoje - 1),
    ('sandbox', u_both, 'plus', 'ativa', 'sub_both_s', v_hoje + 400, NULL),
    ('producao', u_both, 'basico', 'ativa', 'sub_both_p', v_fim, NULL),
    ('producao', u_inad, 'plus', 'inadimplente', 'sub_inad', v_hoje + 30, NULL),
    ('producao', u_solic, 'basico', 'cancelamento_solicitado', 'sub_solic', v_fim, NULL),
    ('producao', u_exp, 'plus', 'ativa', 'sub_exp', v_hoje - 1, NULL),
    ('sandbox', u_ativa, 'basico', 'trial', 'sub_ativa', NULL, v_hoje + 7),
    ('sandbox', u_hist, 'basico', 'cancelada', 'sub_hist', v_hoje + 10, v_hoje);

  v := chat_private.plano_atual(u_free);
  IF v->>'plano' IS DISTINCT FROM 'free' OR v->>'status' IS DISTINCT FROM 'free'
     OR (v->>'basico_dia')::int IS DISTINCT FROM 20 OR (v->>'avancado_ciclo')::int IS DISTINCT FROM 0
     OR v->>'ciclo_inicio' IS NOT NULL OR v->>'ciclo_fim' IS NOT NULL
     OR (SELECT count(*) FROM jsonb_object_keys(v)) IS DISTINCT FROM 6
     OR v ? 'teto' THEN
    RAISE EXCEPTION 'free %', v;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k)
     IS DISTINCT FROM ARRAY['avancado_ciclo', 'basico_dia', 'ciclo_fim', 'ciclo_inicio', 'plano', 'status'] THEN
    RAISE EXCEPTION 'chaves %', v;
  END IF;
  v := chat_private.plano_atual(u_sand);
  IF v->>'plano' IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'sandbox concedeu %', v; END IF;
  v := chat_private.plano_atual(u_plus);
  IF v->>'plano' IS DISTINCT FROM 'plus' OR v->>'status' IS DISTINCT FROM 'ativa'
     OR (v->>'basico_dia')::int IS DISTINCT FROM 150 OR (v->>'avancado_ciclo')::int IS DISTINCT FROM 100
     OR v->>'ciclo_fim' IS DISTINCT FROM to_char(v_fim, 'YYYY-MM-DD')
     OR v->>'ciclo_inicio' IS DISTINCT FROM to_char(v_ini, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'plus % inicio % fim %', v, v_ini, v_fim;
  END IF;
  v := chat_private.plano_atual(u_trial);
  IF v->>'plano' IS DISTINCT FROM 'basico' OR (v->>'basico_dia')::int IS DISTINCT FROM 150
     OR (v->>'avancado_ciclo')::int IS DISTINCT FROM 20
     OR v->>'ciclo_fim' IS DISTINCT FROM to_char(v_hoje, 'YYYY-MM-DD')
     OR v->>'ciclo_inicio' IS DISTINCT FROM to_char(v_hoje - 7, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'trial %', v;
  END IF;
  IF (chat_private.plano_atual(u_texp)->>'plano') IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'trial vencido'; END IF;
  IF (chat_private.plano_atual(u_inad)->>'plano') IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'inadimplente'; END IF;
  IF (chat_private.plano_atual(u_exp)->>'plano') IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'expirada'; END IF;
  v := chat_private.plano_atual(u_both);
  IF v->>'plano' IS DISTINCT FROM 'basico' OR (v->>'avancado_ciclo')::int IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'mistura %', v;
  END IF;
  v := chat_private.plano_atual(u_solic);
  IF v->>'plano' IS DISTINCT FROM 'basico' OR v->>'status' IS DISTINCT FROM 'cancelamento_solicitado'
     OR (v->>'basico_dia')::int IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION 'solicitado %', v;
  END IF;

  PERFORM chat_private.asaas_gravar_cliente('producao', u_jan, 'cus_jan31');
  v := pg_temp.ev('producao', 'evt_jan31', 'PAYMENT_CONFIRMED', 'pay_jan31', 'sub_jan31', 'cus_jan31', NULL, NULL, 9.90, DATE '2026-01-31', NULL, timestamptz '2026-02-01 12:00:00-03');
  IF (v->>'aplicado')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'jan aplicado %', v; END IF;
  IF (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_jan31') IS DISTINCT FROM DATE '2026-02-28' THEN
    RAISE EXCEPTION 'jan31 %', (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_jan31');
  END IF;
  IF (chat_private.plano_atual(u_jan)->>'plano') IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'jan concedeu'; END IF;

  PERFORM chat_private.asaas_gravar_cliente('producao', u_leap, 'cus_leap16');
  PERFORM pg_temp.ev('producao', 'evt_leap', 'PAYMENT_RECEIVED', 'pay_leap', 'sub_leap', 'cus_leap16', NULL, NULL, 29.90, DATE '2024-01-31', NULL, timestamptz '2024-02-01 12:00:00-03');
  IF (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_leap') IS DISTINCT FROM DATE '2024-02-29' THEN
    RAISE EXCEPTION 'bissexto %', (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_leap');
  END IF;
  IF (SELECT plano FROM chat_private.assinaturas WHERE subscription_id = 'sub_leap') IS DISTINCT FROM 'plus' THEN
    RAISE EXCEPTION 'plus pelo valor';
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'livre');
  IF v->>'code' IS DISTINCT FROM 'plano_invalido' OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 0 THEN
    RAISE EXCEPTION 'plano invalido %', v;
  END IF;
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'basico');
  IF (v->>'ok')::boolean IS NOT TRUE OR (v->>'reutilizado')::boolean THEN RAISE EXCEPTION 'prep %', v; END IF;
  v_id := (v->>'assinatura_id')::uuid;
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'plus');
  IF v->>'code' IS DISTINCT FROM 'checkout_em_andamento' THEN RAISE EXCEPTION 'andamento %', v; END IF;
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 1 THEN RAISE EXCEPTION 'andamento apagou'; END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '3 minutes' WHERE id = v_id;
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'plus');
  IF v->>'code' IS DISTINCT FROM 'checkout_em_andamento'
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 1
     OR (SELECT id FROM chat_private.assinaturas WHERE user_id = u_prep) IS DISTINCT FROM v_id
     OR (SELECT plano FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'basico' THEN
    RAISE EXCEPTION 'janela 3 min %', v;
  END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '61 minutes' WHERE id = v_id;
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'plus');
  IF (v->>'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'stale %', v; END IF;
  v_id2 := (v->>'assinatura_id')::uuid;
  IF v_id2 = v_id OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 1 THEN
    RAISE EXCEPTION 'stale nao trocou';
  END IF;
  IF (SELECT plano FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'plus' THEN RAISE EXCEPTION 'plano plus'; END IF;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_prep, v_id2, 'chk_reuso');
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'basico');
  IF (v->>'reutilizado')::boolean IS NOT TRUE OR (v->>'assinatura_id')::uuid IS DISTINCT FROM v_id2
     OR v->>'checkout_id' IS DISTINCT FROM 'chk_reuso' THEN
    RAISE EXCEPTION 'reuso %', v;
  END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '61 minutes' WHERE id = v_id2;
  v := chat_private.asaas_preparar_checkout('sandbox', u_prep, 'basico');
  IF v->>'code' IS DISTINCT FROM 'reconciliar' OR (v->>'assinatura_id')::uuid IS DISTINCT FROM v_id2
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 1
     OR (SELECT checkout_id FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'chk_reuso'
     OR (SELECT reserva FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'expirada' THEN
    RAISE EXCEPTION 'reuso velho %', v;
  END IF;
  v_ger := (v->>'geracao')::bigint;
  v := chat_private.asaas_liberar_checkout('sandbox', u_prep, 'basico', NULL, v_ger);
  IF (v->>'ok')::boolean IS NOT TRUE OR (v->>'assinatura_id')::uuid = v_id2
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_prep) <> 2
     OR (SELECT checkout_id FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'chk_reuso' THEN
    RAISE EXCEPTION 'liberar apos expirar %', v;
  END IF;
  v_id := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_prep, v_id, 'chk_prep');
  PERFORM chat_private.asaas_descartar_checkout('sandbox', u_prep, v_id);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE id = v_id) <> 1 THEN RAISE EXCEPTION 'descartou vinculado'; END IF;
  PERFORM chat_private.asaas_vincular_assinatura_remota('sandbox', u_prep, v_id2, 'sub_prep_remota');
  IF (SELECT recorrencia FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'ativa'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id2) IS NOT NULL
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id2) IS NOT NULL
     OR (SELECT bloqueio FROM chat_private.assinaturas WHERE id = v_id2) IS NOT NULL
     OR (chat_private.asaas_status('sandbox', u_prep)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'vinculo remoto concedeu';
  END IF;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_prep, 'basico')->>'code') IS DISTINCT FROM 'assinatura_ativa' THEN
    RAISE EXCEPTION 'remota nao bloqueou checkout';
  END IF;
  BEGIN
    PERFORM chat_private.asaas_vincular_checkout('sandbox', u_free, v_id, 'chk_alheio');
    RAISE EXCEPTION 'vincular alheio';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  v := chat_private.asaas_preparar_checkout('sandbox', u_desc, 'basico');
  PERFORM chat_private.asaas_descartar_checkout('sandbox', u_desc, (v->>'assinatura_id')::uuid);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_desc) <> 0 THEN RAISE EXCEPTION 'descarte'; END IF;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_desc, 'basico')->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'descarte queimou trial';
  END IF;

  IF (chat_private.asaas_preparar_checkout('sandbox', u_ativa, 'basico')->>'code') IS DISTINCT FROM 'assinatura_ativa' THEN
    RAISE EXCEPTION 'ativa';
  END IF;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_hist, 'basico')->>'code') IS DISTINCT FROM 'trial_ja_usado' THEN
    RAISE EXCEPTION 'historico';
  END IF;

  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_flow, 'cus_flow666');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_flow, 'cus_outro999');
  IF chat_private.asaas_obter_cliente('sandbox', u_flow) IS DISTINCT FROM 'cus_flow666' THEN
    RAISE EXCEPTION 'cliente primeiro';
  END IF;
  BEGIN
    PERFORM chat_private.asaas_gravar_cliente('sandbox', u_free, 'cus_flow666');
    RAISE EXCEPTION 'customer duplicado';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF chat_private.asaas_obter_cliente('sandbox', u_free) IS NOT NULL THEN RAISE EXCEPTION 'cliente alheio'; END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_flow, 'basico', DATE '2026-11-25');
  v_id := (v->>'assinatura_id')::uuid;
  IF (SELECT preco_centavos FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 990
     OR (SELECT next_due_planejado FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM DATE '2026-11-25' THEN
    RAISE EXCEPTION 'preco planejado';
  END IF;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_flow, v_id, 'chk_flow1');
  v := pg_temp.ev('sandbox', 'evt_05b708f961d739ea7eba7e4db318f621&36818395', 'SUBSCRIPTION_CREATED', 'sub_flow1', 'sub_flow1', 'cus_flow666', 'chk_flow1', v_id::text, 9.90, NULL, DATE '2026-11-25', q1);
  IF (v->>'aplicado')::boolean IS NOT TRUE OR (v->>'duplicado')::boolean THEN RAISE EXCEPTION 'created %', v; END IF;
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'trial'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM DATE '2026-11-25'
     OR (SELECT subscription_id FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'sub_flow1'
     OR (SELECT count(*) FROM chat_private.asaas_trials WHERE ambiente = 'sandbox' AND user_id = u_flow) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'trial flow';
  END IF;
  v := pg_temp.ev('sandbox', 'evt_05b708f961d739ea7eba7e4db318f621&36818395', 'PAYMENT_CONFIRMED', 'pay_x', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q2);
  IF (v->>'duplicado')::boolean IS NOT TRUE OR (v->>'aplicado')::boolean THEN RAISE EXCEPTION 'duplicado %', v; END IF;
  IF (SELECT count(*) FROM chat_private.asaas_eventos WHERE event_id LIKE 'evt_05b708f961d739ea7eba7e4db318f621%') <> 1 THEN
    RAISE EXCEPTION 'evento unico';
  END IF;
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'trial' THEN RAISE EXCEPTION 'duplicado aplicou'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_old', 'PAYMENT_OVERDUE', 'pay_old', 'sub_flow1', 'cus_flow666', NULL, NULL, NULL, NULL, NULL, q0);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'trial' THEN RAISE EXCEPTION 'regressao trial'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_pay', 'PAYMENT_CONFIRMED', 'pay_flow', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q2);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'ativa'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM DATE '2027-01-18'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM DATE '2026-11-25' THEN
    RAISE EXCEPTION 'paga %', (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id);
  END IF;
  pago := (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id);
  PERFORM pg_temp.ev('sandbox', 'evt_flow_old2', 'PAYMENT_OVERDUE', 'pay_old2', 'sub_flow1', 'cus_flow666', NULL, NULL, NULL, NULL, NULL, q1);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'ativa' THEN RAISE EXCEPTION 'regressao ativa'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_over', 'PAYMENT_OVERDUE', 'pay_over', 'sub_flow1', 'cus_flow666', NULL, NULL, NULL, NULL, NULL, q3);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'inadimplente'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM pago THEN
    RAISE EXCEPTION 'overdue';
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_back', 'PAYMENT_RECEIVED', 'pay_back', 'sub_flow1', 'cus_flow666', NULL, NULL, '9.90', DATE '2026-12-18', NULL, q4);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'ativa' THEN RAISE EXCEPTION 'received'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_refused', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'pay_refused', 'sub_flow1', 'cus_flow666', NULL, NULL, NULL, NULL, NULL, q5);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'inadimplente' THEN RAISE EXCEPTION 'refused'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_back2', 'PAYMENT_CONFIRMED', 'pay_back2', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q6);
  PERFORM pg_temp.ev('sandbox', 'evt_flow_refund', 'PAYMENT_REFUNDED', 'pay_refund', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, NULL, NULL, q7);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'suspensa' THEN RAISE EXCEPTION 'refund'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_back3', 'PAYMENT_CONFIRMED', 'pay_back3', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q8);
  PERFORM pg_temp.ev('sandbox', 'evt_flow_cb', 'PAYMENT_CHARGEBACK_REQUESTED', 'pay_cb', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, NULL, NULL, q9);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'suspensa' THEN RAISE EXCEPTION 'chargeback'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_back4', 'PAYMENT_CONFIRMED', 'pay_back4', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q10);
  PERFORM pg_temp.ev('sandbox', 'evt_flow_off', 'SUBSCRIPTION_INACTIVATED', 'sub_flow1', 'sub_flow1', 'cus_flow666', NULL, NULL, NULL, NULL, NULL, q11);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'cancelada' THEN RAISE EXCEPTION 'inactivated'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_flow_late', 'PAYMENT_CONFIRMED', 'pay_late', 'sub_flow1', 'cus_flow666', NULL, NULL, 9.90, DATE '2027-02-18', NULL, q12);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'cancelada'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM pago THEN
    RAISE EXCEPTION 'terminal';
  END IF;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_flow, 'basico')->>'code') IS DISTINCT FROM 'trial_ja_usado' THEN
    RAISE EXCEPTION 'trial apos cancelar';
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_div, 'plus');
  v_id := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_div, 'cus_div777');
  PERFORM pg_temp.ev('sandbox', 'evt_div_ruim', 'PAYMENT_CONFIRMED', 'pay_div1', 'sub_div', 'cus_div777', NULL, v_id::text, 9.90, DATE '2026-12-18', NULL, q2);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'divergente' THEN RAISE EXCEPTION 'divergente'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_div_velho', 'PAYMENT_CONFIRMED', 'pay_div0', 'sub_div', 'cus_div777', NULL, NULL, 29.90, DATE '2026-12-18', NULL, q1);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'divergente' THEN RAISE EXCEPTION 'divergente regressao'; END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_div_ok', 'PAYMENT_CONFIRMED', 'pay_div2', 'sub_div', 'cus_div777', NULL, NULL, 29.90, DATE '2026-12-18', NULL, q4);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'ativa'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM DATE '2027-01-18' THEN
    RAISE EXCEPTION 'divergente recuperou';
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_div_null', 'PAYMENT_CONFIRMED', 'pay_div3', 'sub_div', 'cus_div777', NULL, NULL, NULL, DATE '2026-12-18', NULL, q6);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'divergente' THEN RAISE EXCEPTION 'valor ausente'; END IF;

  v := pg_temp.ev('sandbox', 'evt_ninguem', 'PAYMENT_CONFIRMED', 'pay_ninguem', 'sub_ninguem', 'cus_ninguem', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q2);
  IF (v->>'sem_cliente')::boolean IS NOT TRUE OR (v->>'aplicado')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'desconhecido %', v; END IF;
  IF EXISTS (SELECT 1 FROM chat_private.assinaturas WHERE subscription_id = 'sub_ninguem')
     OR EXISTS (SELECT 1 FROM chat_private.asaas_clientes WHERE customer_id = 'cus_ninguem') THEN
    RAISE EXCEPTION 'criou usuario';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_private.asaas_eventos WHERE event_id = 'evt_ninguem' AND ambiente = 'sandbox') THEN
    RAISE EXCEPTION 'evento desconhecido nao gravou';
  END IF;

  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_known, 'cus_known13');
  v := chat_private.asaas_preparar_checkout('sandbox', u_known, 'basico', DATE '2026-12-01');
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_known, v_id2, 'chk_known');
  v := pg_temp.ev('sandbox', 'evt_known', 'CHECKOUT_PAID', 'chk_known', 'sub_known', 'cus_known13', 'chk_known', NULL, 9.90, NULL, DATE '2026-12-01', q1);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_known) IS DISTINCT FROM 'trial'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE user_id = u_known) IS DISTINCT FROM DATE '2026-12-01' THEN
    RAISE EXCEPTION 'checkout paid';
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_known_del', 'SUBSCRIPTION_DELETED', 'sub_known', 'sub_known', 'cus_known13', NULL, NULL, NULL, NULL, NULL, q6);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_known) IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'deleted';
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_known_late', 'PAYMENT_RECEIVED', 'pay_known', 'sub_known', 'cus_known13', NULL, NULL, 9.90, DATE '2027-01-01', NULL, q12);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_known) IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'deleted terminal';
  END IF;

  PERFORM pg_temp.ev('sandbox', 'evt_ping', 'PAYMENT_CREATED', NULL, NULL, NULL, NULL, v_id::text, NULL, NULL, NULL, q8);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'divergente' THEN
    RAISE EXCEPTION 'evento desconhecido mudou';
  END IF;
  v := pg_temp.ev('sandbox', 'evt ruim', 'PAYMENT_CREATED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, q8);
  IF v->>'erro' IS DISTINCT FROM 'pedido_invalido' THEN RAISE EXCEPTION 'id invalido %', v; END IF;
  IF EXISTS (SELECT 1 FROM chat_private.asaas_eventos WHERE event_id = 'evt ruim') THEN RAISE EXCEPTION 'id invalido gravou'; END IF;

  v := pg_temp.ev('sandbox', 'evt_cross&1', 'PING', NULL, NULL, 'cus_ninguem2', NULL, NULL, NULL, NULL, NULL, q1);
  IF (v->>'aplicado')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'cross s %', v; END IF;
  v := pg_temp.ev('producao', 'evt_cross&1', 'PING', NULL, NULL, 'cus_ninguem2', NULL, NULL, NULL, NULL, NULL, q1);
  IF (v->>'aplicado')::boolean IS NOT TRUE OR (v->>'duplicado')::boolean THEN RAISE EXCEPTION 'cross p %', v; END IF;
  v := pg_temp.ev('sandbox', 'evt_cross&1', 'PING', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, q2);
  IF (v->>'duplicado')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'cross dup %', v; END IF;
  IF (SELECT count(*) FROM chat_private.asaas_eventos WHERE event_id = 'evt_cross&1') <> 2 THEN
    RAISE EXCEPTION 'cross contagem';
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status)
  VALUES ('sandbox', u_null, 'basico', 'checkout'), ('sandbox', u_null, 'plus', 'checkout');
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_null AND subscription_id IS NULL AND checkout_id IS NULL) <> 2 THEN
    RAISE EXCEPTION 'nulos unicos';
  END IF;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id)
  VALUES ('sandbox', u_null, 'basico', 'ativa', 'sub_null_1'), ('producao', u_null, 'basico', 'ativa', 'sub_null_1');
  BEGIN
    INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id)
    VALUES ('sandbox', u_null, 'plus', 'ativa', 'sub_null_1');
    RAISE EXCEPTION 'sub duplicada';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  v := chat_private.asaas_pedir_cancelamento('sandbox', u_free);
  IF (v->>'ok')::boolean OR v->>'code' IS DISTINCT FROM 'sem_assinatura' THEN RAISE EXCEPTION 'sem assinatura %', v; END IF;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate, trial_ate)
  VALUES ('sandbox', u_can, 'basico', 'ativa', 'sub_can', DATE '2027-03-18', DATE '2026-11-25');
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_can);
  IF (v->>'ok')::boolean IS NOT TRUE OR (v->>'ja')::boolean OR v->>'subscription_id' IS DISTINCT FROM 'sub_can'
     OR v->>'acesso_ate' IS DISTINCT FROM '2027-03-18'
     OR v->>'status' IS DISTINCT FROM 'cancelamento_solicitado'
     OR v->>'status_anterior' IS DISTINCT FROM 'ativa'
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM 'cancelamento_solicitado' THEN
    RAISE EXCEPTION 'pedir %', v;
  END IF;
  v_tent := (v->>'tentativa_id')::uuid;
  PERFORM chat_private.asaas_marcar_cancelamento('sandbox', u_can, 'sub_can', v_tent);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM 'cancelamento_solicitado'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM DATE '2027-03-18'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM DATE '2026-11-25' THEN
    RAISE EXCEPTION 'marcou e apagou acesso';
  END IF;
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_can);
  IF (v->>'ja')::boolean IS NOT TRUE OR v->>'status' IS DISTINCT FROM 'cancelamento_solicitado' THEN
    RAISE EXCEPTION 'ja %', v;
  END IF;
  v := chat_private.asaas_status('sandbox', u_can);
  IF v->>'status' IS DISTINCT FROM 'cancelamento_solicitado' OR (v->>'pode_cancelar')::boolean
     OR (v->>'pode_tentar_de_novo')::boolean
     OR v->>'acesso_ate' IS DISTINCT FROM '2027-03-18' OR v->>'plano' IS DISTINCT FROM 'basico' THEN
    RAISE EXCEPTION 'status %', v;
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_can_del', 'SUBSCRIPTION_DELETED', 'sub_can', 'sub_can', NULL, NULL, NULL, NULL, NULL, NULL, q12);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'cancelou de vez';
  END IF;
  PERFORM chat_private.asaas_marcar_cancelamento('sandbox', u_can, 'sub_can', v_tent);
  IF (SELECT status FROM chat_private.assinaturas WHERE user_id = u_can) IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'marcar reabriu';
  END IF;
  v := chat_private.asaas_status('sandbox', u_free);
  IF v->>'plano' IS DISTINCT FROM 'free' OR (v->>'pode_cancelar')::boolean OR (v->>'pode_tentar_de_novo')::boolean THEN RAISE EXCEPTION 'status free %', v; END IF;

  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_flow) <> 1 THEN RAISE EXCEPTION 'flow duplicou linha'; END IF;

  -- Correção 1. Outra assinatura do mesmo customer não altera a linha aberta.
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('sandbox', u_fora, 'basico', 'ativa', 'sub_fora', DATE '2027-06-01');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_fora, 'cus_fora18');
  v := pg_temp.ev('sandbox', 'evt_fora', 'PAYMENT_CONFIRMED', 'pay_fora', 'sub_outra', 'cus_fora18', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q2);
  IF (v->>'ignorado')::boolean IS NOT TRUE
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_fora) IS DISTINCT FROM 'ativa'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_fora) IS DISTINCT FROM DATE '2027-06-01'
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_fora) <> 1
     OR (SELECT ignorado FROM chat_private.asaas_eventos WHERE event_id = 'evt_fora') IS NOT TRUE THEN
    RAISE EXCEPTION 'outra assinatura %', v;
  END IF;

  -- Checkout pendente só recebe subscription_id se checkout ou externalReference e o customer baterem.
  v := chat_private.asaas_preparar_checkout('sandbox', u_dia, 'basico', DATE '2026-11-25');
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_dia, v_id2, 'chk_dia');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_dia, 'cus_dia20');
  v := pg_temp.ev('sandbox', 'evt_cruza', 'SUBSCRIPTION_CREATED', 'sub_fora', 'sub_fora', 'cus_dia20', 'chk_dia', NULL, 9.90, NULL, DATE '2026-11-25', q1);
  IF (v->>'ignorado')::boolean IS NOT TRUE
     OR (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'checkout'
     OR (SELECT status FROM chat_private.assinaturas WHERE subscription_id = 'sub_fora') IS DISTINCT FROM 'ativa' THEN
    RAISE EXCEPTION 'correlacao cruzada %', v;
  END IF;
  v := pg_temp.ev('sandbox', 'evt_dia', 'SUBSCRIPTION_CREATED', 'sub_dia', 'sub_dia', 'cus_dia20', 'chk_dia', v_id2::text, 9.90, NULL, DATE '2026-11-26', q2);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'trial'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM DATE '2026-11-26'
     OR (SELECT subscription_id FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'sub_dia'
     OR (SELECT count(*) FROM chat_private.asaas_trials WHERE ambiente = 'sandbox' AND user_id = u_dia) <> 1 THEN
    RAISE EXCEPTION 'tolerancia 1 dia';
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_data, 'basico', DATE '2026-11-25');
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_data, v_id2, 'chk_data');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_data, 'cus_data19');
  v := pg_temp.ev('sandbox', 'evt_data_alheia', 'PAYMENT_CONFIRMED', 'pay_data0', 'sub_alheia', 'cus_data19', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q1);
  IF (v->>'ignorado')::boolean IS NOT TRUE
     OR (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'checkout' THEN
    RAISE EXCEPTION 'evento sem chave %', v;
  END IF;
  v := pg_temp.ev('sandbox', 'evt_data', 'CHECKOUT_PAID', 'chk_data', 'sub_data', 'cus_data19', 'chk_data', NULL, 9.90, NULL, DATE '2026-11-27', q2);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'divergente'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id2) IS NOT NULL
     OR EXISTS (SELECT 1 FROM chat_private.asaas_trials WHERE user_id = u_data) THEN
    RAISE EXCEPTION 'data fora';
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_preco, 'basico', DATE '2026-11-25');
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_vincular_checkout('sandbox', u_preco, v_id2, 'chk_preco');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_preco, 'cus_preco21');
  PERFORM pg_temp.ev('sandbox', 'evt_preco', 'SUBSCRIPTION_CREATED', 'sub_preco', 'sub_preco', 'cus_preco21', 'chk_preco', v_id2::text, 29.90, NULL, DATE '2026-11-25', q2);
  IF (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'divergente'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id2) IS NOT NULL
     OR EXISTS (SELECT 1 FROM chat_private.asaas_trials WHERE user_id = u_preco) THEN
    RAISE EXCEPTION 'preco divergente';
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, preco_centavos, next_due_planejado, checkout_id)
  VALUES ('sandbox', u_flow, 'basico', 'checkout', 990, DATE '2026-11-25', 'chk_flow2');
  v := pg_temp.ev('sandbox', 'evt_flow2', 'SUBSCRIPTION_CREATED', 'sub_flow2', 'sub_flow2', 'cus_flow666', 'chk_flow2', NULL, 9.90, NULL, DATE '2026-11-25', q3);
  IF (SELECT status FROM chat_private.assinaturas WHERE checkout_id = 'chk_flow2') IS DISTINCT FROM 'divergente'
     OR (SELECT count(*) FROM chat_private.asaas_trials WHERE ambiente = 'sandbox' AND user_id = u_flow) <> 1
     OR (SELECT status FROM chat_private.assinaturas WHERE subscription_id = 'sub_flow1') IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'segundo trial %', v;
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('sandbox', u_curto, 'basico', 'ativa', 'sub_curto', DATE '2027-06-01');
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_curto, 'cus_curto23');
  PERFORM pg_temp.ev('sandbox', 'evt_curto', 'PAYMENT_CONFIRMED', 'pay_curto', 'sub_curto', 'cus_curto23', NULL, NULL, 9.90, DATE '2026-12-18', NULL, q2);
  IF (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_curto') IS DISTINCT FROM DATE '2027-06-01'
     OR (SELECT status FROM chat_private.assinaturas WHERE subscription_id = 'sub_curto') IS DISTINCT FROM 'ativa' THEN
    RAISE EXCEPTION 'pago encolheu';
  END IF;
  PERFORM pg_temp.ev('sandbox', 'evt_curto2', 'PAYMENT_RECEIVED', 'pay_curto2', 'sub_curto', 'cus_curto23', NULL, NULL, 9.90, DATE '2027-08-01', NULL, q4);
  IF (SELECT pago_ate FROM chat_private.assinaturas WHERE subscription_id = 'sub_curto') IS DISTINCT FROM DATE '2027-09-01' THEN
    RAISE EXCEPTION 'pago nao estendeu';
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('producao', u_mantem, 'basico', 'ativa', 'sub_mantem', v_hoje + 15);
  PERFORM pg_temp.ev('producao', 'evt_mantem', 'SUBSCRIPTION_DELETED', 'sub_mantem', 'sub_mantem', NULL, NULL, NULL, NULL, NULL, NULL, q6);
  v := chat_private.plano_atual(u_mantem);
  IF v->>'plano' IS DISTINCT FROM 'basico' OR v->>'status' IS DISTINCT FROM 'cancelada'
     OR (v->>'basico_dia')::int IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION 'cancelada cortou %', v;
  END IF;
  v := chat_private.asaas_status('producao', u_mantem);
  IF v->>'plano' IS DISTINCT FROM 'basico' OR v->>'status' IS DISTINCT FROM 'cancelada'
     OR (v->>'pode_cancelar')::boolean OR v->>'acesso_ate' IS DISTINCT FROM to_char(v_hoje + 15, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'status cancelada %', v;
  END IF;
  UPDATE chat_private.assinaturas SET pago_ate = v_hoje - 1 WHERE user_id = u_mantem;
  IF (chat_private.plano_atual(u_mantem)->>'plano') IS DISTINCT FROM 'free'
     OR (chat_private.asaas_status('producao', u_mantem)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'cancelada vencida';
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, trial_ate)
  VALUES ('producao', u_tcan, 'basico', 'trial', 'sub_tcan', v_hoje + 4);
  PERFORM pg_temp.ev('producao', 'evt_tcan', 'SUBSCRIPTION_DELETED', 'sub_tcan', 'sub_tcan', NULL, NULL, NULL, NULL, NULL, NULL, q6);
  IF (chat_private.plano_atual(u_tcan)->>'plano') IS DISTINCT FROM 'basico'
     OR (chat_private.asaas_status('producao', u_tcan)->>'status') IS DISTINCT FROM 'cancelada' THEN
    RAISE EXCEPTION 'trial cancelado cedo';
  END IF;
  UPDATE chat_private.assinaturas SET trial_ate = v_hoje - 1 WHERE user_id = u_tcan;
  IF (chat_private.plano_atual(u_tcan)->>'plano') IS DISTINCT FROM 'free' THEN RAISE EXCEPTION 'trial cancelado venceu'; END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate) VALUES
    ('producao', u_susp, 'basico', 'suspensa', 'sub_susp', v_hoje + 30),
    ('producao', u_diva, 'plus', 'divergente', 'sub_diva', v_hoje + 30);
  IF (chat_private.plano_atual(u_susp)->>'plano') IS DISTINCT FROM 'free'
     OR (chat_private.plano_atual(u_diva)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'suspensa ou divergente concedeu';
  END IF;
  v := chat_private.asaas_pedir_cancelamento('producao', u_susp);
  IF (v->>'ja')::boolean OR v->>'status' IS DISTINCT FROM 'suspensa'
     OR (chat_private.plano_atual(u_susp)->>'plano') IS DISTINCT FROM 'free'
     OR (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_susp) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_susp) IS DISTINCT FROM 'cancelamento_pendente' THEN
    RAISE EXCEPTION 'cancelar suspensa %', v;
  END IF;
  PERFORM pg_temp.ev('producao', 'evt_susp_del', 'SUBSCRIPTION_DELETED', 'sub_susp', 'sub_susp', NULL, NULL, NULL, NULL, NULL, NULL, q8);
  PERFORM chat_private.asaas_marcar_cancelamento('producao', u_susp, 'sub_susp', (v->>'tentativa_id')::uuid);
  IF (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_susp) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_susp) IS DISTINCT FROM 'encerrada'
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_susp) IS DISTINCT FROM 'suspensa'
     OR (chat_private.plano_atual(u_susp)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'marcar limpou suspensa';
  END IF;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('producao', u_est, 'basico', 'cancelada', 'sub_est', v_hoje + 20);
  IF (chat_private.plano_atual(u_est)->>'plano') IS DISTINCT FROM 'basico' THEN RAISE EXCEPTION 'cancelada ainda paga'; END IF;
  PERFORM pg_temp.ev('producao', 'evt_est_ref', 'PAYMENT_REFUNDED', 'pay_est', 'sub_est', NULL, NULL, NULL, 9.90, NULL, NULL, q9);
  IF (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM 'encerrada'
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM 'suspensa'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM v_hoje + 20
     OR (chat_private.plano_atual(u_est)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'estorno apos encerrar';
  END IF;
  PERFORM pg_temp.ev('producao', 'evt_est_pay', 'PAYMENT_CONFIRMED', 'pay_est2', 'sub_est', NULL, NULL, NULL, 9.90, v_hoje + 40, NULL, q10);
  IF (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM 'encerrada'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_est) IS DISTINCT FROM v_hoje + 20 THEN
    RAISE EXCEPTION 'confirmado reabriu';
  END IF;
  PERFORM pg_temp.ev('producao', 'evt_mantem_over', 'PAYMENT_OVERDUE', 'pay_mantem_over', 'sub_mantem', NULL, NULL, NULL, NULL, NULL, NULL, q7);
  IF (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_mantem) IS DISTINCT FROM 'inadimplente'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_mantem) IS DISTINCT FROM 'encerrada'
     OR (chat_private.plano_atual(u_mantem)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'atraso apos encerrar';
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_incerto, 'basico', DATE '2026-11-25');
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_marcar_checkout_incerto('sandbox', u_incerto, v_id2);
  PERFORM chat_private.asaas_descartar_checkout('sandbox', u_incerto, v_id2);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE id = v_id2) <> 1
     OR (SELECT resultado_incerto FROM chat_private.assinaturas WHERE id = v_id2) IS NOT TRUE THEN
    RAISE EXCEPTION 'incerto descartado';
  END IF;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_incerto, 'plus')->>'code') IS DISTINCT FROM 'checkout_em_andamento' THEN
    RAISE EXCEPTION 'incerto liberou';
  END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '3 minutes' WHERE id = v_id2;
  IF (chat_private.asaas_preparar_checkout('sandbox', u_incerto, 'plus')->>'code') IS DISTINCT FROM 'checkout_em_andamento' THEN
    RAISE EXCEPTION 'incerto 3 min';
  END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '61 minutes' WHERE id = v_id2;
  v := chat_private.asaas_preparar_checkout('sandbox', u_incerto, 'plus');
  IF v->>'code' IS DISTINCT FROM 'reconciliar' OR (v->>'assinatura_id')::uuid IS DISTINCT FROM v_id2
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_incerto) <> 1
     OR (SELECT preco_centavos FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 990
     OR (SELECT reserva FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'expirada'
     OR (SELECT resultado_incerto FROM chat_private.assinaturas WHERE id = v_id2) IS NOT TRUE THEN
    RAISE EXCEPTION 'incerto 61 %', v;
  END IF;
  v_ger := (v->>'geracao')::bigint;
  v := chat_private.asaas_liberar_checkout('sandbox', u_incerto, 'plus', NULL, v_ger);
  IF (v->>'ok')::boolean IS NOT TRUE OR (v->>'assinatura_id')::uuid = v_id2
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_incerto) <> 2
     OR (SELECT preco_centavos FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 990
     OR (SELECT preco_centavos FROM chat_private.assinaturas WHERE id = (v->>'assinatura_id')::uuid) IS DISTINCT FROM 2990 THEN
    RAISE EXCEPTION 'incerto liberou apagando %', v;
  END IF;
  PERFORM chat_private.asaas_gravar_cliente('sandbox', u_incerto, 'cus_incerto27');
  v := pg_temp.ev('sandbox', 'evt_incerto_tarde', 'SUBSCRIPTION_CREATED', 'sub_incerto', 'sub_incerto', 'cus_incerto27', NULL, v_id2::text, 9.90, NULL, DATE '2026-11-25', q11);
  IF (v->>'ignorado')::boolean
     OR (SELECT status FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'trial'
     OR (SELECT trial_ate FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM DATE '2026-11-25'
     OR (SELECT subscription_id FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'sub_incerto' THEN
    RAISE EXCEPTION 'webhook atrasado %', v;
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('sandbox', u_rev, 'basico', 'ativa', 'sub_rev', DATE '2027-04-01');
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  IF (v->>'ja')::boolean OR v->>'status_anterior' IS DISTINCT FROM 'ativa'
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM 'cancelamento_solicitado'
     OR (SELECT tentativas FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'reserva cancel %', v;
  END IF;
  IF (chat_private.asaas_status('sandbox', u_rev)->>'pode_cancelar')::boolean
     OR (chat_private.asaas_status('sandbox', u_rev)->>'pode_tentar_de_novo')::boolean THEN
    RAISE EXCEPTION 'lease vivo permite retry';
  END IF;
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  IF (v->>'ja')::boolean OR v->>'code' IS DISTINCT FROM 'cancelamento_em_andamento'
     OR (SELECT tentativas FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'segunda reserva %', v;
  END IF;
  UPDATE chat_private.asaas_cancelamentos SET lease_ate = now() - interval '1 minute' WHERE user_id = u_rev;
  v := chat_private.asaas_status('sandbox', u_rev);
  IF (v->>'pode_cancelar')::boolean IS NOT TRUE OR (v->>'pode_tentar_de_novo')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'lease vencido esconde retry %', v;
  END IF;
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  IF (v->>'refazer')::boolean IS NOT TRUE OR (v->>'ja')::boolean
     OR (SELECT tentativas FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 2
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM 'cancelamento_pendente' THEN
    RAISE EXCEPTION 'lease vencido %', v;
  END IF;
  v_tent := (v->>'tentativa_id')::uuid;
  IF chat_private.asaas_falhar_cancelamento('sandbox', u_rev, 'sub_rev', '00000000-0000-4000-8000-000000000000') THEN
    RAISE EXCEPTION 'falha de outra tentativa';
  END IF;
  IF (SELECT estado FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 'pendente' THEN
    RAISE EXCEPTION 'falha alheia mudou';
  END IF;
  IF NOT chat_private.asaas_falhar_cancelamento('sandbox', u_rev, 'sub_rev', v_tent) THEN
    RAISE EXCEPTION 'falha nao gravou';
  END IF;
  IF (SELECT estado FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 'falhou'
     OR (SELECT status FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM 'cancelamento_solicitado'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM DATE '2027-04-01' THEN
    RAISE EXCEPTION 'falha restaurou';
  END IF;
  v := chat_private.asaas_status('sandbox', u_rev);
  IF (v->>'pode_cancelar')::boolean IS NOT TRUE OR (v->>'pode_tentar_de_novo')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'falhou esconde retry %', v;
  END IF;
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  v_tent := (v->>'tentativa_id')::uuid;
  IF (v->>'refazer')::boolean IS NOT TRUE OR (SELECT tentativas FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'falhou nao refaz %', v;
  END IF;
  UPDATE chat_private.asaas_cancelamentos SET lease_ate = now() + interval '90 seconds' WHERE user_id = u_rev;
  PERFORM pg_temp.ev('sandbox', 'evt_rev_pay', 'PAYMENT_CONFIRMED', 'pay_rev', 'sub_rev', NULL, NULL, NULL, 9.90, DATE '2026-12-18', NULL, q7);
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  IF v->>'code' IS DISTINCT FROM 'cancelamento_em_andamento' OR (v->>'ja')::boolean
     OR (SELECT tentativas FROM chat_private.asaas_cancelamentos WHERE user_id = u_rev) IS DISTINCT FROM 3
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM 'cancelamento_pendente'
     OR (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_rev) IS NOT NULL
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM DATE '2027-04-01' THEN
    RAISE EXCEPTION 'pagamento no meio %', v;
  END IF;
  PERFORM chat_private.asaas_marcar_cancelamento('sandbox', u_rev, 'sub_rev', v_tent);
  v := chat_private.asaas_pedir_cancelamento('sandbox', u_rev);
  IF (v->>'ja')::boolean IS NOT TRUE OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_rev) IS DISTINCT FROM DATE '2027-04-01' THEN
    RAISE EXCEPTION 'so concluido e ja %', v;
  END IF;

  v := chat_private.asaas_preparar_checkout('sandbox', u_env, 'basico', DATE '2026-11-25');
  v_id := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_marcar_checkout_enviando('sandbox', u_env, v_id);
  PERFORM chat_private.asaas_descartar_checkout('sandbox', u_env, v_id);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE id = v_id) <> 1
     OR (SELECT reserva FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'enviando'
     OR (SELECT envio_em FROM chat_private.assinaturas WHERE id = v_id) IS NULL THEN
    RAISE EXCEPTION 'descartou enviando';
  END IF;
  PERFORM chat_private.asaas_descartar_envio_recusado('sandbox', u_env, v_id);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 0 THEN
    RAISE EXCEPTION '4xx nao descartou envio';
  END IF;
  v := chat_private.asaas_preparar_checkout('sandbox', u_env, 'basico', DATE '2026-11-25');
  v_id := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_marcar_checkout_enviando('sandbox', u_env, v_id);
  IF (chat_private.asaas_preparar_checkout('sandbox', u_env, 'plus')->>'code') IS DISTINCT FROM 'checkout_em_andamento' THEN
    RAISE EXCEPTION 'enviando recente liberou';
  END IF;
  v_ger := (SELECT geracao FROM chat_private.asaas_checkout_geracao WHERE ambiente = 'sandbox' AND user_id = u_env);
  v := chat_private.asaas_liberar_checkout('sandbox', u_env, 'plus', NULL, v_ger);
  IF v->>'code' IS DISTINCT FROM 'checkout_em_andamento'
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 1 THEN
    RAISE EXCEPTION 'liberar com enviando %', v;
  END IF;
  UPDATE chat_private.assinaturas SET atualizado_em = now() - interval '61 minutes' WHERE id = v_id;
  v := chat_private.asaas_preparar_checkout('sandbox', u_env, 'plus');
  IF v->>'code' IS DISTINCT FROM 'reconciliar' OR (v->>'assinatura_id')::uuid IS DISTINCT FROM v_id
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 1
     OR (SELECT reserva FROM chat_private.assinaturas WHERE id = v_id) IS DISTINCT FROM 'expirada'
     OR (SELECT envio_em FROM chat_private.assinaturas WHERE id = v_id) IS NULL THEN
    RAISE EXCEPTION 'enviando 61 %', v;
  END IF;
  v_ger := (v->>'geracao')::bigint;
  v := chat_private.asaas_liberar_checkout('sandbox', u_env, 'plus', NULL, v_ger - 1);
  IF v->>'code' IS DISTINCT FROM 'checkout_em_andamento'
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 1 THEN
    RAISE EXCEPTION 'geracao velha %', v;
  END IF;
  v := chat_private.asaas_liberar_checkout('sandbox', u_env, 'plus', NULL, v_ger);
  IF (v->>'ok')::boolean IS NOT TRUE OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 2 THEN
    RAISE EXCEPTION 'liberar geracao certa %', v;
  END IF;
  v_id2 := (v->>'assinatura_id')::uuid;
  PERFORM chat_private.asaas_marcar_checkout_incerto('sandbox', u_env, v_id2);
  v_ger := (SELECT geracao FROM chat_private.asaas_checkout_geracao WHERE ambiente = 'sandbox' AND user_id = u_env);
  v := chat_private.asaas_liberar_checkout('sandbox', u_env, 'basico', NULL, v_ger);
  IF v->>'code' IS DISTINCT FROM 'checkout_em_andamento'
     OR (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 2
     OR (SELECT reserva FROM chat_private.assinaturas WHERE id = v_id2) IS DISTINCT FROM 'incerta' THEN
    RAISE EXCEPTION 'liberar com incerta %', v;
  END IF;
  PERFORM chat_private.asaas_descartar_envio_recusado('sandbox', u_env, v_id2);
  PERFORM chat_private.asaas_descartar_checkout('sandbox', u_env, v_id);
  IF (SELECT count(*) FROM chat_private.assinaturas WHERE user_id = u_env) <> 2 THEN
    RAISE EXCEPTION 'descarte apagou reserva potencialmente enviada';
  END IF;

  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('producao', u_ord, 'basico', 'ativa', 'sub_ord', v_hoje + 30);
  PERFORM pg_temp.ev('producao', 'evt_ord_del', 'SUBSCRIPTION_DELETED', 'sub_ord', 'sub_ord', NULL, NULL, NULL, NULL, NULL, NULL, timestamptz '2026-11-18 15:10:00-03');
  v := pg_temp.ev('producao', 'evt_ord_ref', 'PAYMENT_REFUNDED', 'pay_ord', 'sub_ord', NULL, NULL, NULL, 9.90, NULL, NULL, timestamptz '2026-11-18 15:09:00-03');
  IF v->>'antigo' IS NOT DISTINCT FROM 'true'
     OR (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM 'encerrada'
     OR (SELECT ultimo_evento_em FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM timestamptz '2026-11-18 15:10:00-03'
     OR (SELECT pago_ate FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM v_hoje + 30
     OR (chat_private.plano_atual(u_ord)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'estorno fora de ordem %', v;
  END IF;
  v := pg_temp.ev('producao', 'evt_ord_over', 'PAYMENT_OVERDUE', 'pay_ord_over', 'sub_ord', NULL, NULL, NULL, NULL, NULL, NULL, timestamptz '2026-11-18 15:09:30-03');
  IF v->>'antigo' IS DISTINCT FROM 'true'
     OR (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM 'suspensa'
     OR (SELECT ultimo_evento_em FROM chat_private.assinaturas WHERE user_id = u_ord) IS DISTINCT FROM timestamptz '2026-11-18 15:10:00-03' THEN
    RAISE EXCEPTION 'overdue antigo aplicou %', v;
  END IF;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, subscription_id, pago_ate)
  VALUES ('producao', u_ord2, 'basico', 'ativa', 'sub_ord2', v_hoje + 30);
  PERFORM pg_temp.ev('producao', 'evt_ord2_ref', 'PAYMENT_REFUNDED', 'pay_ord2', 'sub_ord2', NULL, NULL, NULL, 9.90, NULL, NULL, timestamptz '2026-11-18 15:09:00-03');
  PERFORM pg_temp.ev('producao', 'evt_ord2_del', 'SUBSCRIPTION_DELETED', 'sub_ord2', 'sub_ord2', NULL, NULL, NULL, NULL, NULL, NULL, timestamptz '2026-11-18 15:10:00-03');
  IF (SELECT bloqueio FROM chat_private.assinaturas WHERE user_id = u_ord2) IS DISTINCT FROM 'suspensa'
     OR (SELECT recorrencia FROM chat_private.assinaturas WHERE user_id = u_ord2) IS DISTINCT FROM 'encerrada'
     OR (SELECT ultimo_evento_em FROM chat_private.assinaturas WHERE user_id = u_ord2) IS DISTINCT FROM timestamptz '2026-11-18 15:10:00-03'
     OR (chat_private.plano_atual(u_ord2)->>'plano') IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'estorno em ordem';
  END IF;

  v_def := pg_get_functiondef('chat_private.asaas_aplicar_evento(text,text,text,text,text,text,text,text,numeric,date,date,timestamptz)'::regprocedure);
  v_prep := pg_get_functiondef('chat_private.asaas_preparar_checkout(text,uuid,text,date)'::regprocedure);
  v_ped := pg_get_functiondef('chat_private.asaas_pedir_cancelamento(text,uuid)'::regprocedure);
  IF position('FOR UPDATE' in v_def) = 0
     OR position('ultimo_evento_em <= v_quando' in v_def) = 0
     OR position('GREATEST' in v_def) = 0
     OR position('asaas-user:' in v_def) = 0
     OR position('60 minutes' in v_prep) = 0
     OR position('2 minutes' in v_prep) > 0
     OR position('2 minutes' in v_def) > 0
     OR position('240 seconds' in v_ped) = 0
     OR position('90 seconds' in v_ped) > 0
     OR position('tentativa_id' in pg_get_functiondef('chat_private.asaas_marcar_cancelamento(text,uuid,text,uuid)'::regprocedure)) = 0
     OR position('tentativa_id' in pg_get_functiondef('chat_private.asaas_falhar_cancelamento(text,uuid,text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'lock ou janela';
  END IF;
END
$t$;

CREATE TEMP TABLE asaas_teste_ok (ok boolean);
INSERT INTO asaas_teste_ok VALUES (true);
