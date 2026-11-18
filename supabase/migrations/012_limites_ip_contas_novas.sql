-- Limites por IP e teto compartilhado das contas novas.
-- O IP em claro não entra aqui: a função só aceita hash SHA-256 de 64 hex.
-- Evento acima do teto não é inserido. Linha com mais de 48h sai na própria chamada.

CREATE TABLE IF NOT EXISTS chat_private.chat_ip_rate_events (
  ip_hash text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS chat_ip_rate_events_hash_at_idx
  ON chat_private.chat_ip_rate_events (ip_hash, at);

CREATE TABLE IF NOT EXISTS chat_private.chat_new_account_events (
  user_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_new_account_events_user_at_idx
  ON chat_private.chat_new_account_events (user_key, at);

CREATE TABLE IF NOT EXISTS chat_private.budget_new_accounts (
  dia date PRIMARY KEY,
  gasto_usd numeric(14, 6) NOT NULL DEFAULT 0,
  reservado_usd numeric(14, 6) NOT NULL DEFAULT 0,
  CHECK (gasto_usd >= 0),
  CHECK (reservado_usd >= 0)
);

COMMENT ON TABLE chat_private.budget_new_accounts IS
  'Teto diário compartilhado das contas novas, America/Sao_Paulo. A reserva não passa de US$ 0,50 e também não passa do teto global.';

ALTER TABLE chat_private.reserva_pedido
  ADD COLUMN IF NOT EXISTS conta_nova boolean NOT NULL DEFAULT false;

-- A 010 não apaga evento velho. Aqui o mesmo corpo ganha a expiração de 48h.
CREATE OR REPLACE FUNCTION chat_private.chat_rate_touch(p_user_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  c_ttl constant interval := interval '48 hours';
  v_day date := chat_private.chat_day_saopaulo();
  v_minute integer;
  v_day_count integer;
  v_oldest timestamptz;
  v_unlimited boolean;
BEGIN
  IF p_user_key IS NULL OR btrim(p_user_key) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_key)::bigint);

  DELETE FROM chat_private.chat_rate_events
  WHERE user_key = p_user_key
    AND at < now() - c_ttl;

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

  v_unlimited := EXISTS (SELECT 1 FROM chat_private.unlimited_users u WHERE u.user_id::text = p_user_key);
  IF NOT v_unlimited AND (v_minute >= 10 OR v_day_count >= 200) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'minute_count', v_minute + 1,
      'day_count', v_day_count + 1,
      'oldest_minute', v_oldest
    );
  END IF;

  INSERT INTO chat_private.chat_rate_events (user_key) VALUES (p_user_key);
  v_minute := v_minute + 1;
  v_day_count := v_day_count + 1;
  v_oldest := coalesce(v_oldest, now());
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

