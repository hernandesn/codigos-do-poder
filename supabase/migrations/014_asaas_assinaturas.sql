-- 014: assinaturas Asaas. Só cria objetos novos em chat_private.
-- Não altera tabelas nem funções do chat, do Telegram ou das migrações 001–013.
-- Sandbox nunca concede plano: chat_private.plano_atual lê apenas ambiente = producao.
-- Um trial por usuário no ambiente, consumido na tabela asaas_trials (UNIQUE ambiente, user_id).
-- Quem já teve assinatura é recusado com trial_ja_usado (não se abre outra com vencimento para hoje).
-- A reserva de checkout dura 60 minutos (minutesToExpire).
-- Reserva com checkout_id ou marcada incerta nunca é apagada: ao passar de 60 min fica expirada,
-- com o id interno e o checkout_id, para um webhook atrasado ainda correlacionar.
-- Antes de outro checkout o handler reconcilia GET /v3/subscriptions?customer=.
-- Três eixos: recorrencia (pendente|ativa|cancelamento_pendente|encerrada),
-- bloqueio (NULL|inadimplente|suspensa|divergente) e as datas trial_ate/pago_ate.
-- status exibido é derivado. Bloqueio ganha da recorrência.
-- Inadimplente não tem carência: bloqueia como suspensa e divergente.
-- Encerrar a recorrência não limpa bloqueio e não concede acesso que não existia.
-- Recorrência encerrada não reabre. PAYMENT_CONFIRMED depois disso não estende pago_ate.
-- Estorno, chargeback, atraso e captura recusada ainda gravam o bloqueio.
-- O cancelamento é a tabela asaas_cancelamentos (pendente|concluido|falhou), com lease de 90 segundos.
-- O webhook não mexe nessa tabela. pago_ate confirmado, fora do encerramento, nunca encolhe.
-- O webhook só liga subscription_id se checkout_id ou externalReference e o customer baterem.
-- Limites, iguais a supabase/functions/_shared/asaas_planos.ts:
--   free   basico_dia=20  avancado_ciclo=0
--   basico basico_dia=150 avancado_ciclo=20  preco_centavos=990
--   plus   basico_dia=150 avancado_ciclo=100 preco_centavos=2990
--   teto global US$ 3/dia continua valendo para todos (não entra no jsonb).
--   trial = 7 dias. Ciclo do Avançado = mês da assinatura (vencimento pago → próximo).
-- O chat ainda não consulta estes limites (fase 2).
--
-- Rollback futuro, não executado aqui:
-- BEGIN;
-- DROP FUNCTION IF EXISTS chat_private.plano_atual(uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_marcar_cancelamento(text, uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.asaas_pedir_cancelamento(text, uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_status(text, uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_aplicar_evento(text, text, text, text, text, text, text, text, numeric, date, date, timestamptz);
-- DROP FUNCTION IF EXISTS chat_private.asaas_falhar_cancelamento(text, uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.asaas_descartar_checkout(text, uuid, uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_marcar_checkout_incerto(text, uuid, uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_vincular_assinatura_remota(text, uuid, uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.asaas_vincular_checkout(text, uuid, uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.asaas_liberar_checkout(text, uuid, text, date);
-- DROP FUNCTION IF EXISTS chat_private.asaas_preparar_checkout(text, uuid, text, date);
-- DROP FUNCTION IF EXISTS chat_private.asaas_gravar_cliente(text, uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.asaas_obter_cliente(text, uuid);
-- DROP FUNCTION IF EXISTS chat_private.asaas_derivar_status();
-- DROP TABLE IF EXISTS chat_private.asaas_cancelamentos;
-- DROP TABLE IF EXISTS chat_private.asaas_eventos;
-- DROP TABLE IF EXISTS chat_private.asaas_trials;
-- DROP TABLE IF EXISTS chat_private.assinaturas;
-- DROP TABLE IF EXISTS chat_private.asaas_clientes;
-- COMMIT;

BEGIN;

CREATE TABLE chat_private.asaas_clientes (
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id text NOT NULL CHECK (customer_id ~ '^[A-Za-z0-9_]{3,64}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ambiente, user_id),
  UNIQUE (ambiente, customer_id)
);

CREATE TABLE chat_private.assinaturas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id text CHECK (subscription_id IS NULL OR subscription_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  checkout_id text CHECK (checkout_id IS NULL OR checkout_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  plano text NOT NULL CHECK (plano IN ('basico', 'plus')),
  status text NOT NULL CHECK (status IN (
    'checkout', 'trial', 'ativa', 'inadimplente', 'suspensa',
    'cancelamento_solicitado', 'cancelada', 'divergente'
  )),
  recorrencia text NOT NULL CHECK (recorrencia IN ('pendente', 'ativa', 'cancelamento_pendente', 'encerrada')),
  bloqueio text CHECK (bloqueio IS NULL OR bloqueio IN ('inadimplente', 'suspensa', 'divergente')),
  reserva text NOT NULL DEFAULT 'aberta' CHECK (reserva IN ('aberta', 'incerta', 'expirada')),
  trial_ate date,
  pago_ate date,
  preco_centavos integer CHECK (preco_centavos IS NULL OR preco_centavos IN (990, 2990)),
  next_due_planejado date,
  resultado_incerto boolean NOT NULL DEFAULT false,
  ultimo_evento_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ambiente, subscription_id),
  UNIQUE (ambiente, checkout_id)
);

CREATE INDEX assinaturas_usuario_idx ON chat_private.assinaturas (ambiente, user_id);

CREATE TABLE chat_private.asaas_eventos (
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_.:&=-]{1,120}$'),
  tipo text NOT NULL CHECK (char_length(tipo) BETWEEN 1 AND 80),
  recurso_id text CHECK (recurso_id IS NULL OR recurso_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  ignorado boolean NOT NULL DEFAULT false,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ambiente, event_id)
);

CREATE TABLE chat_private.asaas_trials (
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assinatura_id uuid,
  consumido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ambiente, user_id)
);

-- Operação de cancelamento, independente do status que o webhook altera.
-- Lease de 90 segundos. Só um processo segura a reserva. O webhook não escreve aqui.
CREATE TABLE chat_private.asaas_cancelamentos (
  ambiente text NOT NULL CHECK (ambiente IN ('sandbox', 'producao')),
  assinatura_id uuid NOT NULL REFERENCES chat_private.assinaturas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id text NOT NULL CHECK (subscription_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  estado text NOT NULL CHECK (estado IN ('pendente', 'concluido', 'falhou')),
  tentativas integer NOT NULL CHECK (tentativas >= 1),
  lease_ate timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ambiente, assinatura_id)
);

CREATE FUNCTION chat_private.asaas_derivar_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.recorrencia IS NULL THEN
    IF NEW.status = 'checkout' THEN
      NEW.recorrencia := 'pendente';
      NEW.bloqueio := NULL;
    ELSIF NEW.status = 'cancelamento_solicitado' THEN
      NEW.recorrencia := 'cancelamento_pendente';
      NEW.bloqueio := NULL;
    ELSIF NEW.status = 'cancelada' THEN
      NEW.recorrencia := 'encerrada';
      NEW.bloqueio := NULL;
    ELSIF NEW.status IN ('inadimplente', 'suspensa', 'divergente') THEN
      NEW.recorrencia := 'ativa';
      NEW.bloqueio := NEW.status;
    ELSE
      NEW.recorrencia := 'ativa';
      NEW.bloqueio := NULL;
    END IF;
  END IF;
  NEW.status := CASE
    WHEN NEW.bloqueio IS NOT NULL THEN NEW.bloqueio
    WHEN NEW.recorrencia = 'pendente' THEN 'checkout'
    WHEN NEW.recorrencia = 'cancelamento_pendente' THEN 'cancelamento_solicitado'
    WHEN NEW.recorrencia = 'encerrada' THEN 'cancelada'
    WHEN NEW.trial_ate IS NOT NULL AND NEW.pago_ate IS NULL THEN 'trial'
    ELSE 'ativa'
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER asaas_derivar_status
BEFORE INSERT OR UPDATE ON chat_private.assinaturas
FOR EACH ROW EXECUTE FUNCTION chat_private.asaas_derivar_status();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asaas_clientes', 'assinaturas', 'asaas_eventos', 'asaas_trials', 'asaas_cancelamentos'] LOOP
    EXECUTE format('ALTER TABLE chat_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE chat_private.%I FROM PUBLIC, anon, authenticated, chat_fn, chat_writer', t);
  END LOOP;
END $$;

CREATE FUNCTION chat_private.asaas_obter_cliente(p_ambiente text, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
  SELECT customer_id FROM chat_private.asaas_clientes
  WHERE ambiente = p_ambiente AND user_id = p_user;
$$;

CREATE FUNCTION chat_private.asaas_gravar_cliente(p_ambiente text, p_user uuid, p_customer text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
BEGIN
  IF p_ambiente NOT IN ('sandbox', 'producao') OR p_user IS NULL THEN RETURN; END IF;
  INSERT INTO chat_private.asaas_clientes (ambiente, user_id, customer_id)
  VALUES (p_ambiente, p_user, p_customer)
  ON CONFLICT (ambiente, user_id) DO NOTHING;
END $$;

CREATE FUNCTION chat_private.asaas_preparar_checkout(p_ambiente text, p_user uuid, p_plano text, p_next_due date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE v_id uuid; v_checkout text;
BEGIN
  IF p_ambiente NOT IN ('sandbox', 'producao') OR p_user IS NULL OR p_plano NOT IN ('basico', 'plus') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'plano_invalido');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || p_user::text, 0));
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = p_user
      AND (recorrencia IN ('ativa', 'cancelamento_pendente')
        OR (subscription_id IS NOT NULL AND recorrencia <> 'encerrada'))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'assinatura_ativa');
  END IF;
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = p_user
      AND (recorrencia IN ('ativa', 'cancelamento_pendente', 'encerrada')
        OR subscription_id IS NOT NULL OR trial_ate IS NOT NULL OR pago_ate IS NOT NULL OR bloqueio IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM chat_private.asaas_trials WHERE ambiente = p_ambiente AND user_id = p_user
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'trial_ja_usado');
  END IF;
  SELECT id, checkout_id INTO v_id, v_checkout FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva <> 'expirada'
    AND checkout_id IS NOT NULL AND atualizado_em > now() - interval '60 minutes'
  ORDER BY atualizado_em DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'assinatura_id', v_id, 'checkout_id', v_checkout, 'reutilizado', true);
  END IF;
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva <> 'expirada'
      AND checkout_id IS NULL AND atualizado_em > now() - interval '60 minutes'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'checkout_em_andamento');
  END IF;
  UPDATE chat_private.assinaturas
  SET reserva = 'expirada', atualizado_em = now()
  WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva <> 'expirada'
    AND atualizado_em <= now() - interval '60 minutes'
    AND (checkout_id IS NOT NULL OR resultado_incerto OR reserva = 'incerta');
  SELECT id INTO v_id FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva = 'expirada'
  ORDER BY (checkout_id IS NOT NULL) DESC, atualizado_em DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reconciliar', 'assinatura_id', v_id);
  END IF;
  DELETE FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva = 'aberta'
    AND checkout_id IS NULL AND resultado_incerto = false
    AND atualizado_em <= now() - interval '60 minutes';
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, recorrencia, bloqueio, reserva, preco_centavos, next_due_planejado)
  VALUES (
    p_ambiente, p_user, p_plano, 'checkout', 'pendente', NULL, 'aberta',
    CASE p_plano WHEN 'basico' THEN 990 WHEN 'plus' THEN 2990 END,
    p_next_due
  )
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'assinatura_id', v_id, 'checkout_id', NULL, 'reutilizado', false);
END $$;

CREATE FUNCTION chat_private.asaas_liberar_checkout(p_ambiente text, p_user uuid, p_plano text, p_next_due date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_ambiente NOT IN ('sandbox', 'producao') OR p_user IS NULL OR p_plano NOT IN ('basico', 'plus') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'plano_invalido');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || p_user::text, 0));
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = p_user
      AND (recorrencia IN ('ativa', 'cancelamento_pendente')
        OR (subscription_id IS NOT NULL AND recorrencia <> 'encerrada'))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'assinatura_ativa');
  END IF;
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente' AND reserva = 'aberta'
      AND atualizado_em > now() - interval '60 minutes'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'checkout_em_andamento');
  END IF;
  INSERT INTO chat_private.assinaturas (ambiente, user_id, plano, status, recorrencia, bloqueio, reserva, preco_centavos, next_due_planejado)
  VALUES (
    p_ambiente, p_user, p_plano, 'checkout', 'pendente', NULL, 'aberta',
    CASE p_plano WHEN 'basico' THEN 990 WHEN 'plus' THEN 2990 END,
    p_next_due
  )
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'assinatura_id', v_id, 'checkout_id', NULL, 'reutilizado', false);
END $$;

