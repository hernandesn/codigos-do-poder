-- 007: lista privada de usuários sem limite por usuário (testes do dono).
-- Pula a cota grátis diária, o limite por minuto e o limite diário de perguntas.
-- NÃO pula o teto global diário de US$3 (chat_budget_reserve, intocado),
-- nem a checagem da chave OpenRouter, nem a trava paid_lease.

CREATE TABLE IF NOT EXISTS chat_private.unlimited_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chat_private.unlimited_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE chat_private.unlimited_users FROM PUBLIC;
DO $r$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE chat_private.unlimited_users FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE chat_private.unlimited_users FROM authenticated';
  END IF;
END
$r$;
GRANT SELECT ON TABLE chat_private.unlimited_users TO chat_writer, chat_fn;
DROP POLICY IF EXISTS chat_writer_select ON chat_private.unlimited_users;
CREATE POLICY chat_writer_select ON chat_private.unlimited_users
  FOR SELECT TO chat_fn, chat_writer USING (true);

CREATE OR REPLACE FUNCTION chat_private.chat_is_unlimited(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'chat_private', 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM chat_private.unlimited_users u WHERE u.user_id = p_user_id);
$function$;
REVOKE ALL ON FUNCTION chat_private.chat_is_unlimited(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_private.chat_is_unlimited(uuid) TO chat_writer, chat_fn;

CREATE OR REPLACE FUNCTION chat_private.chat_rate_touch(p_user_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  v_day date := chat_private.chat_day_saopaulo();
  v_minute integer;
  v_day_count integer;
  v_oldest timestamptz;
  v_unlimited boolean;
BEGIN
  IF p_user_key IS NULL OR btrim(p_user_key) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  -- Segura as outras conexões deste usuário até o fim da transação,
  -- para o INSERT abaixo entrar na contagem da próxima chamada.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_key)::bigint);

  INSERT INTO chat_private.chat_rate_events (user_key)
  VALUES (p_user_key);

  SELECT count(*)::integer,
         min(at)
    INTO v_minute, v_oldest
  FROM chat_private.chat_rate_events
  WHERE user_key = p_user_key
    AND at >= now() - interval '1 minute';

  SELECT count(*)::integer
    INTO v_day_count
  FROM chat_private.chat_rate_events
  WHERE user_key = p_user_key
    AND (at AT TIME ZONE 'America/Sao_Paulo')::date = v_day;

  -- Lista privada de testes: sem limite por minuto e por dia. O teto global
  -- de orçamento e a chave de inferência continuam valendo.
  v_unlimited := EXISTS (SELECT 1 FROM chat_private.unlimited_users u WHERE u.user_id::text = p_user_key);
  IF v_unlimited THEN
    v_minute := 0;
    v_day_count := 0;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'minute_count', v_minute,
    'day_count', v_day_count,
    'oldest_minute', v_oldest
  );
END;
$function$;

