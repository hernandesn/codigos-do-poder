-- 013: transporte Telegram isolado. Não cria contas nem altera a chat.
-- Produção já tem a 012. Esta migração é só aditiva (tabelas telegram_* em chat_private).
-- Rollback futuro, não executado aqui:
-- BEGIN;
-- DROP FUNCTION IF EXISTS chat_private.telegram_revoke_codes(uuid);
-- DROP FUNCTION IF EXISTS chat_private.telegram_issue_code(uuid, text, bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_issue_code(uuid, text);
-- DROP FUNCTION IF EXISTS chat_private.telegram_consume_code(bigint, text);
-- DROP FUNCTION IF EXISTS chat_private.telegram_unlink(bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_linked_user(bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_claim_update(bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_rate_touch(bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_begin_session(text, bigint, text, bigint);
-- DROP FUNCTION IF EXISTS chat_private.telegram_session_user(text, bigint, text);
-- DROP TABLE IF EXISTS chat_private.telegram_initdata_replay;
-- DROP TABLE IF EXISTS chat_private.telegram_rate;
-- DROP TABLE IF EXISTS chat_private.telegram_updates;
-- DROP TABLE IF EXISTS chat_private.telegram_link_revocations;
-- DROP TABLE IF EXISTS chat_private.telegram_link_codes;
-- DROP TABLE IF EXISTS chat_private.telegram_links;
-- COMMIT;
BEGIN;
CREATE TABLE chat_private.telegram_links (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL DEFAULT gen_random_uuid(),
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_private.telegram_link_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at timestamptz
);
-- Marco do logout. Emissão com JWT anterior a revoked_at não pode gravar depois.
CREATE TABLE chat_private.telegram_link_revocations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revoked_at timestamptz NOT NULL
);
CREATE TABLE chat_private.telegram_updates (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_private.telegram_rate (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  minute_events timestamptz[] NOT NULL,
  day date NOT NULL,
  day_count integer NOT NULL CHECK (day_count >= 0)
);
CREATE TABLE chat_private.telegram_initdata_replay (
  init_hash text PRIMARY KEY CHECK (init_hash ~ '^[0-9a-f]{64}$'),
  telegram_id bigint NOT NULL CHECK (telegram_id > 0),
  session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  binding_id uuid,
  expires_at timestamptz NOT NULL
);

-- O dono das funções é o papel da migração; clientes não recebem acesso direto.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegram_links','telegram_link_codes','telegram_link_revocations','telegram_updates','telegram_rate','telegram_initdata_replay'] LOOP
    EXECUTE format('ALTER TABLE chat_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE chat_private.%I FROM PUBLIC, anon, authenticated, chat_fn, chat_writer', t);
  END LOOP;
END $$;

-- p_iat é o iat do JWT já autenticado na função. Não é relógio nem campo do corpo.
CREATE FUNCTION chat_private.telegram_issue_code(p_user uuid, p_hash text, p_iat bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(110011::bigint);
  IF p_iat IS NULL OR p_iat <= 0 THEN
    RETURN false;
  END IF;
  -- Só grava se o JWT desta emissão for posterior ao marco do logout.
  IF EXISTS (
    SELECT 1 FROM chat_private.telegram_link_revocations
    WHERE user_id=p_user AND revoked_at >= to_timestamp(p_iat::double precision)
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=p_user AND created_at > now()-interval '30 seconds') THEN
    RETURN false;
  END IF;
  DELETE FROM chat_private.telegram_link_codes WHERE user_id=p_user;
  INSERT INTO chat_private.telegram_link_codes(code_hash,user_id) VALUES(p_hash,p_user);
  RETURN true;
END $$;


CREATE FUNCTION chat_private.telegram_revoke_codes(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(110011::bigint);
  INSERT INTO chat_private.telegram_link_revocations(user_id, revoked_at)
    VALUES (p_user, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at;
  DELETE FROM chat_private.telegram_link_codes WHERE user_id=p_user AND used_at IS NULL;
END $$;

CREATE FUNCTION chat_private.telegram_consume_code(p_telegram bigint, p_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
DECLARE u uuid; old_telegram bigint;
BEGIN
  IF p_telegram IS NULL OR p_telegram <= 0 THEN RETURN false; END IF;
  -- Serializa também emissão e desvínculo; evita ciclos de locks no rebind cruzado.
  PERFORM pg_advisory_xact_lock(110011::bigint);
  SELECT user_id INTO u FROM chat_private.telegram_link_codes
    WHERE code_hash=p_hash AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF u IS NULL THEN RETURN false; END IF;
  UPDATE chat_private.telegram_link_codes SET used_at=now() WHERE code_hash=p_hash;
  SELECT telegram_id INTO old_telegram FROM chat_private.telegram_links WHERE user_id=u;
  DELETE FROM chat_private.telegram_links WHERE telegram_id=p_telegram OR user_id=u;
  INSERT INTO chat_private.telegram_links(telegram_id,user_id) VALUES(p_telegram,u);
  -- Invalida sessões antigas dos dois lados do vínculo.
  UPDATE chat_private.telegram_initdata_replay SET session_hash=repeat('0',64)
    WHERE telegram_id=p_telegram OR telegram_id=old_telegram;
  RETURN true;
END $$;

CREATE FUNCTION chat_private.telegram_unlink(p_telegram bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(110011::bigint);
  DELETE FROM chat_private.telegram_links WHERE telegram_id=p_telegram;
  -- Mantém o hash reclamado até expirar, mas inutiliza a prova de sessão.
  UPDATE chat_private.telegram_initdata_replay SET session_hash=repeat('0',64) WHERE telegram_id=p_telegram;
END $$;

CREATE FUNCTION chat_private.telegram_linked_user(p_telegram bigint)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
  SELECT user_id FROM chat_private.telegram_links WHERE telegram_id=p_telegram;
$$;

CREATE FUNCTION chat_private.telegram_claim_update(p_update bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
DECLARE n integer;
BEGIN
  INSERT INTO chat_private.telegram_updates(update_id) VALUES(p_update) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

CREATE FUNCTION chat_private.telegram_rate_touch(p_telegram bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
DECLARE events timestamptz[]; d date := (now() AT TIME ZONE 'America/Cuiaba')::date; cnt integer;
BEGIN
  IF p_telegram IS NULL OR p_telegram<=0 THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('telegram:'||p_telegram::text,0));
  SELECT ARRAY(SELECT e FROM unnest(r.minute_events) e WHERE e > now()-interval '1 minute'),
    CASE WHEN r.day=d THEN r.day_count ELSE 0 END INTO events,cnt
    FROM chat_private.telegram_rate r WHERE telegram_id=p_telegram;
  events := coalesce(events,ARRAY[]::timestamptz[]); cnt := coalesce(cnt,0);
  IF cardinality(events)>=8 OR cnt>=100 THEN RETURN false; END IF;
  INSERT INTO chat_private.telegram_rate AS r(telegram_id,minute_events,day,day_count)
    VALUES(p_telegram,array_append(events,now()),d,cnt+1)
    ON CONFLICT(telegram_id) DO UPDATE SET minute_events=EXCLUDED.minute_events,day=EXCLUDED.day,day_count=EXCLUDED.day_count;
  RETURN true;
END $$;

CREATE FUNCTION chat_private.telegram_begin_session(p_hash text,p_telegram bigint,p_session text,p_expires bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
DECLARE n integer; v_binding uuid;
BEGIN
  IF to_timestamp(p_expires)<=now() OR to_timestamp(p_expires)>now()+interval '61 minutes' THEN RETURN false; END IF;
  -- A versão lida e o INSERT não podem atravessar a invalidação de um rebind.
  PERFORM pg_advisory_xact_lock(110011::bigint);
  SELECT binding_id INTO v_binding FROM chat_private.telegram_links WHERE telegram_id=p_telegram;
  DELETE FROM chat_private.telegram_initdata_replay WHERE expires_at<=now();
  INSERT INTO chat_private.telegram_initdata_replay(init_hash,telegram_id,session_hash,binding_id,expires_at)
    VALUES(p_hash,p_telegram,p_session,v_binding,to_timestamp(p_expires)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

CREATE FUNCTION chat_private.telegram_session_user(p_hash text,p_telegram bigint,p_session text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
  -- Prova e identidade são resolvidas no MESMO snapshot. Nunca consultar o
  -- vínculo em outra RPC depois de autenticar uma prova de sessão antiga.
  SELECT coalesce((SELECT jsonb_build_object('ok',true,'user_id',l.user_id)
    FROM chat_private.telegram_initdata_replay s
    LEFT JOIN chat_private.telegram_links l ON l.telegram_id=s.telegram_id AND l.binding_id=s.binding_id
    WHERE s.init_hash=p_hash AND s.telegram_id=p_telegram AND s.session_hash=p_session AND s.expires_at>now()
      AND (l.user_id IS NOT NULL OR (s.binding_id IS NULL AND NOT EXISTS
        (SELECT 1 FROM chat_private.telegram_links current_link WHERE current_link.telegram_id=p_telegram))))
    ,jsonb_build_object('ok',false,'user_id',NULL));
$$;

-- Nenhum EXECUTE implícito para PUBLIC; somente a conexão privada chat_fn.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='chat_private' AND p.proname IN ('telegram_issue_code','telegram_revoke_codes','telegram_consume_code','telegram_unlink','telegram_linked_user','telegram_claim_update','telegram_rate_touch','telegram_begin_session','telegram_session_user')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, chat_writer',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO chat_fn',f);
  END LOOP;
END $$;
COMMIT;
