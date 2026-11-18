-- SEC-02: substitui a função da 007 sem alterar a migração aplicada.
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
  -- Contagens anteriores ao pedido: bloqueios não geram novas linhas.
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
