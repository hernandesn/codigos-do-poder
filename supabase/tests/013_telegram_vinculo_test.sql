-- Executado somente pelo harness local descartável.
DO $$
DECLARE a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; i integer; old_events timestamptz[]; issued bigint := extract(epoch FROM now())::bigint;
BEGIN
  INSERT INTO auth.users VALUES(a),(b);
  IF NOT chat_private.telegram_issue_code(a,repeat('a',64),issued) THEN RAISE EXCEPTION 'emissão'; END IF;
  IF chat_private.telegram_issue_code(a,repeat('b',64),issued) THEN RAISE EXCEPTION 'rate emissão'; END IF;
  IF NOT chat_private.telegram_consume_code(101,repeat('a',64)) THEN RAISE EXCEPTION 'vínculo'; END IF;
  IF chat_private.telegram_consume_code(102,repeat('a',64)) THEN RAISE EXCEPTION 'reuso'; END IF;
  IF chat_private.telegram_linked_user(101) IS DISTINCT FROM a THEN RAISE EXCEPTION 'dono'; END IF;
  IF NOT chat_private.telegram_issue_code(b,repeat('b',64),issued) THEN RAISE EXCEPTION 'emissão b'; END IF;
  UPDATE chat_private.telegram_link_codes SET expires_at=now()-interval '1 second' WHERE user_id=b;
  IF chat_private.telegram_consume_code(102,repeat('b',64)) THEN RAISE EXCEPTION 'expirado'; END IF;
  UPDATE chat_private.telegram_link_codes SET expires_at=now()+interval '1 minute' WHERE user_id=b;
  IF NOT chat_private.telegram_consume_code(102,repeat('b',64)) THEN RAISE EXCEPTION 'vínculo b'; END IF;

  IF NOT chat_private.telegram_begin_session(repeat('c',64),101,repeat('d',64),extract(epoch FROM now())::bigint+600) THEN RAISE EXCEPTION 'sessão'; END IF;
  IF chat_private.telegram_begin_session(repeat('c',64),101,repeat('e',64),extract(epoch FROM now())::bigint+600) THEN RAISE EXCEPTION 'replay'; END IF;
  IF NOT (chat_private.telegram_session_user(repeat('c',64),101,repeat('d',64))->>'ok')::boolean THEN RAISE EXCEPTION 'prova'; END IF;
  IF (chat_private.telegram_session_user(repeat('c',64),101,repeat('d',64))->>'user_id')::uuid IS DISTINCT FROM a THEN RAISE EXCEPTION 'identidade atômica'; END IF;
  IF (chat_private.telegram_session_user(repeat('c',64),101,repeat('e',64))->>'ok')::boolean THEN RAISE EXCEPTION 'prova adulterada'; END IF;
  -- Mesmo sem a invalidação explícita, uma versão nova nunca aceita prova velha.
  UPDATE chat_private.telegram_links SET binding_id=gen_random_uuid() WHERE telegram_id=101;
  IF (chat_private.telegram_session_user(repeat('c',64),101,repeat('d',64))->>'ok')::boolean THEN RAISE EXCEPTION 'versão antiga'; END IF;
  IF chat_private.telegram_begin_session(repeat('f',64),101,repeat('e',64),extract(epoch FROM now())::bigint-1) THEN RAISE EXCEPTION 'sessão expirada'; END IF;
  UPDATE chat_private.telegram_link_codes SET created_at=now()-interval '1 minute' WHERE user_id=a;
  IF NOT chat_private.telegram_issue_code(a,repeat('e',64),issued) THEN RAISE EXCEPTION 'novo código'; END IF;
  IF NOT chat_private.telegram_consume_code(102,repeat('e',64)) THEN RAISE EXCEPTION 'rebind'; END IF;
  IF chat_private.telegram_linked_user(102) IS DISTINCT FROM a OR chat_private.telegram_linked_user(101) IS NOT NULL THEN RAISE EXCEPTION 'transferência'; END IF;
  IF EXISTS(SELECT FROM chat_private.telegram_links WHERE user_id=b) THEN RAISE EXCEPTION 'liberar dono anterior'; END IF;
  IF (chat_private.telegram_session_user(repeat('c',64),101,repeat('d',64))->>'ok')::boolean THEN RAISE EXCEPTION 'invalidar sessão antiga'; END IF;
  IF chat_private.telegram_begin_session(repeat('c',64),101,repeat('d',64),extract(epoch FROM now())::bigint+600) THEN RAISE EXCEPTION 'rebind não libera replay'; END IF;
  PERFORM chat_private.telegram_unlink(102);
  IF chat_private.telegram_linked_user(102) IS NOT NULL THEN RAISE EXCEPTION 'desvínculo'; END IF;

  IF NOT chat_private.telegram_claim_update(42) OR chat_private.telegram_claim_update(42) THEN RAISE EXCEPTION 'idempotência'; END IF;
  FOR i IN 1..8 LOOP
    IF NOT chat_private.telegram_rate_touch(201) THEN RAISE EXCEPTION 'rate permitido'; END IF;
  END LOOP;
  SELECT minute_events INTO old_events FROM chat_private.telegram_rate WHERE telegram_id=201;
  FOR i IN 1..25 LOOP
    IF chat_private.telegram_rate_touch(201) THEN RAISE EXCEPTION 'rate minuto'; END IF;
  END LOOP;
  IF (SELECT minute_events FROM chat_private.telegram_rate WHERE telegram_id=201) IS DISTINCT FROM old_events
    OR (SELECT day_count FROM chat_private.telegram_rate WHERE telegram_id=201)<>8 THEN RAISE EXCEPTION 'overflow gravado'; END IF;
  INSERT INTO chat_private.telegram_rate VALUES(202,ARRAY[]::timestamptz[],(now() AT TIME ZONE 'America/Cuiaba')::date,100);
  IF chat_private.telegram_rate_touch(202) THEN RAISE EXCEPTION 'rate dia'; END IF;
  IF (SELECT day_count FROM chat_private.telegram_rate WHERE telegram_id=202)<>100 THEN RAISE EXCEPTION 'overflow dia'; END IF;
  UPDATE chat_private.telegram_rate SET day=day-1 WHERE telegram_id=202;
  IF NOT chat_private.telegram_rate_touch(202) THEN RAISE EXCEPTION 'virada dia touch'; END IF;
  IF (SELECT day_count FROM chat_private.telegram_rate WHERE telegram_id=202)<>1 THEN RAISE EXCEPTION 'virada dia count'; END IF;
  BEGIN
    INSERT INTO chat_private.telegram_links(telegram_id,user_id) VALUES(301,a),(302,a);
    RAISE EXCEPTION 'unicidade ausente';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  UPDATE chat_private.telegram_link_codes SET created_at=now()-interval '1 minute' WHERE user_id=b;
  IF NOT chat_private.telegram_issue_code(b,repeat('8',64),issued) THEN RAISE EXCEPTION 'emissão vínculo b'; END IF;
  IF NOT chat_private.telegram_consume_code(303,repeat('8',64)) THEN RAISE EXCEPTION 'vínculo para revogar'; END IF;
  UPDATE chat_private.telegram_link_codes SET created_at=now()-interval '1 minute' WHERE user_id=b;
  IF NOT chat_private.telegram_issue_code(b,repeat('9',64),issued) THEN RAISE EXCEPTION 'emissão para revogar'; END IF;
  PERFORM chat_private.telegram_revoke_codes(b);
  IF EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=b AND used_at IS NULL) THEN RAISE EXCEPTION 'revogação incompleta'; END IF;
  IF chat_private.telegram_linked_user(303) IS DISTINCT FROM b THEN RAISE EXCEPTION 'revogar não desfaz vínculo'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=a AND used_at IS NOT NULL) THEN RAISE EXCEPTION 'usados de a permanecem'; END IF;

  -- Marco por usuário: iat anterior ou igual não grava; iat posterior grava.
  UPDATE chat_private.telegram_link_codes SET created_at=now()-interval '1 minute' WHERE user_id=a;
  PERFORM chat_private.telegram_revoke_codes(a);
  UPDATE chat_private.telegram_link_revocations SET revoked_at=to_timestamp(1700000000::double precision) WHERE user_id=a;
  IF NOT EXISTS (SELECT 1 FROM chat_private.telegram_link_revocations WHERE user_id=a AND revoked_at=to_timestamp(1700000000::double precision)) THEN RAISE EXCEPTION 'marco ausente'; END IF;
  IF EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=a AND used_at IS NULL) THEN RAISE EXCEPTION 'revogação de a deixou pendente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=a AND used_at IS NOT NULL) THEN RAISE EXCEPTION 'revogar a apagou usados'; END IF;
  IF chat_private.telegram_issue_code(a,repeat('1',64),1699999999) THEN RAISE EXCEPTION 'iat anterior gravou'; END IF;
  IF chat_private.telegram_issue_code(a,repeat('3',64),1700000000) THEN RAISE EXCEPTION 'iat igual ao marco gravou'; END IF;
  IF chat_private.telegram_issue_code(a,repeat('5',64),NULL::bigint) OR chat_private.telegram_issue_code(a,repeat('6',64),0) THEN RAISE EXCEPTION 'iat inválido gravou'; END IF;
  IF EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE code_hash IN (repeat('1',64),repeat('3',64),repeat('5',64),repeat('6',64))) THEN RAISE EXCEPTION 'código de iat antigo'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE user_id=a AND used_at IS NOT NULL) THEN RAISE EXCEPTION 'iat antigo apagou usados'; END IF;
  IF chat_private.telegram_issue_code(b,repeat('4',64),1700000001) THEN RAISE EXCEPTION 'marco de b ignorado'; END IF;
  IF EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE code_hash=repeat('4',64)) THEN RAISE EXCEPTION 'código de b com iat antigo'; END IF;
  IF NOT chat_private.telegram_issue_code(a,repeat('2',64),1700000001) THEN RAISE EXCEPTION 'iat posterior recusado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_private.telegram_link_codes WHERE code_hash=repeat('2',64) AND user_id=a AND used_at IS NULL) THEN RAISE EXCEPTION 'código de iat posterior ausente'; END IF;
END $$;