CREATE OR REPLACE FUNCTION chat_private.chat_reserve_credits(p_user_id uuid, p_modelo text, p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  v_day date := chat_private.chat_day_saopaulo();
  v_cost integer;
  v_used integer;
  v_reserved integer;
  v_paid integer;
  v_kind text;
  v_gratis integer;
  v_unlimited boolean := chat_private.chat_is_unlimited(p_user_id);
BEGIN
  IF p_user_id IS NULL OR p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  IF p_modelo = 'basico' THEN
    v_cost := 1;
  ELSIF p_modelo = 'avancado' THEN
    v_cost := 8;
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  INSERT INTO chat_private.free_quota_daily (user_id, day)
  VALUES (p_user_id, v_day)
  ON CONFLICT (user_id, day) DO NOTHING;

  INSERT INTO chat_private.credit_balances (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT used_basico, reserved_basico
    INTO v_used, v_reserved
  FROM chat_private.free_quota_daily
  WHERE user_id = p_user_id AND day = v_day
  FOR UPDATE;

  SELECT paid_credits
    INTO v_paid
  FROM chat_private.credit_balances
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Lista privada: reserva com custo 0, sem mexer na cota grátis (CHECK <= 20)
  -- nem no saldo pago. O teto global de orçamento é reservado à parte pelo chat.
  IF v_unlimited THEN
    INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
    VALUES (p_user_id, 0, 'chat_reserve', p_pedido_id, p_modelo);

    INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, user_id, modelo, kind, custo)
    VALUES (p_pedido_id, 'credito', 'reservado', v_day, p_user_id, p_modelo, 'free', 0);

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'free',
      'cost', 0,
      'day', v_day,
      'gratis_restantes', 999,
      'pago', v_paid
    );
  END IF;

  IF p_modelo = 'basico' AND v_used + v_reserved + v_cost <= 20 THEN
    UPDATE chat_private.free_quota_daily
    SET reserved_basico = reserved_basico + v_cost
    WHERE user_id = p_user_id AND day = v_day;

    INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
    VALUES (p_user_id, 0, 'chat_reserve', p_pedido_id, p_modelo);

    INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, user_id, modelo, kind, custo)
    VALUES (p_pedido_id, 'credito', 'reservado', v_day, p_user_id, p_modelo, 'free', v_cost);

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'free',
      'cost', v_cost,
      'day', v_day,
      'gratis_restantes', 20 - (v_used + v_reserved + v_cost),
      'pago', v_paid
    );
  END IF;

  v_gratis := greatest(0, 20 - (v_used + v_reserved));

  IF v_paid < v_cost THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'sem_creditos',
      'gratis_restantes', v_gratis,
      'pago', v_paid
    );
  END IF;

  UPDATE chat_private.credit_balances
  SET paid_credits = paid_credits - v_cost,
      updated_at = now()
  WHERE user_id = p_user_id
    AND paid_credits >= v_cost;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'sem_creditos',
      'gratis_restantes', v_gratis,
      'pago', v_paid
    );
  END IF;

  v_kind := 'paid';

  INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
  VALUES (p_user_id, -v_cost, 'chat_reserve', p_pedido_id, p_modelo);

  INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, user_id, modelo, kind, custo)
  VALUES (p_pedido_id, 'credito', 'reservado', v_day, p_user_id, p_modelo, 'paid', v_cost);

  RETURN jsonb_build_object(
    'ok', true,
    'kind', v_kind,
    'cost', v_cost,
    'day', v_day,
    'gratis_restantes', v_gratis,
    'pago', v_paid - v_cost
  );
END;
$function$;

