-- UX3c: papel LOGIN chat_fn e tabelas de crédito/cota do chat.
-- Idempotente. Sem senha e sem DSN. Não altera 001, 002 nem 003.
-- Sem meta-comando de cliente: o mesmo script vale no psql e no
-- executor SQL do Postgres gerenciado.
--
-- No PostgreSQL 17 o CREATE ROLE entra na transação e desfaz com ela.
-- Se o papel já existe, o CREATE não roda.
-- Não se mexe em atributo reservado a superusuário. Um papel que já
-- tenha privilégio acima do login comum é recusado antes de qualquer GRANT.
-- Login e herança, se faltarem num papel já seguro, são ajustados.
--
-- A senha não entra neste arquivo. Quem opera o projeto define a senha
-- no SQL Editor. A connection string (pooler transaction, porta 6543)
-- fica no secret ATLAS_CHAT_DB_URL.

BEGIN;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_writer')
     OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'chat_private') THEN
    RAISE EXCEPTION '004 exige a migração 002 (atlas_reader, chat_writer, schema chat_private)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_fn') THEN
    CREATE ROLE chat_fn LOGIN INHERIT;
  END IF;
END
$pre$;

DO $guard$
DECLARE
  r record;
BEGIN
  SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls
    INTO r
  FROM pg_roles
  WHERE rolname = 'chat_fn';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_fn não foi criado';
  END IF;

  IF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION 'chat_fn recusado: atributos acima do menor privilégio';
  END IF;

  IF NOT r.rolcanlogin OR NOT r.rolinherit THEN
    ALTER ROLE chat_fn WITH LOGIN INHERIT;
  END IF;
END
$guard$;

ALTER ROLE chat_fn SET statement_timeout = '15s';
ALTER ROLE chat_fn SET idle_in_transaction_session_timeout = '10s';

COMMENT ON ROLE chat_fn IS
  'Login da Edge Function chat. Membro de atlas_reader e chat_writer. Sem senha no repositório: a senha é definida no SQL Editor, fora deste arquivo.';

GRANT atlas_reader TO chat_fn;
GRANT chat_writer TO chat_fn;

-- Créditos pagos e cota grátis. A função grava; o client autenticado,
-- quando a UX4 conceder SELECT, só lê a própria linha.
CREATE TABLE IF NOT EXISTS chat_private.credit_balances (
  user_id uuid PRIMARY KEY,
  paid_credits integer NOT NULL DEFAULT 0 CHECK (paid_credits >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_private.credit_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL,
  conversa_id text,
  pedido_id uuid,
  modelo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $reason$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_ledger_reason_check'
      AND conrelid = 'chat_private.credit_ledger'::regclass
  ) THEN
    ALTER TABLE chat_private.credit_ledger
      ADD CONSTRAINT credit_ledger_reason_check
      CHECK (reason IN (
        'free_grant_daily',
        'purchase',
        'chat_debit',
        'chat_reserve',
        'chat_reserve_release',
        'refund',
        'adjust'
      ));
  END IF;
END
$reason$;

-- day é a data civil America/Sao_Paulo. used_basico já commitado;
-- reserved_basico é a reserva ainda aberta. Os dois juntos não passam de 20.
CREATE TABLE IF NOT EXISTS chat_private.free_quota_daily (
  user_id uuid NOT NULL,
  day date NOT NULL,
  used_basico integer NOT NULL DEFAULT 0,
  reserved_basico integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day),
  CHECK (used_basico >= 0 AND reserved_basico >= 0),
  CHECK (used_basico + reserved_basico <= 20)
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx
  ON chat_private.credit_ledger (user_id, created_at);

CREATE INDEX IF NOT EXISTS chat_logs_created_at_idx
  ON chat_private.chat_logs (created_at);

-- pedido_id nasce com a tabela. O ADD cobre um 004 anterior, ainda sem esta coluna.
ALTER TABLE chat_private.credit_ledger
  ADD COLUMN IF NOT EXISTS pedido_id uuid;

-- Uma linha por (pedido, motivo). conversa_id não fecha a reserva: duas perguntas
-- na mesma conversa são dois pedidos. NULL continua permitido para linha antiga.
DO $pedido_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_ledger_pedido_reason_unique'
      AND conrelid = 'chat_private.credit_ledger'::regclass
  ) THEN
    ALTER TABLE chat_private.credit_ledger
      ADD CONSTRAINT credit_ledger_pedido_reason_unique UNIQUE (pedido_id, reason);
  END IF;
