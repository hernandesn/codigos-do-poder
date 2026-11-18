/* Reutiliza o cliente de autenticação existente do site, sem mudar seu bundle. */
(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const status = (message, warning = false) => { $('status').textContent = message; $('status').classList.toggle('warning', warning); };
  const config = window.ATLAS_PUBLIC_CONFIG;
  if (!config || config.supabaseUrl !== '__SUPABASE_ORIGIN__') { status('A configuração do serviço está indisponível.', true); $('login').disabled = true; return; }
  const authApi = window.atlasAuthChat;
  const client = authApi.createClient({ config });
  const parsed = typeof authApi.parsePublicConfig === 'function' ? authApi.parsePublicConfig(config) : null;
  const siteKey = parsed && parsed.ok && parsed.turnstileSiteKey ? parsed.turnstileSiteKey : '';
  let captchaToken = '';
  let expiryTimer;
  let generationEpoch = 0;
  let loggingOut = false;
  let issuance = null;
  const clearCode = () => { clearTimeout(expiryTimer); $('code-panel').hidden = true; $('code').textContent = ''; $('command').textContent = ''; };
  const invalidateGeneration = () => { generationEpoch++; clearCode(); if (!loggingOut) $('generate').disabled = false; };
  function mountTurnstile() {
    if (!siteKey || !$('auth-turnstile') || typeof document.createElement !== 'function') return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      const api = window.turnstile;
      const target = $('auth-turnstile');
      if (!api || typeof api.render !== 'function' || !target) return;
      try {
        api.render(target, {
          sitekey: siteKey,
          callback(token) { captchaToken = typeof token === 'string' ? token : ''; },
          'expired-callback'() { captchaToken = ''; },
          'error-callback'() { captchaToken = ''; },
        });
      } catch { /* desafio indisponível: o login segue recusado enquanto não houver token */ }
    };
    (document.head || document.body).appendChild(script);
  }
  function showSession() {
    const active = !!client.readSession();
    $('login-form').hidden = active; $('link-section').hidden = !active;
    status(active ? 'Conta conectada. Gere seu código temporário.' : 'Entre na sua conta para gerar o código.');
  }
  if (siteKey) mountTurnstile();
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); invalidateGeneration(); const epoch = generationEpoch; $('login').disabled = true; status('Entrando…');
    try {
      if (siteKey && !captchaToken) { status('Confirme a verificação antes de entrar.', true); return; }
      const result = await client.login($('email').value.trim(), $('password').value, siteKey ? captchaToken : undefined);
      if (epoch !== generationEpoch) return;
      if (!result.ok) { status(result.message, true); return; }
      showSession();
    } catch { status('Não foi possível entrar. Tente novamente.', true); }
    finally { $('password').value = ''; $('login').disabled = false; }
  });
  $('generate').addEventListener('click', async () => {
    if (loggingOut) return;
    const epoch = ++generationEpoch;
    $('generate').disabled = true; clearCode(); status('Gerando código…');
    // O botão fica desabilitado enquanto a emissão corre. Se ela não terminar
    // de forma conclusiva, o logout não se confirma: o marco no servidor barra o atraso.
    $('logout').disabled = true;
    const run = (async () => {
      let sent = false;
      try {
        const refreshed = await client.refresh();
        if (epoch !== generationEpoch) return 'nao_enviada';
        if (!refreshed.ok) { showSession(); status(refreshed.message, true); return 'recusada'; }
        sent = true;
        const response = await fetch(config.supabaseUrl + '/functions/v1/telegram-link', { method: 'POST', headers: { authorization: 'Bearer ' + refreshed.session.accessToken, apikey: config.supabaseAnonKey, 'content-type': 'application/json' }, body: '{}', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
        let result = null;
        try { result = await response.json(); } catch { result = null; }
        const stale = epoch !== generationEpoch || client.readSession()?.accessToken !== refreshed.session.accessToken;
        if (response.status >= 500) {
          if (!stale) status('Não foi possível gerar o código. Tente novamente.', true);
          return 'inconclusiva';
        }
        if (!response.ok) {
          if (!stale) status((result && result.message) || 'Não foi possível gerar o código.', true);
          return 'recusada';
        }
        if (!result || !/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/.test(result.code)) {
          if (!stale) status('Não foi possível gerar o código. Tente novamente.', true);
          return 'pronta';
        }
        if (stale) return 'pronta';
        $('code').textContent = result.code; $('command').textContent = '/start ' + result.code;
        const expiry = new Date(Date.now() + 600000);
        $('expires').textContent = 'Válido até ' + expiry.toLocaleTimeString('pt-BR', { timeZone: 'America/Cuiaba', hour: '2-digit', minute: '2-digit' }) + ' (Cuiabá). Uso único.';
        $('code-panel').hidden = false; status('Código pronto. Envie o comando ao bot.');
        expiryTimer = setTimeout(() => { clearCode(); status('O código expirou. Gere outro para vincular.', true); }, 600000);
        return 'pronta';
      } catch {
        if (epoch === generationEpoch) status('Não foi possível gerar o código. Tente novamente.', true);
        return sent ? 'inconclusiva' : 'nao_enviada';
      } finally { if (issuance === run && !loggingOut) { $('generate').disabled = false; $('logout').disabled = false; } }
    })();
    issuance = run;
    try { await run; } finally { if (issuance === run) issuance = null; }
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('command').textContent); status('Comando copiado. Cole no chat privado do bot.'); }
    catch { status('Selecione e copie o comando exibido para enviar ao bot.'); }
  });
  $('logout').addEventListener('click', async () => {
    if (loggingOut) return;
    loggingOut = true;
    generationEpoch++;
    clearCode();
    $('logout').disabled = true;
    $('generate').disabled = true;
    try {
      // Emissão conclusiva termina antes da revogação. Timeout, rede ou 5xx
      // não provam que o servidor parou: a saída fica para a tentativa seguinte.
      const pendingIssue = issuance;
      if (pendingIssue) {
        let outcome = 'inconclusiva';
        try { outcome = await pendingIssue; } catch { outcome = 'inconclusiva'; }
        if (outcome !== 'pronta' && outcome !== 'recusada' && outcome !== 'nao_enviada') {
          status('Não foi possível confirmar a emissão do código. A conta continua conectada. Tente sair de novo.', true);
          return;
        }
      }
      const session = client.readSession();
      const token = session && typeof session.accessToken === 'string' ? session.accessToken : '';
      if (!token) {
        // Sem token não há o que revogar no servidor. Não inventar {revogado:true}.
        if (session) {
          status('Não foi possível revogar os códigos pendentes. A conta continua conectada.', true);
          return;
        }
        await client.logout();
        showSession();
        return;
      }
      let revoked = false;
      try {
        const response = await fetch(config.supabaseUrl + '/functions/v1/telegram-link', { method: 'POST', headers: { authorization: 'Bearer ' + token, apikey: config.supabaseAnonKey, 'content-type': 'application/json' }, body: JSON.stringify({ revogar: true }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) });
        const payload = await response.json();
        revoked = response.ok === true && payload?.revogado === true;
      } catch { revoked = false; }
      if (!revoked) {
        status('Não foi possível revogar os códigos pendentes. A conta continua conectada.', true);
        return;
      }
      await client.logout();
      showSession();
    } finally {
      loggingOut = false;
      $('logout').disabled = false;
      $('generate').disabled = false;
    }
  });
  // Nada de código ou prova de vínculo em armazenamento persistente.
  // pagehide só apaga o código da tela. Não revoga: trocar para o bot não pode matar o código.
  window.addEventListener('pagehide', invalidateGeneration);
  if (client.restore()) { try { await client.refresh(); } catch { /* formulário continua disponível */ } }
  showSession();
})();
