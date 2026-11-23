-- 015: reabre a sessão do mini app quando o mesmo initData válido volta.
-- Não cria tabela nem muda a assinatura. Só substitui telegram_begin_session.
-- A 014 fica de fora: está reservada ao rascunho do Asaas.
--
-- Compatível com a função telegram v4: a v4 trata false como replay e true como
-- sessão nova. Com esta função, a segunda abertura válida devolve true, a v4
-- segue e emite outra prova. O corpo antigo (INSERT … ON CONFLICT DO NOTHING)
-- também continua chamável pela função nova: a segunda abertura volta a dar
-- false e o handler responde 401, sem quebrar a assinatura.
--
-- Rollback desta função, não executado aqui:
-- BEGIN;
-- CREATE OR REPLACE FUNCTION chat_private.telegram_begin_session(p_hash text,p_telegram bigint,p_session text,p_expires bigint)
-- RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
-- DECLARE n integer; v_binding uuid;
-- BEGIN
--   IF to_timestamp(p_expires)<=now() OR to_timestamp(p_expires)>now()+interval '61 minutes' THEN RETURN false; END IF;
--   PERFORM pg_advisory_xact_lock(110011::bigint);
--   SELECT binding_id INTO v_binding FROM chat_private.telegram_links WHERE telegram_id=p_telegram;
--   DELETE FROM chat_private.telegram_initdata_replay WHERE expires_at<=now();
--   INSERT INTO chat_private.telegram_initdata_replay(init_hash,telegram_id,session_hash,binding_id,expires_at)
--     VALUES(p_hash,p_telegram,p_session,v_binding,to_timestamp(p_expires)) ON CONFLICT DO NOTHING;
--   GET DIAGNOSTICS n=ROW_COUNT;
--   RETURN n=1;
-- END $$;
-- COMMIT;
BEGIN;

CREATE OR REPLACE FUNCTION chat_private.telegram_begin_session(p_hash text,p_telegram bigint,p_session text,p_expires bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chat_private AS $$
DECLARE n integer; v_binding uuid; v_owner bigint;
BEGIN
  -- Mesmo piso da 013: não no passado e não além de 61 minutos.
  IF to_timestamp(p_expires)<=now() OR to_timestamp(p_expires)>now()+interval '61 minutes' THEN RETURN false; END IF;
  -- A versão lida e a gravação não podem atravessar a invalidação de um rebind.
  PERFORM pg_advisory_xact_lock(110011::bigint);
  SELECT binding_id INTO v_binding FROM chat_private.telegram_links WHERE telegram_id=p_telegram;
  DELETE FROM chat_private.telegram_initdata_replay WHERE expires_at<=now();
  INSERT INTO chat_private.telegram_initdata_replay(init_hash,telegram_id,session_hash,binding_id,expires_at)
    VALUES(p_hash,p_telegram,p_session,v_binding,to_timestamp(p_expires))
    ON CONFLICT (init_hash) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n=1 THEN RETURN true; END IF;
  -- Conflito: só rotaciona se a linha viva for do mesmo telegram_id.
  SELECT telegram_id INTO v_owner FROM chat_private.telegram_initdata_replay WHERE init_hash=p_hash;
  IF v_owner IS DISTINCT FROM p_telegram THEN RETURN false; END IF;
  UPDATE chat_private.telegram_initdata_replay
    SET session_hash=p_session, binding_id=v_binding, expires_at=to_timestamp(p_expires)
    WHERE init_hash=p_hash AND telegram_id=p_telegram AND expires_at>now();
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

-- CREATE OR REPLACE preserva o GRANT da 013. Reaplica para o papel não ficar implícito.
REVOKE ALL ON FUNCTION chat_private.telegram_begin_session(text, bigint, text, bigint) FROM PUBLIC, anon, authenticated, chat_writer;
GRANT EXECUTE ON FUNCTION chat_private.telegram_begin_session(text, bigint, text, bigint) TO chat_fn;

COMMIT;