END
$pedido_unique$;

-- Teto de US$ 3 do dia civil. gasto_usd é o que já foi reconciliado;
-- reservado_usd é a estimativa ainda aberta. A reserva cabe só se a soma
-- com o custo estimado não passa do teto.
CREATE TABLE IF NOT EXISTS chat_private.budget_daily (
  dia date PRIMARY KEY,
  gasto_usd numeric(14, 6) NOT NULL DEFAULT 0,
  reservado_usd numeric(14, 6) NOT NULL DEFAULT 0,
  CHECK (gasto_usd >= 0),
  CHECK (reservado_usd >= 0)
);

COMMENT ON TABLE chat_private.credit_balances IS
  'Saldo de créditos pagos do chat. Sem texto de pergunta.';

COMMENT ON TABLE chat_private.credit_ledger IS
  'Movimentos de crédito. A idempotência é o pedido_id (uuid gerado no servidor), não a conversa. chat_reserve de cota grátis usa delta 0. chat_reserve pago usa delta negativo e já baixa o saldo. chat_debit confirma a reserva com delta 0. chat_reserve_release devolve o saldo pago. Sem texto de pergunta.';

COMMENT ON TABLE chat_private.budget_daily IS
  'Teto diário do chat em America/Sao_Paulo. A reserva não autoriza acima de US$ 3. gasto_usd grava o custo informado, sem cortar um estouro real.';

-- Uma chamada paga por vez. O prazo fica acima do aborto do modelo;
-- expirar no meio da chamada deixaria a segunda sair com a primeira ainda no provedor.
CREATE TABLE IF NOT EXISTS chat_private.paid_lease (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  pedido_id uuid,
  acquired_at timestamptz,
  expires_at timestamptz
);

INSERT INTO chat_private.paid_lease (singleton) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE chat_private.paid_lease ENABLE ROW LEVEL SECURITY;

-- Uma linha por pedido e domínio. Estado só sai de reservado, com FOR UPDATE.
CREATE TABLE IF NOT EXISTS chat_private.reserva_pedido (
  pedido_id uuid NOT NULL,
  dominio text NOT NULL,
  estado text NOT NULL,
  dia date NOT NULL,
  user_id uuid,
  modelo text,
  kind text,
  custo integer,
  estimado_usd numeric(14, 6),
  real_usd numeric(14, 6),
  PRIMARY KEY (pedido_id, dominio),
  CHECK (dominio IN ('credito', 'orcamento')),
  CHECK (estado IN ('reservado', 'confirmado', 'liberado'))
);

COMMENT ON TABLE chat_private.reserva_pedido IS
  'Reserva de crédito ou de orçamento por pedido_id. Sem texto de pergunta. O dia é o de America/Sao_Paulo gravado na reserva.';

COMMENT ON TABLE chat_private.free_quota_daily IS
  'Cota diária de 20 perguntas Básicas por usuário, no dia civil America/Sao_Paulo. Avançado não usa esta cota.';

-- Escrita só pelos papéis do chat. Sem privilégio novo em public.
GRANT USAGE ON SCHEMA chat_private TO chat_fn;
GRANT SELECT, INSERT, UPDATE ON chat_private.credit_balances TO chat_writer, chat_fn;
GRANT SELECT, INSERT ON chat_private.credit_ledger TO chat_writer, chat_fn;
GRANT SELECT, INSERT, UPDATE ON chat_private.free_quota_daily TO chat_writer, chat_fn;
GRANT SELECT, INSERT, UPDATE ON chat_private.budget_daily TO chat_writer, chat_fn;
GRANT SELECT, INSERT, UPDATE ON chat_private.reserva_pedido TO chat_writer, chat_fn;
GRANT SELECT, INSERT ON chat_private.chat_logs TO chat_writer, chat_fn;
GRANT SELECT, INSERT ON chat_private.chat_rate_events TO chat_writer, chat_fn;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chat_private TO chat_writer, chat_fn;