CREATE OR REPLACE FUNCTION chat_private.chat_commit_credits(p_user_id uuid, p_modelo text, p_kind text, p_cost integer, p_day date, p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  v_estado text;
  v_day date;
  v_kind text;
  v_cost integer;
  v_modelo text;
  v_user uuid;
  v_used integer;
  v_reserved integer;
  v_paid integer;
  v_found boolean;
  v_unlimited boolean;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  SELECT estado, dia, kind, custo, modelo, user_id
    INTO v_estado, v_day, v_kind, v_cost, v_modelo, v_user
  FROM chat_private.reserva_pedido
  WHERE pedido_id = p_pedido_id
    AND dominio = 'credito'
  FOR UPDATE;
  v_found := FOUND;

  PERFORM chat_private.chat_pause_settle();
  v_unlimited := chat_private.chat_is_unlimited(coalesce(v_user, p_user_id));

  IF NOT v_found OR v_estado IS DISTINCT FROM 'reservado' THEN
    -- Mesma fórmula do ramo que debita: 20 - usados - reservados no dia da reserva.
    -- Sem linha de cota, coalesce zera os dois termos e o restante fica 20, não 0.
    SELECT used_basico, reserved_basico
      INTO v_used, v_reserved
    FROM chat_private.free_quota_daily
    WHERE user_id = coalesce(v_user, p_user_id)
      AND day = coalesce(v_day, p_day);

    SELECT paid_credits INTO v_paid
    FROM chat_private.credit_balances
    WHERE user_id = coalesce(v_user, p_user_id);

    RETURN jsonb_build_object(
      'ok', true,
      'noop', true,
      'gratis_restantes', CASE WHEN v_unlimited THEN 999 ELSE greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)) END,
      'pago', coalesce(v_paid, 0)
    );
  END IF;

  IF v_kind = 'free' THEN
    UPDATE chat_private.free_quota_daily
    SET reserved_basico = reserved_basico - v_cost,
        used_basico = used_basico + v_cost
    WHERE user_id = v_user
      AND day = v_day
      AND reserved_basico >= v_cost;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'sem_creditos');
    END IF;
  END IF;

  UPDATE chat_private.reserva_pedido
  SET estado = 'confirmado'
  WHERE pedido_id = p_pedido_id
    AND dominio = 'credito'
    AND estado = 'reservado';

  INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
  VALUES (v_user, 0, 'chat_debit', p_pedido_id, v_modelo);

  SELECT used_basico, reserved_basico
    INTO v_used, v_reserved
  FROM chat_private.free_quota_daily
  WHERE user_id = v_user AND day = v_day;

  SELECT paid_credits INTO v_paid
  FROM chat_private.credit_balances
  WHERE user_id = v_user;

  RETURN jsonb_build_object(
    'ok', true,
    'noop', false,
    'gratis_restantes', CASE WHEN v_unlimited THEN 999 ELSE greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)) END,
    'pago', coalesce(v_paid, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION chat_private.chat_release_reserve(p_user_id uuid, p_modelo text, p_kind text, p_cost integer, p_day date, p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  v_estado text;
  v_day date;
  v_kind text;
  v_cost integer;
  v_modelo text;
  v_user uuid;
  v_paid integer;
  v_used integer;
  v_reserved integer;
  v_found boolean;
  v_unlimited boolean;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  SELECT estado, dia, kind, custo, modelo, user_id
    INTO v_estado, v_day, v_kind, v_cost, v_modelo, v_user
  FROM chat_private.reserva_pedido
  WHERE pedido_id = p_pedido_id
    AND dominio = 'credito'
  FOR UPDATE;
  v_found := FOUND;

  PERFORM chat_private.chat_pause_settle();
  v_unlimited := chat_private.chat_is_unlimited(coalesce(v_user, p_user_id));

  IF NOT v_found OR v_estado IS DISTINCT FROM 'reservado' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  IF v_kind = 'free' THEN
    UPDATE chat_private.free_quota_daily
    SET reserved_basico = reserved_basico - v_cost
    WHERE user_id = v_user
      AND day = v_day
      AND reserved_basico >= v_cost;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'sem_creditos');
    END IF;

    INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
    VALUES (v_user, 0, 'chat_reserve_release', p_pedido_id, v_modelo);
  ELSE
    UPDATE chat_private.credit_balances
    SET paid_credits = paid_credits + v_cost,
        updated_at = now()
    WHERE user_id = v_user;

    INSERT INTO chat_private.credit_ledger (user_id, delta, reason, pedido_id, modelo)
    VALUES (v_user, v_cost, 'chat_reserve_release', p_pedido_id, v_modelo);
  END IF;

  UPDATE chat_private.reserva_pedido
  SET estado = 'liberado'
  WHERE pedido_id = p_pedido_id
    AND dominio = 'credito'
    AND estado = 'reservado';

  SELECT used_basico, reserved_basico
    INTO v_used, v_reserved
  FROM chat_private.free_quota_daily
  WHERE user_id = v_user AND day = v_day;

  SELECT paid_credits INTO v_paid
  FROM chat_private.credit_balances
  WHERE user_id = v_user;

  RETURN jsonb_build_object(
    'ok', true,
    'noop', false,
    'gratis_restantes', CASE WHEN v_unlimited THEN 999 ELSE greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)) END,
    'pago', coalesce(v_paid, 0)
  );
END;
$function$;

-- A linha do dono foi inserida fora do repositório (não publicamos o user_id).
-- Para liberar um usuário:
--   INSERT INTO chat_private.unlimited_users (user_id, note)
--   VALUES ('<uuid do auth.users>', '<motivo>') ON CONFLICT (user_id) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES ('007', 'Private unlimited-users allowlist for per-user chat limits')
ON CONFLICT (version) DO NOTHING;