CREATE FUNCTION chat_private.asaas_vincular_checkout(p_ambiente text, p_user uuid, p_assinatura uuid, p_checkout text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE n integer;
BEGIN
  UPDATE chat_private.assinaturas
  SET checkout_id = p_checkout, resultado_incerto = false, reserva = 'aberta', atualizado_em = now()
  WHERE id = p_assinatura AND ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'checkout_ausente' USING ERRCODE = 'P0001'; END IF;
END $$;

CREATE FUNCTION chat_private.asaas_vincular_assinatura_remota(p_ambiente text, p_user uuid, p_assinatura uuid, p_subscription text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND subscription_id = p_subscription AND id <> p_assinatura
  ) THEN
    RAISE EXCEPTION 'sub_duplicada' USING ERRCODE = 'P0001';
  END IF;
  UPDATE chat_private.assinaturas
  SET subscription_id = p_subscription,
      recorrencia = CASE WHEN recorrencia = 'encerrada' THEN recorrencia ELSE 'ativa' END,
      atualizado_em = now()
  WHERE id = p_assinatura AND ambiente = p_ambiente AND user_id = p_user AND recorrencia <> 'encerrada';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'checkout_ausente' USING ERRCODE = 'P0001'; END IF;
END $$;

CREATE FUNCTION chat_private.asaas_descartar_checkout(p_ambiente text, p_user uuid, p_assinatura uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
  DELETE FROM chat_private.assinaturas
  WHERE id = p_assinatura AND ambiente = p_ambiente AND user_id = p_user
    AND recorrencia = 'pendente' AND reserva = 'aberta' AND checkout_id IS NULL AND resultado_incerto = false;
$$;

CREATE FUNCTION chat_private.asaas_marcar_checkout_incerto(p_ambiente text, p_user uuid, p_assinatura uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
  UPDATE chat_private.assinaturas
  SET resultado_incerto = true, reserva = 'incerta', atualizado_em = now()
  WHERE id = p_assinatura AND ambiente = p_ambiente AND user_id = p_user AND recorrencia = 'pendente';
$$;

CREATE FUNCTION chat_private.asaas_aplicar_evento(
  p_ambiente text,
  p_event_id text,
  p_tipo text,
  p_recurso_id text,
  p_subscription_id text,
  p_customer_id text,
  p_checkout_id text,
  p_external_reference text,
  p_valor numeric,
  p_vencimento date,
  p_next_due date,
  p_quando timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE
  n integer;
  v_user uuid;
  v_row chat_private.assinaturas%ROWTYPE;
  v_found boolean := false;
  v_quando timestamptz;
  v_centavos integer;
  v_esperado integer;
  v_plano text;
  v_pago date;
  v_sub uuid;
  v_chk uuid;
  v_ref uuid;
  v_id uuid;
  v_ignorar boolean := false;
  v_ok boolean;
  v_catalogo integer;
  v_historico boolean;
BEGIN
  IF p_ambiente NOT IN ('sandbox', 'producao')
     OR p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_.:&=-]{1,120}$'
     OR p_tipo IS NULL OR char_length(p_tipo) < 1 OR char_length(p_tipo) > 80 THEN
    RETURN jsonb_build_object('aplicado', false, 'duplicado', false, 'erro', 'pedido_invalido');
  END IF;
  INSERT INTO chat_private.asaas_eventos (ambiente, event_id, tipo, recurso_id)
  VALUES (p_ambiente, p_event_id, p_tipo, p_recurso_id)
  ON CONFLICT (ambiente, event_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RETURN jsonb_build_object('aplicado', false, 'duplicado', true);
  END IF;
  v_quando := coalesce(p_quando, now());
  v_centavos := CASE WHEN p_valor IS NULL THEN NULL ELSE round(p_valor * 100)::integer END;
  SELECT user_id INTO v_user FROM chat_private.asaas_clientes
  WHERE ambiente = p_ambiente AND customer_id = p_customer_id;
  IF v_user IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || v_user::text, 0));
  END IF;
  v_sub := NULL;
  v_chk := NULL;
  v_ref := NULL;
  IF p_subscription_id IS NOT NULL THEN
    SELECT id INTO v_sub FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND subscription_id = p_subscription_id;
  END IF;
  IF p_checkout_id IS NOT NULL THEN
    SELECT id INTO v_chk FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND checkout_id = p_checkout_id;
  END IF;
  IF p_external_reference IS NOT NULL THEN
    SELECT id INTO v_ref FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND id::text = p_external_reference;
  END IF;
  IF v_chk IS NOT NULL AND v_ref IS NOT NULL AND v_chk <> v_ref THEN
    v_ignorar := true;
  ELSIF v_sub IS NOT NULL AND coalesce(v_chk, v_ref) IS NOT NULL AND v_sub <> coalesce(v_chk, v_ref) THEN
    v_ignorar := true;
  ELSIF v_sub IS NOT NULL THEN
    v_id := v_sub;
  ELSIF coalesce(v_chk, v_ref) IS NOT NULL THEN
    v_id := coalesce(v_chk, v_ref);
  END IF;
  IF NOT v_ignorar AND v_id IS NOT NULL THEN
    SELECT * INTO v_row FROM chat_private.assinaturas WHERE id = v_id;
    v_found := FOUND;
    IF v_found AND v_sub IS NULL AND (v_user IS NULL OR v_row.user_id IS DISTINCT FROM v_user
       OR (p_subscription_id IS NOT NULL AND v_row.subscription_id IS NOT NULL AND v_row.subscription_id IS DISTINCT FROM p_subscription_id)) THEN
      v_ignorar := true;
      v_found := false;
    ELSIF v_found AND v_sub IS NOT NULL AND v_user IS NOT NULL AND v_row.user_id IS DISTINCT FROM v_user THEN
      v_ignorar := true;
      v_found := false;
    END IF;
  END IF;
  IF NOT v_ignorar AND NOT v_found AND p_subscription_id IS NOT NULL AND v_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM chat_private.assinaturas
    WHERE ambiente = p_ambiente AND user_id = v_user AND status <> 'cancelada'
      AND subscription_id IS DISTINCT FROM p_subscription_id
  ) THEN
    v_ignorar := true;
  END IF;
  IF v_ignorar THEN
    UPDATE chat_private.asaas_eventos SET ignorado = true
    WHERE ambiente = p_ambiente AND event_id = p_event_id;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'ignorado', true);
  END IF;
  IF NOT v_found AND v_user IS NULL THEN
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'sem_cliente', true);
  END IF;
  IF v_found THEN
    IF v_user IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || v_row.user_id::text, 0));
    END IF;
    SELECT * INTO v_row FROM chat_private.assinaturas WHERE id = v_row.id FOR UPDATE;
    v_found := FOUND;
  ELSIF v_user IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || v_user::text, 0));
  END IF;
  IF v_found AND v_row.ultimo_evento_em IS NOT NULL AND v_quando < v_row.ultimo_evento_em THEN
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'antigo', true);
  END IF;

  IF p_tipo IN ('SUBSCRIPTION_CREATED', 'CHECKOUT_PAID') THEN
    IF v_found AND v_row.recorrencia = 'encerrada' THEN
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'terminal', true);
    END IF;
    IF NOT v_found OR v_row.status <> 'checkout' OR v_row.recorrencia <> 'pendente' THEN
      IF v_found AND (v_row.status <> 'checkout' OR v_row.recorrencia <> 'pendente') THEN
        UPDATE chat_private.assinaturas SET
          subscription_id = coalesce(subscription_id, p_subscription_id),
          checkout_id = coalesce(checkout_id, p_checkout_id),
          resultado_incerto = false,
          ultimo_evento_em = v_quando,
          atualizado_em = now()
        WHERE id = v_row.id AND recorrencia <> 'encerrada'
          AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
      ELSE
        UPDATE chat_private.asaas_eventos SET ignorado = true
        WHERE ambiente = p_ambiente AND event_id = p_event_id;
        RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'ignorado', true);
      END IF;
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
    END IF;
    v_catalogo := CASE v_row.plano WHEN 'basico' THEN 990 WHEN 'plus' THEN 2990 ELSE NULL END;
    v_ok := v_row.preco_centavos IS NOT NULL
      AND v_catalogo IS NOT NULL
      AND v_row.preco_centavos = v_catalogo
      AND v_centavos IS NOT NULL
      AND v_centavos = v_row.preco_centavos
      AND p_next_due IS NOT NULL
      AND v_row.next_due_planejado IS NOT NULL
      AND abs(p_next_due - v_row.next_due_planejado) <= 1;
    v_historico := EXISTS (
      SELECT 1 FROM chat_private.assinaturas s
      WHERE s.ambiente = p_ambiente AND s.user_id = v_row.user_id AND s.id <> v_row.id
        AND (s.status IN ('trial', 'ativa', 'inadimplente', 'suspensa', 'cancelamento_solicitado', 'cancelada', 'divergente')
          OR s.subscription_id IS NOT NULL OR s.trial_ate IS NOT NULL OR s.pago_ate IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM chat_private.asaas_trials t
      WHERE t.ambiente = p_ambiente AND t.user_id = v_row.user_id
    );
    IF v_ok IS NOT TRUE OR v_historico THEN
      UPDATE chat_private.assinaturas SET
        subscription_id = coalesce(subscription_id, p_subscription_id),
        checkout_id = coalesce(checkout_id, p_checkout_id),
        recorrencia = 'ativa',
        bloqueio = 'divergente',
        reserva = 'aberta',
        resultado_incerto = false,
        ultimo_evento_em = v_quando,
        atualizado_em = now()
      WHERE id = v_row.id AND status = 'checkout' AND recorrencia = 'pendente'
        AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'divergente', true);
    END IF;
    INSERT INTO chat_private.asaas_trials (ambiente, user_id, assinatura_id)
    VALUES (p_ambiente, v_row.user_id, v_row.id)
    ON CONFLICT (ambiente, user_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      UPDATE chat_private.assinaturas SET
        subscription_id = coalesce(subscription_id, p_subscription_id),
        checkout_id = coalesce(checkout_id, p_checkout_id),
        recorrencia = 'ativa',
        bloqueio = 'divergente',
        reserva = 'aberta',
        resultado_incerto = false,
        ultimo_evento_em = v_quando,
        atualizado_em = now()
      WHERE id = v_row.id AND status = 'checkout' AND recorrencia = 'pendente'
        AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'divergente', true);
    END IF;
    UPDATE chat_private.assinaturas SET
      subscription_id = coalesce(subscription_id, p_subscription_id),
      checkout_id = coalesce(checkout_id, p_checkout_id),
      recorrencia = 'ativa',
      bloqueio = NULL,
      reserva = 'aberta',
      trial_ate = p_next_due,
      resultado_incerto = false,
      ultimo_evento_em = v_quando,
      atualizado_em = now()
    WHERE id = v_row.id AND status = 'checkout' AND recorrencia = 'pendente'
      AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      DELETE FROM chat_private.asaas_trials
      WHERE ambiente = p_ambiente AND user_id = v_row.user_id AND assinatura_id = v_row.id;
    END IF;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
  END IF;

  IF p_tipo IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') THEN
    IF v_found AND v_row.recorrencia = 'encerrada' THEN
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'terminal', true);
    END IF;
    v_pago := CASE WHEN p_vencimento IS NULL THEN NULL ELSE (p_vencimento + interval '1 month')::date END;
    IF NOT v_found THEN
      v_plano := CASE v_centavos WHEN 990 THEN 'basico' WHEN 2990 THEN 'plus' ELSE NULL END;
      IF v_user IS NULL OR v_plano IS NULL OR v_pago IS NULL THEN
        RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
      END IF;
      INSERT INTO chat_private.assinaturas (ambiente, user_id, subscription_id, checkout_id, plano, status, recorrencia, bloqueio, pago_ate, ultimo_evento_em)
      VALUES (p_ambiente, v_user, p_subscription_id, p_checkout_id, v_plano, 'ativa', 'ativa', NULL, v_pago, v_quando);
    ELSE
      v_esperado := CASE v_row.plano WHEN 'basico' THEN 990 WHEN 'plus' THEN 2990 ELSE NULL END;
      IF v_centavos IS DISTINCT FROM v_esperado THEN
        UPDATE chat_private.assinaturas SET
          subscription_id = coalesce(subscription_id, p_subscription_id),
          checkout_id = coalesce(checkout_id, p_checkout_id),
          recorrencia = CASE WHEN recorrencia IN ('cancelamento_pendente', 'encerrada') THEN recorrencia ELSE 'ativa' END,
          bloqueio = 'divergente',
          reserva = 'aberta',
          resultado_incerto = false,
          ultimo_evento_em = v_quando,
          atualizado_em = now()
        WHERE id = v_row.id AND recorrencia <> 'encerrada'
          AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
      ELSE
        UPDATE chat_private.assinaturas SET
          subscription_id = coalesce(subscription_id, p_subscription_id),
          checkout_id = coalesce(checkout_id, p_checkout_id),
          recorrencia = CASE WHEN recorrencia = 'cancelamento_pendente' THEN recorrencia ELSE 'ativa' END,
          bloqueio = CASE WHEN recorrencia = 'cancelamento_pendente' THEN bloqueio ELSE NULL END,
          reserva = 'aberta',
          pago_ate = CASE
            WHEN pago_ate IS NULL THEN v_pago
            WHEN v_pago IS NULL THEN pago_ate
            ELSE GREATEST(pago_ate, v_pago)
          END,
          resultado_incerto = false,
          ultimo_evento_em = v_quando,
          atualizado_em = now()
        WHERE id = v_row.id AND recorrencia <> 'encerrada'
          AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
      END IF;
    END IF;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
  END IF;

  IF p_tipo IN ('PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED') THEN
    IF v_found THEN
      UPDATE chat_private.assinaturas SET
        subscription_id = coalesce(subscription_id, p_subscription_id),
        checkout_id = coalesce(checkout_id, p_checkout_id),
        bloqueio = CASE WHEN bloqueio IN ('suspensa', 'divergente') THEN bloqueio ELSE 'inadimplente' END,
        resultado_incerto = false,
        ultimo_evento_em = v_quando,
        atualizado_em = now()
      WHERE id = v_row.id
        AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
    END IF;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
  END IF;

  IF p_tipo IN ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') THEN
    IF v_found THEN
      UPDATE chat_private.assinaturas SET
        subscription_id = coalesce(subscription_id, p_subscription_id),
        checkout_id = coalesce(checkout_id, p_checkout_id),
        bloqueio = 'suspensa',
        resultado_incerto = false,
        ultimo_evento_em = v_quando,
        atualizado_em = now()
      WHERE id = v_row.id
        AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
    END IF;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
  END IF;

  IF p_tipo IN ('SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED') THEN
    IF v_found AND v_row.recorrencia = 'encerrada' THEN
      RETURN jsonb_build_object('aplicado', true, 'duplicado', false, 'terminal', true);
    END IF;
    IF v_found THEN
      UPDATE chat_private.assinaturas SET
        subscription_id = coalesce(subscription_id, p_subscription_id),
        checkout_id = coalesce(checkout_id, p_checkout_id),
        recorrencia = 'encerrada',
        resultado_incerto = false,
        ultimo_evento_em = v_quando,
        atualizado_em = now()
      WHERE id = v_row.id AND recorrencia <> 'encerrada'
        AND (ultimo_evento_em IS NULL OR ultimo_evento_em <= v_quando);
    END IF;
    RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
  END IF;

  RETURN jsonb_build_object('aplicado', true, 'duplicado', false);