ALTER DEFAULT PRIVILEGES IN SCHEMA chat_private
  GRANT USAGE, SELECT ON SEQUENCES TO chat_writer, chat_fn;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM chat_fn;

REVOKE ALL ON SCHEMA chat_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA chat_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_private FROM PUBLIC;

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

-- chat_context continua só com atlas_reader. chat_fn herda o EXECUTE.
-- anon, authenticated e PUBLIC seguem sem EXECUTE.
REVOKE EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) FROM PUBLIC;

DO $revoke_ctx$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) FROM authenticated';
  END IF;
END
$revoke_ctx$;

GRANT EXECUTE ON FUNCTION public.chat_context(text[], text, integer, integer) TO atlas_reader;

-- chat_logs e chat_rate_events nasceram na 002 com policy só para chat_writer.
-- chat_fn entra na mesma policy (além de herdar o papel).
DO $old_private$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['chat_logs', 'chat_rate_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_select ON chat_private.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_insert ON chat_private.%I', tbl);
    EXECUTE format(
      'CREATE POLICY chat_writer_select ON chat_private.%I FOR SELECT TO chat_writer, chat_fn USING (true)',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY chat_writer_insert ON chat_private.%I FOR INSERT TO chat_writer, chat_fn WITH CHECK (true)',
      tbl
    );
  END LOOP;
END
$old_private$;

ALTER TABLE chat_private.credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.free_quota_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.budget_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.reserva_pedido ENABLE ROW LEVEL SECURITY;

-- Leitura própria para quando a UX4 conceder USAGE/SELECT ao authenticated.
-- Não há policy de INSERT/UPDATE para authenticated: o client não escreve.
-- auth.uid() existe no Supabase. A policy é criada só se a função existir.
DO $rls$
DECLARE
  tbl text;
  tables text[] := ARRAY['credit_balances', 'credit_ledger', 'free_quota_daily'];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS chat_owner_select ON chat_private.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_select ON chat_private.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_insert ON chat_private.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS chat_writer_update ON chat_private.%I', tbl);
    EXECUTE format(
      'CREATE POLICY chat_writer_select ON chat_private.%I FOR SELECT TO chat_writer, chat_fn USING (true)',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY chat_writer_insert ON chat_private.%I FOR INSERT TO chat_writer, chat_fn WITH CHECK (true)',
      tbl
    );
  END LOOP;

  EXECUTE 'CREATE POLICY chat_writer_update ON chat_private.credit_balances FOR UPDATE TO chat_writer, chat_fn USING (true) WITH CHECK (true)';
  EXECUTE 'CREATE POLICY chat_writer_update ON chat_private.free_quota_daily FOR UPDATE TO chat_writer, chat_fn USING (true) WITH CHECK (true)';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_select ON chat_private.budget_daily';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_insert ON chat_private.budget_daily';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_update ON chat_private.budget_daily';
  EXECUTE 'CREATE POLICY chat_writer_select ON chat_private.budget_daily FOR SELECT TO chat_writer, chat_fn USING (true)';
  EXECUTE 'CREATE POLICY chat_writer_insert ON chat_private.budget_daily FOR INSERT TO chat_writer, chat_fn WITH CHECK (true)';
  EXECUTE 'CREATE POLICY chat_writer_update ON chat_private.budget_daily FOR UPDATE TO chat_writer, chat_fn USING (true) WITH CHECK (true)';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_select ON chat_private.reserva_pedido';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_insert ON chat_private.reserva_pedido';
  EXECUTE 'DROP POLICY IF EXISTS chat_writer_update ON chat_private.reserva_pedido';
  EXECUTE 'CREATE POLICY chat_writer_select ON chat_private.reserva_pedido FOR SELECT TO chat_writer, chat_fn USING (true)';
  EXECUTE 'CREATE POLICY chat_writer_insert ON chat_private.reserva_pedido FOR INSERT TO chat_writer, chat_fn WITH CHECK (true)';
  EXECUTE 'CREATE POLICY chat_writer_update ON chat_private.reserva_pedido FOR UPDATE TO chat_writer, chat_fn USING (true) WITH CHECK (true)';

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    FOREACH tbl IN ARRAY tables LOOP
      EXECUTE format(
        'CREATE POLICY chat_owner_select ON chat_private.%I FOR SELECT TO authenticated USING (user_id = auth.uid())',
        tbl
      );
    END LOOP;
  END IF;
