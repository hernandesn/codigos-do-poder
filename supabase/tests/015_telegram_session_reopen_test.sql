-- Reabertura do mesmo init_hash. Roda depois da 015, no harness local.
DO $$
DECLARE u uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        other uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        issued bigint := extract(epoch FROM now())::bigint;
        live text; proof text;
BEGIN
  INSERT INTO auth.users VALUES (u),(other) ON CONFLICT DO NOTHING;
  IF chat_private.telegram_begin_session(repeat('7',64),401,repeat('8',64),extract(epoch FROM now())::bigint - 5) THEN
    RAISE EXCEPTION 'expires no passado';
  END IF;
  IF chat_private.telegram_begin_session(repeat('7',64),401,repeat('8',64),extract(epoch FROM now())::bigint + 61*60 + 90) THEN
    RAISE EXCEPTION 'expires além de 61 minutos';
  END IF;
  IF EXISTS (SELECT 1 FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64)) THEN
    RAISE EXCEPTION 'expires inválido gravou';
  END IF;

  INSERT INTO chat_private.telegram_links(telegram_id,user_id) VALUES (401,u);

  IF NOT chat_private.telegram_begin_session(repeat('7',64),401,repeat('8',64),extract(epoch FROM now())::bigint + 600) THEN
    RAISE EXCEPTION 'primeira sessão';
  END IF;
  IF NOT chat_private.telegram_begin_session(repeat('7',64),401,repeat('9',64),extract(epoch FROM now())::bigint + 600) THEN
    RAISE EXCEPTION 'reabrir mesmo telegram';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,repeat('8',64))->>'ok')::boolean THEN
    RAISE EXCEPTION 'prova antiga ainda vale';
  END IF;
  IF NOT (chat_private.telegram_session_user(repeat('7',64),401,repeat('9',64))->>'ok')::boolean
     OR (chat_private.telegram_session_user(repeat('7',64),401,repeat('9',64))->>'user_id')::uuid IS DISTINCT FROM u THEN
    RAISE EXCEPTION 'prova nova não resolve o vínculo';
  END IF;

  SELECT session_hash INTO live FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64);
  IF chat_private.telegram_begin_session(repeat('7',64),402,repeat('a',64),extract(epoch FROM now())::bigint + 600) THEN
    RAISE EXCEPTION 'outro telegram_id foi aceito';
  END IF;
  IF (SELECT session_hash FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64)) IS DISTINCT FROM live
     OR (SELECT telegram_id FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64))<>401 THEN
    RAISE EXCEPTION 'recusa trocou a linha';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),402,repeat('a',64))->>'ok')::boolean THEN
    RAISE EXCEPTION 'outro telegram autenticou';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,repeat('9',64))->>'user_id')::uuid IS DISTINCT FROM u THEN
    RAISE EXCEPTION 'recusa derrubou a prova vigente';
  END IF;

  -- Expires inválido não apaga a linha viva.
  IF chat_private.telegram_begin_session(repeat('7',64),401,repeat('b',64),extract(epoch FROM now())::bigint - 1) THEN
    RAISE EXCEPTION 'reabrir vencida';
  END IF;
  IF (SELECT session_hash FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64)) IS DISTINCT FROM repeat('9',64) THEN
    RAISE EXCEPTION 'expires inválido rotacionou';
  END IF;

  UPDATE chat_private.telegram_initdata_replay SET expires_at=now()-interval '1 second' WHERE init_hash=repeat('7',64);
  IF NOT chat_private.telegram_begin_session(repeat('7',64),401,repeat('c',64),extract(epoch FROM now())::bigint + 600) THEN
    RAISE EXCEPTION 'hash expirado não pôde ser regravado';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,repeat('9',64))->>'ok')::boolean THEN
    RAISE EXCEPTION 'prova da linha expirada voltou';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,repeat('c',64))->>'user_id')::uuid IS DISTINCT FROM u THEN
    RAISE EXCEPTION 'regravação após expirar';
  END IF;

  -- Rebind troca o binding_id e zera a prova. A reabertura não herda o dono antigo.
  SELECT session_hash INTO proof FROM chat_private.telegram_initdata_replay WHERE init_hash=repeat('7',64);
  UPDATE chat_private.telegram_link_codes SET created_at=now()-interval '1 minute' WHERE user_id=other;
  IF NOT chat_private.telegram_issue_code(other,repeat('d',64),issued) THEN RAISE EXCEPTION 'emissão do rebind'; END IF;
  IF NOT chat_private.telegram_consume_code(401,repeat('d',64)) THEN RAISE EXCEPTION 'rebind'; END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,proof)->>'ok')::boolean THEN
    RAISE EXCEPTION 'rebind não invalidou a prova';
  END IF;
  IF NOT chat_private.telegram_begin_session(repeat('7',64),401,repeat('e',64),extract(epoch FROM now())::bigint + 600) THEN
    RAISE EXCEPTION 'reabrir depois do rebind';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,proof)->>'ok')::boolean THEN
    RAISE EXCEPTION 'prova anterior ao rebind voltou';
  END IF;
  IF (chat_private.telegram_session_user(repeat('7',64),401,repeat('e',64))->>'user_id')::uuid IS DISTINCT FROM other THEN
    RAISE EXCEPTION 'prova nova não segue o binding atual';
  END IF;

  PERFORM chat_private.telegram_unlink(401);
  DELETE FROM chat_private.telegram_links WHERE telegram_id IN (401,402);
END $$;