END $$;

CREATE FUNCTION chat_private.asaas_status(p_ambiente text, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE
  v_row chat_private.assinaturas%ROWTYPE;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_acesso date;
BEGIN
  SELECT * INTO v_row FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user
  ORDER BY atualizado_em DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('plano', 'free', 'status', 'free', 'trial_ate', NULL, 'pago_ate', NULL, 'acesso_ate', NULL, 'pode_cancelar', false);
  END IF;
  v_acesso := coalesce(v_row.pago_ate, v_row.trial_ate);
  IF v_row.recorrencia = 'encerrada' AND v_row.bloqueio IS NULL AND (v_acesso IS NULL OR v_acesso < v_hoje) THEN
    RETURN jsonb_build_object('plano', 'free', 'status', 'free', 'trial_ate', NULL, 'pago_ate', NULL, 'acesso_ate', NULL, 'pode_cancelar', false);
  END IF;
  RETURN jsonb_build_object(
    'plano', CASE
      WHEN v_row.bloqueio IS NULL
        AND v_acesso IS NOT NULL AND v_acesso >= v_hoje
        AND v_row.recorrencia IN ('ativa', 'cancelamento_pendente', 'encerrada')
      THEN v_row.plano ELSE 'free' END,
    'status', v_row.status,
    'trial_ate', to_char(v_row.trial_ate, 'YYYY-MM-DD'),
    'pago_ate', to_char(v_row.pago_ate, 'YYYY-MM-DD'),
    'acesso_ate', to_char(v_acesso, 'YYYY-MM-DD'),
    'pode_cancelar', v_row.subscription_id IS NOT NULL AND v_row.recorrencia IN ('ativa', 'pendente')
  );
END $$;

CREATE FUNCTION chat_private.asaas_pedir_cancelamento(p_ambiente text, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE
  v_row chat_private.assinaturas%ROWTYPE;
  v_op chat_private.asaas_cancelamentos%ROWTYPE;
  v_tem boolean := false;
  v_status text;
BEGIN
  IF p_ambiente NOT IN ('sandbox', 'producao') OR p_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sem_assinatura');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('asaas-user:' || p_ambiente || ':' || p_user::text, 0));
  SELECT * INTO v_row FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user AND subscription_id IS NOT NULL AND recorrencia <> 'encerrada'
  ORDER BY atualizado_em DESC LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO v_op FROM chat_private.asaas_cancelamentos
    WHERE ambiente = p_ambiente AND assinatura_id = v_row.id
    FOR UPDATE;
    v_tem := FOUND;
    IF v_tem AND v_op.estado = 'concluido' THEN
      RETURN jsonb_build_object(
        'ok', true, 'ja', true, 'refazer', false, 'estado', 'concluido', 'status', v_row.status,
        'subscription_id', v_row.subscription_id,
        'acesso_ate', to_char(coalesce(v_row.pago_ate, v_row.trial_ate), 'YYYY-MM-DD')
      );
    END IF;
    IF v_tem AND v_op.estado = 'pendente' AND v_op.lease_ate IS NOT NULL AND v_op.lease_ate > now() THEN
      RETURN jsonb_build_object(
        'ok', true, 'ja', false, 'refazer', false, 'code', 'cancelamento_em_andamento', 'estado', 'pendente',
        'status', v_row.status, 'subscription_id', v_row.subscription_id,
        'acesso_ate', to_char(coalesce(v_row.pago_ate, v_row.trial_ate), 'YYYY-MM-DD')
      );
    END IF;
    IF NOT v_tem THEN
      UPDATE chat_private.assinaturas
      SET recorrencia = 'cancelamento_pendente', atualizado_em = now()
      WHERE id = v_row.id
      RETURNING status INTO v_status;
      INSERT INTO chat_private.asaas_cancelamentos (ambiente, assinatura_id, user_id, subscription_id, estado, tentativas, lease_ate)
      VALUES (p_ambiente, v_row.id, p_user, v_row.subscription_id, 'pendente', 1, now() + interval '90 seconds');
      RETURN jsonb_build_object(
        'ok', true, 'ja', false, 'refazer', false, 'estado', 'pendente',
        'status', v_status, 'status_anterior', v_row.status,
        'subscription_id', v_row.subscription_id,
        'acesso_ate', to_char(coalesce(v_row.pago_ate, v_row.trial_ate), 'YYYY-MM-DD')
      );
    END IF;
    UPDATE chat_private.asaas_cancelamentos
    SET estado = 'pendente', tentativas = tentativas + 1, lease_ate = now() + interval '90 seconds',
        subscription_id = v_row.subscription_id, atualizado_em = now()
    WHERE ambiente = p_ambiente AND assinatura_id = v_row.id;
    RETURN jsonb_build_object(
      'ok', true, 'ja', false, 'refazer', true, 'estado', 'pendente',
      'status', v_row.status, 'status_anterior', v_row.status,
      'subscription_id', v_row.subscription_id,
      'acesso_ate', to_char(coalesce(v_row.pago_ate, v_row.trial_ate), 'YYYY-MM-DD')
    );
  END IF;
  SELECT * INTO v_row FROM chat_private.assinaturas
  WHERE ambiente = p_ambiente AND user_id = p_user AND subscription_id IS NOT NULL AND recorrencia = 'encerrada'
  ORDER BY atualizado_em DESC LIMIT 1;
  IF FOUND THEN
    UPDATE chat_private.asaas_cancelamentos
    SET estado = 'concluido', lease_ate = NULL, atualizado_em = now()
    WHERE ambiente = p_ambiente AND assinatura_id = v_row.id AND estado <> 'concluido';
    RETURN jsonb_build_object(
      'ok', true, 'ja', true, 'refazer', false, 'estado', 'concluido', 'status', v_row.status,
      'subscription_id', v_row.subscription_id,
      'acesso_ate', to_char(coalesce(v_row.pago_ate, v_row.trial_ate), 'YYYY-MM-DD')
    );
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'sem_assinatura');
END $$;

CREATE FUNCTION chat_private.asaas_marcar_cancelamento(p_ambiente text, p_user uuid, p_subscription text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
BEGIN
  UPDATE chat_private.asaas_cancelamentos
  SET estado = 'concluido', lease_ate = NULL, atualizado_em = now()
  WHERE ambiente = p_ambiente AND user_id = p_user AND subscription_id = p_subscription AND estado <> 'concluido';
  UPDATE chat_private.assinaturas
  SET recorrencia = 'cancelamento_pendente', atualizado_em = now()
  WHERE ambiente = p_ambiente AND user_id = p_user AND subscription_id = p_subscription AND recorrencia <> 'encerrada';
END $$;

CREATE FUNCTION chat_private.asaas_falhar_cancelamento(p_ambiente text, p_user uuid, p_subscription text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
  UPDATE chat_private.asaas_cancelamentos
  SET estado = 'falhou', lease_ate = NULL, atualizado_em = now()
  WHERE ambiente = p_ambiente AND user_id = p_user AND subscription_id = p_subscription AND estado = 'pendente';
$$;

-- Só produção libera plano. Sandbox não concede.
-- Inadimplente não tem carência. Suspensa, divergente e data vencida caem em free.
-- Encerrar não concede acesso: sem bloqueio e com data futura, o plano que já existia continua.
CREATE FUNCTION chat_private.plano_atual(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, chat_private
AS $$
DECLARE
  v_row chat_private.assinaturas%ROWTYPE;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_basico integer := 20;
  v_avancado integer := 0;
  v_inicio date;
  v_fim date;
  v_plano text := 'free';
BEGIN
  SELECT * INTO v_row FROM chat_private.assinaturas
  WHERE user_id = p_user AND ambiente = 'producao'
    AND bloqueio IS NULL
    AND recorrencia IN ('ativa', 'cancelamento_pendente', 'encerrada')
    AND coalesce(pago_ate, trial_ate) IS NOT NULL
    AND coalesce(pago_ate, trial_ate) >= v_hoje
  ORDER BY atualizado_em DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'plano', 'free', 'status', 'free',
      'basico_dia', 20, 'avancado_ciclo', 0,
      'ciclo_inicio', NULL, 'ciclo_fim', NULL
    );
  END IF;
  v_plano := v_row.plano;
  IF v_plano = 'basico' THEN
    v_basico := 150; v_avancado := 20;
  ELSIF v_plano = 'plus' THEN
    v_basico := 150; v_avancado := 100;
  ELSE
    v_plano := 'free'; v_basico := 20; v_avancado := 0;
  END IF;
  IF v_row.pago_ate IS NOT NULL AND v_row.recorrencia IN ('ativa', 'cancelamento_pendente', 'encerrada') THEN
    v_fim := v_row.pago_ate;
    v_inicio := (v_row.pago_ate - interval '1 month')::date;
  ELSE
    v_fim := v_row.trial_ate;
    v_inicio := CASE WHEN v_row.trial_ate IS NULL THEN NULL ELSE (v_row.trial_ate - 7) END;
  END IF;
  RETURN jsonb_build_object(
    'plano', v_plano,
    'status', v_row.status,
    'basico_dia', v_basico,
    'avancado_ciclo', v_avancado,
    'ciclo_inicio', to_char(v_inicio, 'YYYY-MM-DD'),
    'ciclo_fim', to_char(v_fim, 'YYYY-MM-DD')
  );
END $$;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'chat_private' AND p.proname IN (
      'asaas_obter_cliente', 'asaas_gravar_cliente', 'asaas_preparar_checkout', 'asaas_liberar_checkout',
      'asaas_vincular_checkout', 'asaas_vincular_assinatura_remota', 'asaas_descartar_checkout',
      'asaas_marcar_checkout_incerto', 'asaas_aplicar_evento', 'asaas_status', 'asaas_pedir_cancelamento',
      'asaas_marcar_cancelamento', 'asaas_falhar_cancelamento', 'asaas_derivar_status', 'plano_atual'
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, chat_writer', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO chat_fn', f);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('014', 'Assinaturas Asaas sandbox e plano_atual sem conceder sandbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