END
$rls$;

-- atlas.chat_now é só para o teste da virada. Vazio, vale now().
CREATE OR REPLACE FUNCTION chat_private.chat_day_saopaulo()
RETURNS date
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
  SELECT (timezone('America/Sao_Paulo',
    CASE
      WHEN coalesce(current_setting('atlas.chat_now', true), '') = '' THEN now()
      ELSE current_setting('atlas.chat_now', true)::timestamptz
    END
  ))::date;
$$;

COMMENT ON FUNCTION chat_private.chat_day_saopaulo() IS
  'Data civil America/Sao_Paulo. Sem horário de verão desde 2019.';

CREATE OR REPLACE FUNCTION chat_private.chat_budget_spent_today()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
  SELECT coalesce(sum(custo_usd), 0)
  FROM chat_private.chat_logs
  WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = chat_private.chat_day_saopaulo();
$$;

COMMENT ON FUNCTION chat_private.chat_budget_spent_today() IS
  'Soma de chat_logs.custo_usd no dia civil America/Sao_Paulo. Não lê texto de pergunta.';

-- Insere o evento e devolve as contagens já com ele.
-- A Edge Function recusa acima de 10 no minuto e de 200 no dia civil.
CREATE OR REPLACE FUNCTION chat_private.chat_rate_touch(p_user_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_day date := chat_private.chat_day_saopaulo();
  v_minute integer;
  v_day_count integer;
  v_oldest timestamptz;
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

  RETURN jsonb_build_object(
    'ok', true,
    'minute_count', v_minute,
    'day_count', v_day_count,
    'oldest_minute', v_oldest
  );
END;
$$;

-- Assinatura antiga usava a conversa como chave. Some para não ficar sobrecarga.
DROP FUNCTION IF EXISTS chat_private.chat_reserve_credits(uuid, text, text);
DROP FUNCTION IF EXISTS chat_private.chat_commit_credits(uuid, text, text, integer, date, text);
DROP FUNCTION IF EXISTS chat_private.chat_release_reserve(uuid, text, text, integer, date, text);

-- Reserva atômica por pedido_id. Básico gasta 1 grátis (até 20 no dia) antes do saldo pago.
-- Avançado gasta 8 créditos pagos e nunca mexe na cota grátis.
-- Saldo insuficiente não grava reserva.
-- Contabilidade do ledger: ver o comentário de credit_ledger.
CREATE OR REPLACE FUNCTION chat_private.chat_reserve_credits(
  p_user_id uuid,
  p_modelo text,
  p_pedido_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_day date := chat_private.chat_day_saopaulo();
  v_cost integer;
  v_used integer;
  v_reserved integer;
  v_paid integer;
  v_kind text;
  v_gratis integer;
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
$$;

-- Segura a transição o bastante para a outra conexão bloquear no FOR UPDATE.
-- Sem a GUC, não dorme. Não lê texto de pergunta.
CREATE OR REPLACE FUNCTION chat_private.chat_pause_settle()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_ms numeric;
BEGIN
  IF coalesce(current_setting('atlas.settle_pause_ms', true), '') = '' THEN
    RETURN;
  END IF;
  v_ms := current_setting('atlas.settle_pause_ms', true)::numeric;
  IF v_ms > 0 THEN
    PERFORM pg_sleep(v_ms / 1000.0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_commit_credits(
  p_user_id uuid,
  p_modelo text,
  p_kind text,
  p_cost integer,
  p_day date,
  p_pedido_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
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
      'gratis_restantes', greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)),
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
    'gratis_restantes', greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)),
    'pago', coalesce(v_paid, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_release_reserve(
  p_user_id uuid,
  p_modelo text,
  p_kind text,
  p_cost integer,
  p_day date,
  p_pedido_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
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
    'gratis_restantes', greatest(0, 20 - coalesce(v_used, 0) - coalesce(v_reserved, 0)),
    'pago', coalesce(v_paid, 0)
  );
END;
$$;

-- Assinatura antiga recebia o dia calculado na aplicação. O dia agora é o do SQL.
DROP FUNCTION IF EXISTS chat_private.chat_budget_reserve(date, numeric, numeric);
DROP FUNCTION IF EXISTS chat_private.chat_budget_commit(date, numeric, numeric);
DROP FUNCTION IF EXISTS chat_private.chat_budget_release(date, numeric);

-- Segura o custo estimado no dia civil decidido aqui. Duas conexões disputam o UPDATE.
CREATE OR REPLACE FUNCTION chat_private.chat_budget_reserve(
  p_pedido_id uuid,
  p_estimate numeric,
  p_cap numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = chat_private, public
AS $$
DECLARE
  v_day date := chat_private.chat_day_saopaulo();
  v_estimate numeric(14, 6);
  v_cap numeric(14, 6);
  v_updated date;
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
  -- O parâmetro não pode subir o teto. Valor maior que 3 vira 3.
  v_cap := least(round(p_cap, 6), 3);

  INSERT INTO chat_private.budget_daily (dia)
  VALUES (v_day)
  ON CONFLICT (dia) DO NOTHING;

  UPDATE chat_private.budget_daily
  SET reservado_usd = reservado_usd + v_estimate
  WHERE dia = v_day
    AND gasto_usd + reservado_usd + v_estimate <= v_cap
  RETURNING dia INTO v_updated;

  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'orcamento_esgotado');
  END IF;

  INSERT INTO chat_private.reserva_pedido (pedido_id, dominio, estado, dia, estimado_usd)
  VALUES (p_pedido_id, 'orcamento', 'reservado', v_day, v_estimate);

  RETURN jsonb_build_object('ok', true, 'day', v_day);
END;
$$;

-- Grava o custo informado por inteiro, mesmo acima da reserva. Não esconde estouro.
-- A reserva é que não passa de US$ 3. A segunda chamada do mesmo pedido é noop.
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
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pedido_invalido');
  END IF;

  SELECT estado, dia, estimado_usd
    INTO v_estado, v_day, v_estimate
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
    -- Sem linha de reserva este custo não estava autorizado. Cabe inteiro
    -- ou não entra: o valor informado não é reduzido para caber.
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

  RETURN jsonb_build_object('ok', true, 'noop', false, 'day', v_day);
END;
$$;

-- Devolve a estimativa só se o pedido ainda está reservado. Depois do commit, é noop.
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
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  SELECT estado, dia, estimado_usd
    INTO v_estado, v_day, v_estimate
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

  UPDATE chat_private.reserva_pedido
  SET estado = 'liberado'
  WHERE pedido_id = p_pedido_id
    AND dominio = 'orcamento'
    AND estado = 'reservado';

  RETURN jsonb_build_object('ok', true, 'noop', false, 'day', v_day);
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_paid_acquire(p_pedido uuid, p_hold interval)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_ok uuid;
BEGIN
  IF p_pedido IS NULL OR p_hold IS NULL OR p_hold <= interval '0' THEN
    RETURN false;
  END IF;
  UPDATE chat_private.paid_lease
  SET pedido_id = p_pedido,
      acquired_at = clock_timestamp(),
      expires_at = clock_timestamp() + p_hold
  WHERE singleton = 1
    AND (pedido_id IS NULL OR expires_at IS NULL OR expires_at <= clock_timestamp())
  RETURNING pedido_id INTO v_ok;
  RETURN v_ok IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.chat_paid_release(p_pedido uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE chat_private.paid_lease
  SET pedido_id = NULL,
      acquired_at = NULL,
      expires_at = NULL
  WHERE singleton = 1
    AND pedido_id = p_pedido;
END;
$$;

REVOKE ALL ON SCHEMA chat_private FROM PUBLIC;

DO $fn_grants$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'chat_private'
      AND p.proname IN (
        'chat_day_saopaulo',
        'chat_budget_spent_today',
        'chat_rate_touch',
        'chat_reserve_credits',
        'chat_commit_credits',
        'chat_release_reserve',
        'chat_budget_reserve',
        'chat_budget_commit',
        'chat_budget_release',
        'chat_paid_acquire',
        'chat_paid_release',
        'chat_pause_settle'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO chat_writer, chat_fn', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
  END LOOP;
END
$fn_grants$;

INSERT INTO schema_migrations (version, name)
VALUES ('004', 'Chat function role, credit balances, daily free quota, budget helpers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