CREATE OR REPLACE FUNCTION chat_private.chat_ip_rate_touch(p_ip_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  c_minute constant integer := 30;
  c_day constant integer := 300;
  c_ttl constant interval := interval '48 hours';
  v_day date := chat_private.chat_day_saopaulo();
  v_minute integer;
  v_day_count integer;
  v_oldest timestamptz;
BEGIN
  -- IP cru ou hash fora do formato não é gravado.
  IF p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'minute_count', c_minute + 1,
      'day_count', c_day + 1,
      'oldest_minute', NULL
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ip:' || p_ip_hash)::bigint);

  DELETE FROM chat_private.chat_ip_rate_events
  WHERE ip_hash = p_ip_hash
    AND at < now() - c_ttl;

  SELECT count(*)::integer, min(at)
    INTO v_minute, v_oldest
  FROM chat_private.chat_ip_rate_events
  WHERE ip_hash = p_ip_hash
    AND at >= now() - interval '1 minute';

  SELECT count(*)::integer
    INTO v_day_count
  FROM chat_private.chat_ip_rate_events
  WHERE ip_hash = p_ip_hash
    AND (at AT TIME ZONE 'America/Sao_Paulo')::date = v_day;

  IF v_minute >= c_minute OR v_day_count >= c_day THEN
    RETURN jsonb_build_object(
      'ok', true,
      'minute_count', v_minute + 1,
      'day_count', v_day_count + 1,
      'oldest_minute', v_oldest
    );
  END IF;

  INSERT INTO chat_private.chat_ip_rate_events (ip_hash) VALUES (p_ip_hash);
  RETURN jsonb_build_object(
    'ok', true,
    'minute_count', v_minute + 1,
    'day_count', v_day_count + 1,
    'oldest_minute', coalesce(v_oldest, now())
  );
END;
$function$;

CREATE OR REPLACE FUNCTION chat_private.chat_new_account_rate_touch(p_user_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'chat_private', 'public'
AS $function$
DECLARE
  c_day constant integer := 3;
  c_ttl constant interval := interval '48 hours';
  v_day date := chat_private.chat_day_saopaulo();
  v_day_count integer;
BEGIN
  IF p_user_key IS NULL OR btrim(p_user_key) = '' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'minute_count', 0,
      'day_count', c_day + 1,
      'oldest_minute', NULL
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('nova:' || p_user_key)::bigint);

  DELETE FROM chat_private.chat_new_account_events
  WHERE user_key = p_user_key
    AND at < now() - c_ttl;

  SELECT count(*)::integer
    INTO v_day_count
  FROM chat_private.chat_new_account_events
  WHERE user_key = p_user_key
    AND (at AT TIME ZONE 'America/Sao_Paulo')::date = v_day;

  IF v_day_count >= c_day THEN
    RETURN jsonb_build_object(
      'ok', true,
      'minute_count', 0,
      'day_count', v_day_count + 1,
      'oldest_minute', NULL
    );
  END IF;

  INSERT INTO chat_private.chat_new_account_events (user_key) VALUES (p_user_key);
  RETURN jsonb_build_object(
    'ok', true,
    'minute_count', 0,
    'day_count', v_day_count + 1,
    'oldest_minute', NULL
  );
END;
$function$;

-- A assinatura de 3 argumentos da 004 permanece. Esta soma o teto de US$ 0,50.
CREATE OR REPLACE FUNCTION chat_private.chat_budget_reserve(
  p_pedido_id uuid,
  p_estimate numeric,
  p_cap numeric,
  p_conta_nova boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  c_new_cap constant numeric(14, 6) := 0.50;
  v_day date := chat_private.chat_day_saopaulo();
  v_estimate numeric(14, 6);
  v_cap numeric(14, 6);
  v_gasto numeric(14, 6);
  v_reservado numeric(14, 6);
  v_new_gasto numeric(14, 6);
  v_new_reservado numeric(14, 6);
  v_nova boolean := coalesce(p_conta_nova, false);
BEGIN
  IF p_pedido_id IS NULL OR p_estimate IS NULL OR p_cap IS NULL OR p_estimate <= 0 OR p_cap <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  IF EXISTS (
    SELECT 1 FROM chat_private.reserva_pedido
    WHERE pedido_id = p_pedido_id AND dominio = 'orcamento'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  v_estimate := round(p_estimate, 6);
  v_cap := least(round(p_cap, 6), 3);

  INSERT INTO chat_private.budget_daily (dia)
  VALUES (v_day)
  ON CONFLICT (dia) DO NOTHING;

  SELECT gasto_usd, reservado_usd
    INTO v_gasto, v_reservado
  FROM chat_private.budget_daily
  WHERE dia = v_day
  FOR UPDATE;

  IF v_nova THEN
    INSERT INTO chat_private.budget_new_accounts (dia)
    VALUES (v_day)
    ON CONFLICT (dia) DO NOTHING;

    SELECT gasto_usd, reservado_usd
      INTO v_new_gasto, v_new_reservado
    FROM chat_private.budget_new_accounts
    WHERE dia = v_day
    FOR UPDATE;
  END IF;

  IF coalesce(v_gasto, 0) + coalesce(v_reservado, 0) + v_estimate > v_cap
     OR (v_nova AND coalesce(v_new_gasto, 0) + coalesce(v_new_reservado, 0) + v_estimate > c_new_cap) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'orcamento_esgotado');
  END IF;

  UPDATE chat_private.budget_daily
  SET reservado_usd = reservado_usd + v_estimate
  WHERE dia = v_day;

  IF v_nova THEN
    UPDATE chat_private.budget_new_accounts
    SET reservado_usd = reservado_usd + v_estimate
    WHERE dia = v_day;
  END IF;

  INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, estimado_usd, conta_nova)
  VALUES (p_pedido_id, 'orcamento', 'reservado', v_day, v_estimate, v_nova);

  RETURN jsonb_build_object('ok', true, 'day', v_day);
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_budget_commit(
  p_pedido_id uuid,
  p_actual numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_estado text;
  v_day date;
  v_estimate numeric(14, 6);
  v_actual numeric(14, 6);
  v_gasto numeric(14, 6);
  v_reservado numeric(14, 6);
  v_updated date;
  v_orphan uuid;
  v_found boolean;
  v_conta_nova boolean;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  SELECT estado, dia, estimado_usd, conta_nova
    INTO v_estado, v_day, v_estimate, v_conta_nova
  FROM chat_private.reserva_pedido
  WHERE pedido_id = p_pedido_id
    AND dominio = 'orcamento'
  FOR UPDATE;
  v_found := FOUND;

  PERFORM chat_private.chat_pause_settle();

  v_actual := round(greatest(coalesce(p_actual, v_estimate, 0), 0), 6);

  IF NOT v_found THEN
    v_day := chat_private.chat_day_saopaulo();
    INSERT INTO chat_private.budget_daily (dia) VALUES (v_day) ON CONFLICT (dia) DO NOTHING;
    SELECT gasto_usd, reservado_usd
      INTO v_gasto, v_reservado
    FROM chat_private.budget_daily
    WHERE dia = v_day
    FOR UPDATE;
    IF coalesce(v_gasto, 0) + coalesce(v_reservado, 0) + v_actual > 3 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'orcamento_esgotado', 'day', v_day);
    END IF;

    INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, estimado_usd, real_usd)
    VALUES (p_pedido_id, 'orcamento', 'confirmado', v_day, 0, v_actual)
    ON CONFLICT (pedido_id, dominio) DO NOTHING
    RETURNING pedido_id INTO v_orphan;

    IF v_orphan IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'noop', true);
    END IF;

    UPDATE chat_private.budget_daily
    SET gasto_usd = gasto_usd + v_actual
    WHERE dia = v_day;

    RETURN jsonb_build_object('ok', true, 'noop', false, 'day', v_day);
  END IF;

  IF v_estado IS DISTINCT FROM 'reservado' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'day', v_day);
  END IF;

  UPDATE chat_private.reserva_pedido
  SET estado = 'confirmado',
      real_usd = v_actual
  WHERE pedido_id = p_pedido_id
    AND dominio = 'orcamento'
    AND estado = 'reservado';

  UPDATE chat_private.budget_daily
  SET reservado_usd = reservado_usd - v_estimate,
      gasto_usd = gasto_usd + v_actual
  WHERE dia = v_day
    AND reservado_usd >= v_estimate
  RETURNING dia INTO v_updated;

  IF v_updated IS NULL THEN
    INSERT INTO chat_private.budget_daily (dia, gasto_usd)
    VALUES (v_day, v_actual)
    ON CONFLICT (dia) DO UPDATE
    SET gasto_usd = chat_private.budget_daily.gasto_usd + EXCLUDED.gasto_usd;
  END IF;

  IF v_conta_nova THEN
    UPDATE chat_private.budget_new_accounts
    SET reservado_usd = reservado_usd - v_estimate,
        gasto_usd = gasto_usd + v_actual
    WHERE dia = v_day
      AND reservado_usd >= v_estimate
    RETURNING dia INTO v_updated;

    IF v_updated IS NULL THEN
      INSERT INTO chat_private.budget_new_accounts (dia, gasto_usd)
      VALUES (v_day, v_actual)
      ON CONFLICT (dia) DO UPDATE
      SET gasto_usd = chat_private.budget_new_accounts.gasto_usd + EXCLUDED.gasto_usd;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'noop', false, 'day', v_day);
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_budget_release(
  p_pedido_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_estado text;
  v_day date;
  v_estimate numeric(14, 6);
  v_updated date;
  v_found boolean;
  v_conta_nova boolean;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  SELECT estado, dia, estimado_usd, conta_nova
    INTO v_estado, v_day, v_estimate, v_conta_nova
  FROM chat_private.reserva_pedido
  WHERE pedido_id = p_pedido_id
    AND dominio = 'orcamento'
  FOR UPDATE;
  v_found := FOUND;

  PERFORM chat_private.chat_pause_settle();

  IF NOT v_found OR v_estado IS DISTINCT FROM 'reservado' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE chat_private.budget_daily
  SET reservado_usd = reservado_usd - v_estimate
  WHERE dia = v_day
    AND reservado_usd >= v_estimate
  RETURNING dia INTO v_updated;

  IF v_conta_nova THEN
    UPDATE chat_private.budget_new_accounts
    SET reservado_usd = reservado_usd - v_estimate
    WHERE dia = v_day
      AND reservado_usd >= v_estimate;
  END IF;

  UPDATE chat_private.reserva_pedido
  SET estado = 'liberado'
  WHERE pedido_id = p_pedido_id
    AND dominio = 'orcamento'
    AND estado = 'reservado';

  RETURN jsonb_build_object('ok', true, 'noop', false, 'day', v_day);
END;
$$;

REVOKE ALL ON FUNCTION chat_private.chat_ip_rate_touch(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chat_private.chat_new_account_rate_touch(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chat_private.chat_budget_reserve(uuid, numeric, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_private.chat_ip_rate_touch(text) TO chat_fn;
GRANT EXECUTE ON FUNCTION chat_private.chat_new_account_rate_touch(text) TO chat_fn;
GRANT EXECUTE ON FUNCTION chat_private.chat_budget_reserve(uuid, numeric, numeric, boolean) TO chat_fn;

DO $revoke_api$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION chat_private.chat_ip_rate_touch(text) FROM anon;
    REVOKE ALL ON FUNCTION chat_private.chat_new_account_rate_touch(text) FROM anon;
    REVOKE ALL ON FUNCTION chat_private.chat_budget_reserve(uuid, numeric, numeric, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION chat_private.chat_ip_rate_touch(text) FROM authenticated;
    REVOKE ALL ON FUNCTION chat_private.chat_new_account_rate_touch(text) FROM authenticated;
    REVOKE ALL ON FUNCTION chat_private.chat_budget_reserve(uuid, numeric, numeric, boolean) FROM authenticated;
  END IF;
END
$revoke_api$;

REVOKE ALL ON TABLE chat_private.chat_ip_rate_events FROM PUBLIC;
REVOKE ALL ON TABLE chat_private.chat_new_account_events FROM PUBLIC;
REVOKE ALL ON TABLE chat_private.budget_new_accounts FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON chat_private.chat_ip_rate_events TO chat_fn;
GRANT SELECT, INSERT, DELETE ON chat_private.chat_new_account_events TO chat_fn;
GRANT SELECT, INSERT, UPDATE ON chat_private.budget_new_accounts TO chat_fn;
GRANT DELETE ON chat_private.chat_rate_events TO chat_fn;

DO $revoke_tables$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE chat_private.chat_ip_rate_events FROM anon;
    REVOKE ALL ON TABLE chat_private.chat_new_account_events FROM anon;
    REVOKE ALL ON TABLE chat_private.budget_new_accounts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE chat_private.chat_ip_rate_events FROM authenticated;
    REVOKE ALL ON TABLE chat_private.chat_new_account_events FROM authenticated;
    REVOKE ALL ON TABLE chat_private.budget_new_accounts FROM authenticated;
  END IF;
END
$revoke_tables$;

ALTER TABLE chat_private.chat_ip_rate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.chat_new_account_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.budget_new_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_fn_select ON chat_private.chat_ip_rate_events;
DROP POLICY IF EXISTS chat_fn_insert ON chat_private.chat_ip_rate_events;
DROP POLICY IF EXISTS chat_fn_delete_old ON chat_private.chat_ip_rate_events;
CREATE POLICY chat_fn_select ON chat_private.chat_ip_rate_events
  FOR SELECT TO chat_fn USING (true);
CREATE POLICY chat_fn_insert ON chat_private.chat_ip_rate_events
  FOR INSERT TO chat_fn WITH CHECK (true);
CREATE POLICY chat_fn_delete_old ON chat_private.chat_ip_rate_events
  FOR DELETE TO chat_fn USING (at < now() - interval '48 hours');

DROP POLICY IF EXISTS chat_fn_select ON chat_private.chat_new_account_events;
DROP POLICY IF EXISTS chat_fn_insert ON chat_private.chat_new_account_events;
DROP POLICY IF EXISTS chat_fn_delete_old ON chat_private.chat_new_account_events;
CREATE POLICY chat_fn_select ON chat_private.chat_new_account_events
  FOR SELECT TO chat_fn USING (true);
CREATE POLICY chat_fn_insert ON chat_private.chat_new_account_events
  FOR INSERT TO chat_fn WITH CHECK (true);
CREATE POLICY chat_fn_delete_old ON chat_private.chat_new_account_events
  FOR DELETE TO chat_fn USING (at < now() - interval '48 hours');

DROP POLICY IF EXISTS chat_fn_select ON chat_private.budget_new_accounts;
DROP POLICY IF EXISTS chat_fn_insert ON chat_private.budget_new_accounts;
DROP POLICY IF EXISTS chat_fn_update ON chat_private.budget_new_accounts;
CREATE POLICY chat_fn_select ON chat_private.budget_new_accounts
  FOR SELECT TO chat_fn USING (true);
CREATE POLICY chat_fn_insert ON chat_private.budget_new_accounts
  FOR INSERT TO chat_fn WITH CHECK (true);
CREATE POLICY chat_fn_update ON chat_private.budget_new_accounts
  FOR UPDATE TO chat_fn USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chat_fn_delete_old ON chat_private.chat_rate_events;
CREATE POLICY chat_fn_delete_old ON chat_private.chat_rate_events
  FOR DELETE TO chat_fn USING (at < now() - interval '48 hours');

INSERT INTO schema_migrations (version, name)
VALUES ('012', 'Limites por IP e teto das contas novas')
ON CONFLICT (version) DO NOTHING;
