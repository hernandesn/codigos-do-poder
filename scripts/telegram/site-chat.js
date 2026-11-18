/* Login Supabase Auth e chat da Edge Function. Sem resposta simulada. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.atlasAuthChat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'codigos-do-poder:auth:v1';
  const CHAT_DRAFT_KEY = 'codigos-do-poder:chat-draft:v1';
  const CHAT_DRAFT_TTL = 30 * 60 * 1000;
  const MESSAGES = {
    config_ausente: 'Chat indisponível: a configuração pública do Supabase não está definida.',
    sem_login: 'Entre para usar o chat.',
    sessao_expirada: 'Sessão expirada. Entre de novo.',
    sem_creditos: 'Seus créditos acabaram.',
    orcamento_esgotado: 'Chat temporariamente indisponível.',
    rate_limit: 'Muitas perguntas seguidas. Tente de novo em instantes.',
    fora_da_base: 'Não encontrei isso na base do atlas.',
    modelo_indisponivel: 'O modelo está indisponível agora. Tente de novo.',
    modelo_ocupado: 'Muitas perguntas agora, tente em alguns segundos.',
    pedido_invalido: 'Pergunta inválida (até 2000 caracteres e 3 entidades).',
    rede: 'Não foi possível conectar ao chat.',
    abortado: 'Pedido cancelado.',
    incompleto: 'A resposta não chegou completa.',
    credencial: 'E-mail ou senha não conferem.',
    email_nao_confirmado: 'Confirme seu e-mail pelo link que enviamos para usar o chat',
    provedor_desligado: 'O cadastro por e-mail e senha está desligado neste projeto.',
    conta_existente: 'Este e-mail já tem conta. Entre com a senha.',
    senha_fraca: 'A senha não foi aceita. Use uma senha mais forte.',
    cadastro_recusado: 'Não foi possível criar a conta.',
    captcha_pendente: 'Confirme o desafio para continuar.',
    confirmacao_email: 'Conta criada. Confirme o e-mail antes de entrar. O link volta para este site.',
    confirmacao_ambigua: 'Se o e-mail ainda não tinha conta, a confirmação foi enviada. Se já tinha, entre com a senha.',
  };

  const INTENDED_ORIGIN = 'https://aion.hernandesnogueira.com.br';

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function decodePart(part) {
    try {
      const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + pad;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  function serviceRoleKey(key) {
    const parts = String(key).split('.');
    if (parts.length !== 3) return false;
    const payload = decodePart(parts[1]);
    return !!payload && payload.role === 'service_role';
  }

  function tokenExp(token, now) {
    const payload = token ? decodePart(String(token).split('.')[1] || '') : null;
    if (!payload || typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 <= (now || Date.now()) + 30000;
  }

  function publicTurnstileSiteKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!/^[0-9A-Za-z_-]{1,100}$/.test(key)) return '';
    const lower = key.toLowerCase();
    if (lower.includes('secret') || lower.startsWith('sk-') || lower.includes('service_role') || lower.startsWith('sb_secret')) return '';
    // Sitekey de teste tem 24 caracteres. As três chaves secretas de teste têm 35 e não entram no site.
    if (/^[123]x0{31}aa$/i.test(key)) return '';
    return key;
  }

  function parsePublicConfig(raw) {
    const url = typeof raw?.supabaseUrl === 'string' ? raw.supabaseUrl.trim().replace(/\/+$/, '') : '';
    const key = typeof raw?.supabaseAnonKey === 'string' ? raw.supabaseAnonKey.trim() : '';
    let parsed;
    try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
    const hostOk = parsed && (parsed.protocol === 'https:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    const keyUnsafe = !key || /sb_secret_|sk-or-|postgresql:\/\//i.test(key) || serviceRoleKey(key);
    if (!hostOk || keyUnsafe || parsed.username || parsed.password) {
      return { ok: false, message: MESSAGES.config_ausente };
    }
    return {
      ok: true,
      supabaseUrl: parsed.origin,
      supabaseAnonKey: key,
      turnstileSiteKey: publicTurnstileSiteKey(raw?.turnstileSiteKey),
    };
  }

  function buildChatBody(input) {
    const entidades = [];
    for (const id of input.entidades || []) {
      if (typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(id) && !entidades.includes(id) && entidades.length < 3) {
        entidades.push(id);
      }
    }
    const body = {
      mensagem: String(input.mensagem || '').trim(),
      modelo: input.modelo === 'avancado' ? 'avancado' : 'basico',
      contexto: { entidades },
    };
    if (input.view && typeof input.view === 'string') body.contexto.view = input.view.slice(0, 80);
    if (input.conversaId && /^[A-Za-z0-9_-]{1,80}$/.test(input.conversaId)) body.conversa_id = input.conversaId;
    return body;
  }

  function createSseParser() {
    let buffer = '';
    function parseBlock(raw) {
      const lines = raw.split(/\r?\n/);
      let event = 'message';
      const data = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) return null;
      try { return { event, data: JSON.parse(data.join('\n')) }; } catch { return { event, data: null, raw: data.join('\n') }; }
    }
    function drain(finalChunk) {
      if (finalChunk) buffer += finalChunk;
      const events = [];
      let match = buffer.match(/\r?\n\r?\n/);
      while (match && match.index !== undefined) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseBlock(raw);
        if (parsed) events.push(parsed);
        match = buffer.match(/\r?\n\r?\n/);
      }
      return events;
    }
    return {
      push(chunk) { return drain(chunk); },
      finish() {
        const rest = buffer.trim() ? drain('\n\n') : [];
        buffer = '';
        return rest;
      },
    };
  }

  function parseSse(text) {
    const parser = createSseParser();
    return parser.push(text).concat(parser.finish());
  }

  function mapChatFailure(status, events, raw) {
    const error = (events || []).find((item) => item.event === 'error' && item.data && item.data.code);
    if (error) {
      const code = String(error.data.code);
      const message = typeof error.data.message === 'string' && error.data.message.trim()
        ? error.data.message.trim()
        : (MESSAGES[code] || MESSAGES.incompleto);
      return { ok: false, code, message, retry_after_s: error.data.retry_after_s };
    }
    const finalEvent = (events || []).find((item) => item.event === 'final' && item.data);
    if (status === 200 && finalEvent) return { ok: true, code: 'ok', final: finalEvent.data, events };
    if (status === 401) return { ok: false, code: 'sem_login', message: MESSAGES.sessao_expirada };
    if (raw) {
      try {
        const json = JSON.parse(raw);
        if (json && typeof json.code === 'string') {
          return { ok: false, code: json.code, message: typeof json.message === 'string' ? json.message : (MESSAGES[json.code] || MESSAGES.incompleto) };
        }
      } catch { /* corpo que não é JSON */ }
    }
    if (status === 402) return { ok: false, code: 'sem_creditos', message: MESSAGES.sem_creditos };
    if (status === 503) return { ok: false, code: 'orcamento_esgotado', message: MESSAGES.orcamento_esgotado };
    if (status >= 500 || status === 0) return { ok: false, code: 'rede', message: MESSAGES.rede };
    return { ok: false, code: 'incompleto', message: MESSAGES.incompleto };
  }

  function authHeaders(config, token) {
    const headers = { apikey: config.supabaseAnonKey, 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  function authCredentialsBody(email, password, captchaToken) {
    const body = { email, password };
    if (typeof captchaToken === 'string' && captchaToken) {
      body.gotrue_meta_security = { captcha_token: captchaToken };
    }
    return JSON.stringify(body);
  }

  function signupRedirect(locationLike) {
    const loc = locationLike || (typeof location !== 'undefined' ? location : null);
    if (!loc || typeof loc.origin !== 'string') return INTENDED_ORIGIN;
    let origin;
    try { origin = new URL(loc.origin).origin; } catch { return INTENDED_ORIGIN; }
    const host = new URL(origin).hostname;
    if (origin === INTENDED_ORIGIN || origin === 'https://hernandesn.github.io' || host === 'localhost' || host === '127.0.0.1') {
      const path = typeof loc.pathname === 'string' && loc.pathname.startsWith('/') ? loc.pathname : '/';
      return origin + path;
    }
    return INTENDED_ORIGIN;
  }

  function sessionFromRedirectHash(hash, now) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw || !raw.includes('access_token')) return null;
    const params = new URLSearchParams(raw);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const type = params.get('type');
    if (!accessToken || !refreshToken) return null;
    if (type !== 'signup' && type !== 'email') return null;
    const expiresIn = Number(params.get('expires_in'));
    const expiresAt = (now || Date.now()) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000);
    return { accessToken, refreshToken, expiresAt };
  }

  async function readErrorCode(response) {
    try {
      const body = await response.json();
      if (!body || typeof body !== 'object') return '';
      return String(body.error_code || body.error || '');
    } catch {
      return '';
    }
  }

  function sessionFromTokenResponse(payload, now) {
    if (!payload || typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') return null;
    const expiresIn = Number(payload.expires_in);
    const expiresAt = (now || Date.now()) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000);
    return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt };
  }

  async function readBody(response) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      return { text, events: parseSse(text) };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const events = [];
    let text = '';
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = decoder.decode(step.value, { stream: true });
      text += chunk;
      events.push(...parser.push(chunk));
    }
    events.push(...parser.finish());
    return { text, events };
  }

  function createClient(deps) {
    const fetchImpl = deps.fetchImpl || fetch;
    const storage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem() { return null; }, setItem() {}, removeItem() {} });
    const now = deps.now || (() => Date.now());
    let session = null;

    function persist(next) {
      session = next;
      if (!next) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    }

    function restore() {
      try {
        const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        if (saved && typeof saved.accessToken === 'string' && typeof saved.refreshToken === 'string') {
          session = saved;
          return saved;
        }
      } catch { /* sessão ilegível */ }
      session = null;
      return null;
    }

    async function login(email, password, captchaToken) {
      const config = parsePublicConfig(deps.config);
      if (!config.ok) return { ok: false, code: 'config_ausente', message: config.message };
      let response;
      try {
        response = await fetchImpl(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: authHeaders(config),
          body: authCredentialsBody(email, password, captchaToken),
        });
      } catch {
        return { ok: false, code: 'rede', message: MESSAGES.rede };
      }
      if (response.status === 400 || response.status === 401 || response.status === 422) {
        const code = await readErrorCode(response);
        if (code === 'email_not_confirmed') return { ok: false, code: 'email_nao_confirmado', message: MESSAGES.email_nao_confirmado };
        return { ok: false, code: 'credencial', message: MESSAGES.credencial };
      }
      if (!response.ok) return { ok: false, code: 'rede', message: MESSAGES.rede };
      const saved = sessionFromTokenResponse(await response.json(), now());
      if (!saved) return { ok: false, code: 'rede', message: MESSAGES.rede };
      persist(saved);
      return { ok: true, session: saved };
    }

    async function signup(email, password, locationLike, captchaToken) {
      const config = parsePublicConfig(deps.config);
      if (!config.ok) return { ok: false, code: 'config_ausente', message: config.message };
      const redirectTo = signupRedirect(locationLike);
      let response;
      try {
        response = await fetchImpl(`${config.supabaseUrl}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
          method: 'POST',
          headers: authHeaders(config),
          body: authCredentialsBody(email, password, captchaToken),
        });
      } catch {
        return { ok: false, code: 'rede', message: MESSAGES.rede };
      }
      if (!response.ok) {
        const code = await readErrorCode(response);
        if (code === 'email_provider_disabled' || code === 'signup_disabled' || code === 'provider_disabled') {
          return { ok: false, code: 'provedor_desligado', message: MESSAGES.provedor_desligado };
        }
        if (code === 'user_already_exists') return { ok: false, code: 'conta_existente', message: MESSAGES.conta_existente };
        if (code === 'weak_password') return { ok: false, code: 'senha_fraca', message: MESSAGES.senha_fraca };
        return { ok: false, code: 'cadastro_recusado', message: MESSAGES.cadastro_recusado };
      }
      const payload = await response.json();
      const saved = sessionFromTokenResponse(payload, now());
      if (saved) {
        persist(saved);
        return { ok: true, session: saved, confirmation: 'sessao' };
      }
      const user = payload && payload.user && typeof payload.user === 'object' ? payload.user : payload;
      const identities = user && Array.isArray(user.identities) ? user.identities : null;
      if (identities && identities.length === 0) {
        return { ok: true, session: null, confirmation: 'ambiguo', message: MESSAGES.confirmacao_ambigua };
      }
      if (user && (typeof user.confirmation_sent_at === 'string' || (identities && identities.length > 0))) {
        return { ok: true, session: null, confirmation: 'email', message: MESSAGES.confirmacao_email };
      }
      return { ok: false, code: 'rede', message: MESSAGES.rede };
    }

    function adoptRedirectHash(hash) {
      const saved = sessionFromRedirectHash(hash, now());
      if (!saved) return null;
      persist(saved);
      return saved;
    }

    async function refresh() {
      const config = parsePublicConfig(deps.config);
      const current = session || restore();
      if (!config.ok) return { ok: false, code: 'config_ausente', message: config.message };
      if (!current?.refreshToken) return { ok: false, code: 'sem_login', message: MESSAGES.sem_login };
      let response;
      try {
        response = await fetchImpl(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: authHeaders(config),
          body: JSON.stringify({ refresh_token: current.refreshToken }),
        });
      } catch {
        return { ok: false, code: 'rede', message: MESSAGES.rede };
      }
      if (!response.ok) {
        persist(null);
        return { ok: false, code: 'sessao_expirada', message: MESSAGES.sessao_expirada };
      }
      const saved = sessionFromTokenResponse(await response.json(), now());
      if (!saved) {
        persist(null);
        return { ok: false, code: 'sessao_expirada', message: MESSAGES.sessao_expirada };
      }
      persist(saved);
      return { ok: true, session: saved };
    }

    async function logout() {
      const config = parsePublicConfig(deps.config);
      const current = session || restore();
      persist(null);
      if (!config.ok || !current?.accessToken) return { ok: true };
      try {
        await fetchImpl(`${config.supabaseUrl}/auth/v1/logout?scope=local`, {
          method: 'POST',
          headers: authHeaders(config, current.accessToken),
        });
      } catch { /* a sessão local já foi apagada */ }
      return { ok: true };
    }

    async function ensureSession() {
      const config = parsePublicConfig(deps.config);
      if (!config.ok) return { ok: false, code: 'config_ausente', message: config.message };
      const current = session || restore();
      if (!current?.accessToken) return { ok: false, code: 'sem_login', message: MESSAGES.sem_login };
      if (!tokenExp(current.accessToken, now()) && current.expiresAt > now() + 30000) return { ok: true, session: current, config };
      const refreshed = await refresh();
      if (!refreshed.ok) return refreshed;
      return { ok: true, session: refreshed.session, config };
    }

    async function postChat(config, accessToken, body, signal) {
      return fetchImpl(`${config.supabaseUrl}/functions/v1/chat`, {
        method: 'POST',
        signal,
        headers: {
          ...authHeaders(config, accessToken),
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
    }

    async function ask(input) {
      const ready = await ensureSession();
      if (!ready.ok) return ready;
      const body = buildChatBody(input || {});
      if (!body.mensagem || body.mensagem.length > 2000) {
        return { ok: false, code: 'pedido_invalido', message: MESSAGES.pedido_invalido };
      }
      const send = async (accessToken) => {
        try {
          return await postChat(ready.config, accessToken, body, input && input.signal);
        } catch (error) {
          if (input?.signal?.aborted || error?.name === 'AbortError') {
            return { aborted: true };
          }
          return { network: true };
        }
      };
      let response = await send(ready.session.accessToken);
      if (response && response.aborted) return { ok: false, code: 'abortado', message: MESSAGES.abortado };
      if (response && response.network) return { ok: false, code: 'rede', message: MESSAGES.rede };
      if (response.status === 401) {
        const refreshed = await refresh();
        if (!refreshed.ok) return { ok: false, code: 'sessao_expirada', message: MESSAGES.sessao_expirada };
        response = await send(refreshed.session.accessToken);
        if (response && response.aborted) return { ok: false, code: 'abortado', message: MESSAGES.abortado };
        if (response && response.network) return { ok: false, code: 'rede', message: MESSAGES.rede };
        if (response.status === 401) return { ok: false, code: 'sessao_expirada', message: MESSAGES.sessao_expirada };
      }
      const read = await readBody(response);
      const mapped = mapChatFailure(response.status, read.events, read.text);
      mapped.events = read.events;
      return mapped;
    }

    return { login, signup, logout, refresh, restore, adoptRedirectHash, ask, readSession: () => session || restore() };
  }

  function selectedContext() {
    const host = typeof globalThis !== 'undefined' ? globalThis : null;
    const state = host && host.mural && host.mural.getState ? host.mural.getState() : null;
    const id = state && state.selected && state.selected.kind === 'node' ? state.selected.id : '';
    const entidades = state?.selected?.kind === 'edge' && Array.isArray(state.selectedEndpoints)
      ? state.selectedEndpoints.slice(0, 2) : id ? [id] : [];
    return { entidades: entidades.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(id)), view: state && state.view ? state.view : '' };
  }

  function mount(doc, deps) {
    const documentRef = doc || document;
    const client = createClient(deps);
    const $ = (id) => documentRef.getElementById(id);
    const config = parsePublicConfig(deps.config);
    let conversaId = '';
    let inflight = null;
    let exchangeNumber = 0;
    const view = deps.window || documentRef.defaultView || (typeof window !== 'undefined' ? window : null);
    let draftStorage = null;
    let pendingChat = null;
    let draftInMemory = false;
    try {
      draftStorage = deps.draftStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
      // Remove cópias da versão por aba; só a cópia compartilhada pode ser consumida.
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(CHAT_DRAFT_KEY);
    } catch { /* rascunho indisponível; o campo continua preservado nesta página */ }
    const draftNow = deps.now || (() => Date.now());

    function clearChatDraft() {
      pendingChat = null;
      draftInMemory = false;
      try { draftStorage?.removeItem(CHAT_DRAFT_KEY); } catch {}
    }

    function readChatDraft() {
      let saved = pendingChat;
      try { if (draftStorage && !draftInMemory) saved = JSON.parse(draftStorage.getItem(CHAT_DRAFT_KEY) || 'null'); } catch {}
      if (saved && typeof saved.message === 'string' && saved.message.length <= 2000 &&
          Number.isFinite(saved.expiresAt) && saved.expiresAt > draftNow() && saved.expiresAt <= draftNow() + CHAT_DRAFT_TTL) return saved;
      clearChatDraft();
      return null;
    }

    function rememberChat() {
      const panel = $('chat-panel');
      const message = $('chat-mensagem');
      if (!panel || panel.hidden || !message?.value.trim()) return;
      pendingChat = { message: message.value.slice(0, 2000), expiresAt: draftNow() + CHAT_DRAFT_TTL };
      draftInMemory = true;
      try { if (draftStorage) { draftStorage.setItem(CHAT_DRAFT_KEY, JSON.stringify(pendingChat)); draftInMemory = false; } } catch {}
    }

    function restoreChat() {
      const saved = readChatDraft();
      if (!saved) return;
      clearChatDraft();
      const message = $('chat-mensagem');
      const panel = $('chat-panel');
      if (message) message.value = saved.message;
      if (panel) panel.hidden = false;
    }
    readChatDraft(); // Descarta rascunhos vencidos ou inválidos também ao abrir como visitante.

    function setStatus(text) {
      const node = $('chat-status');
      if (node) node.textContent = text || '';
    }

    function renderSession() {
      const button = $('auth-button');
      const current = client.readSession();
      const active = !!(current && !tokenExp(current.accessToken, Date.now()));
      if (button) button.textContent = active ? 'Sair' : 'Entrar';
      const send = $('chat-send');
      const message = $('chat-mensagem');
      const blocked = !config.ok || !active;
      if (send) send.disabled = blocked || !!inflight;
      if (message) message.disabled = blocked;
      if (!active && !inflight && message?.value) rememberChat();
      const gate = $('chat-gate');
      const form = $('chat-form');
      const log = $('chat-log');
      if (gate) gate.hidden = active;
      if (form) form.hidden = !active;
      if (log) log.hidden = !active;
      if (active) {
        restoreChat();
        if ($('chat-status')?.textContent === MESSAGES.sem_login) setStatus('');
      }
      if (!config.ok) setStatus(config.message);
      else if (!active) setStatus(MESSAGES.sem_login);
      const context = $('chat-context');
      if (context) {
        const selected = selectedContext();
        context.textContent = selected.entidades.length
          ? `Recorte enviado: ${selected.entidades.join(', ')}`
          : 'Selecione uma pessoa ou instituição no mural, ou cite o nome dela na pergunta.';
      }
    }

    function appendExchange(question, result) {
      const log = $('chat-log');
      if (!log) return;
      const item = documentRef.createElement('article');
      item.className = 'chat-turn';
      const ask = documentRef.createElement('p');
      ask.className = 'chat-question';
      const questionText = documentRef.createElement('span');
      questionText.className = 'chat-question-text';
      questionText.textContent = question;
      ask.appendChild(questionText);
      const more = documentRef.createElement('button');
      more.type = 'button'; more.className = 'chat-more'; more.textContent = 'ver mais'; more.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        const expanded = ask.dataset.expanded !== 'true';
        ask.dataset.expanded = String(expanded);
        more.setAttribute('aria-expanded', String(expanded));
        more.textContent = expanded ? 'ver menos' : 'ver mais';
      });
      ask.appendChild(more);
      item.appendChild(ask);
      if (result.ok && result.final) {
        for (const aviso of result.final.avisos || []) {
          if (!aviso || typeof aviso.texto !== 'string') continue;
          const notice = documentRef.createElement('p'); notice.className = 'chat-meta'; notice.textContent = aviso.texto; item.appendChild(notice);
        }
        const blocos = Array.isArray(result.final.blocos) ? result.final.blocos : [];
        const sourceIds = [...new Set((Array.isArray(result.final.fontes) && result.final.fontes.length
          ? result.final.fontes : blocos.flatMap((bloco) => Array.isArray(bloco.fontes) ? bloco.fontes : []))
          .filter((id) => typeof id === 'string' && id))];
        const sourcePrefix = `chat-source-${++exchangeNumber}-`;
        const sources = documentRef.createElement(sourceIds.length ? 'details' : 'div');
        sources.open = !(view?.matchMedia?.('(max-width:899px)').matches);
        sources.className = 'chat-sources';
        for (const bloco of blocos) {
          const p = documentRef.createElement('p');
          p.className = bloco.tipo === 'hipotese' ? 'chat-hypothesis' : bloco.tipo === 'inferencia' ? 'chat-inference' : 'chat-answer';
          p.textContent = typeof bloco.texto === 'string' ? bloco.texto : '';
          for (const id of Array.isArray(bloco.fontes) ? bloco.fontes : []) {
            const index = sourceIds.indexOf(id);
            if (index < 0) continue;
            const chip = documentRef.createElement('button');
            chip.type = 'button'; chip.className = 'chat-citation'; chip.textContent = `[${index + 1}]`;
            chip.setAttribute('aria-label', `Ver fonte ${id}`);
            chip.setAttribute('aria-controls', sourcePrefix + index);
            chip.addEventListener('click', () => {
              sources.open = true;
              const target = $(sourcePrefix + index);
              if (target?.getBoundingClientRect && log.getBoundingClientRect) log.scrollTop += target.getBoundingClientRect().top - log.getBoundingClientRect().top;
            });
            p.appendChild(chip);
          }
          item.appendChild(p);
        }
        if (!blocos.length) {
          const p = documentRef.createElement('p');
          p.className = 'chat-error';
          p.textContent = MESSAGES.incompleto;
          item.appendChild(p);
        }
        const relationIds = [...new Set(blocos.flatMap((bloco) => {
          const ids = bloco.tipo === 'inferencia' ? bloco.base : bloco.tipo === 'documentado' ? bloco.relacoes : [];
          return Array.isArray(ids) ? ids : [];
        }).filter((id) => typeof id === 'string' && id))].slice(0, 12);
        const list = documentRef.createElement('ul');
        if (sourceIds.length) {
          const sourceHeading = documentRef.createElement('summary');
          sourceHeading.textContent = `Fontes (${sourceIds.length}) ▾`;
          sources.appendChild(sourceHeading);
        }
        for (const id of sourceIds) {
          const detalhe = result.final.fontes_detalhe?.[id];
          const titulo = typeof detalhe?.titulo === 'string' && detalhe.titulo.trim() ? detalhe.titulo : id;
          let url;
          try {
            const parsed = new URL(detalhe?.url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
          } catch {}
          const li = documentRef.createElement('li');
          li.id = sourcePrefix + sourceIds.indexOf(id);
          if (url) {
            const link = documentRef.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
            link.textContent = titulo;
            li.appendChild(link);
          } else li.textContent = titulo;
          if (typeof detalhe?.localizador === 'string' && detalhe.localizador.trim()) {
            const locator = documentRef.createElement('span');
            locator.textContent = ` · ${detalhe.localizador}`;
            li.appendChild(locator);
          }
          list.appendChild(li);
        }
        if (sourceIds.length) sources.appendChild(list);
        if (relationIds.length) {
          const relationHeading = documentRef.createElement('h4');
          relationHeading.textContent = 'Relações usadas';
          sources.appendChild(relationHeading);
          const relations = documentRef.createElement('p');
          relations.textContent = relationIds.join(', ');
          sources.appendChild(relations);
        }
        if (sourceIds.length || relationIds.length) item.appendChild(sources);
        const meta = documentRef.createElement('p');
        meta.className = 'chat-meta';
        const gratis = result.final.gratis_restantes;
        const saldo = result.final.saldo_pago;
        meta.textContent = `Depois deste pedido · grátis restantes ${gratis ?? '—'} · saldo pago ${saldo ?? '—'}`;
        item.appendChild(meta);
        if (result.final.conversa_id) conversaId = result.final.conversa_id;
      } else {
        const p = documentRef.createElement('p');
        p.className = 'chat-error';
        p.dataset.code = result.code || '';
        p.textContent = result.message || MESSAGES.incompleto;
        item.appendChild(p);
        if (result.code === 'fora_da_base') {
          const tip = documentRef.createElement('p');
          tip.className = 'chat-tip';
          tip.textContent = 'Dica: selecione a entidade no mural antes de perguntar.';
          item.appendChild(tip);
        }
      }
      log.appendChild(item);
      if (questionText.scrollHeight > questionText.clientHeight + 1) more.hidden = false;
      const start = item.children[1] || item;
      if (start.getBoundingClientRect && log.getBoundingClientRect) log.scrollTop += start.getBoundingClientRect().top - log.getBoundingClientRect().top;
    }

    async function onAsk(event) {
      event.preventDefault();
      if (inflight) return;
      const message = $('chat-mensagem');
      const text = message ? message.value.trim() : '';
      if (!text) return;
      const modelo = $('chat-modelo') ? $('chat-modelo').value : 'basico';
      const context = selectedContext();
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      clearChatDraft();
      inflight = controller;
      renderSession();
      setStatus('Procurando na base…');
      if ($('chat-status')) $('chat-status').dataset.thinking = 'true';
      const cancel = $('chat-cancel');
      if (cancel) cancel.hidden = false;
      const result = await client.ask({
        mensagem: text,
        modelo,
        entidades: context.entidades,
        view: context.view,
        conversaId,
        signal: controller ? controller.signal : undefined,
      });
      inflight = null;
      if ($('chat-status')) delete $('chat-status').dataset.thinking;
      if (cancel) cancel.hidden = true;
      if (result.ok) { clearChatDraft(); if (message) message.value = ''; resizeMessage(); }
      appendExchange(text, result);
      renderSession();
      if (!result.ok) setStatus(result.message);
      else setStatus('Resposta recebida do chat.');
    }

    let authMode = 'entrar';
    function setAuthMode(next) {
      authMode = next === 'criar' ? 'criar' : 'entrar';
      const title = $('auth-title');
      const submit = $('auth-submit');
      const toggle = $('auth-mode');
      const password = $('auth-password');
      const note = $('auth-note');
      const status = $('auth-status');
      const error = $('auth-error');
      if (title) title.textContent = authMode === 'criar' ? 'Criar conta' : 'Entrar';
      if (submit) submit.textContent = authMode === 'criar' ? 'Criar conta' : 'Entrar';
      if (toggle) {
        toggle.textContent = authMode === 'criar' ? 'Já tenho conta' : 'Criar conta';
        toggle.setAttribute('aria-pressed', authMode === 'criar' ? 'true' : 'false');
      }
      if (password) password.autocomplete = authMode === 'criar' ? 'new-password' : 'current-password';
      if (note) {
        note.textContent = authMode === 'criar'
          ? 'Você escolhe o e-mail e a senha. Se o projeto pedir confirmação, o link volta para este site.'
          : 'Entre com o e-mail e a senha da sua conta.';
      }
      if (status) { status.hidden = true; status.textContent = ''; }
      if (error) error.hidden = true;
    }
    const authModeButton = $('auth-mode');
    if (authModeButton) authModeButton.addEventListener('click', () => setAuthMode(authMode === 'criar' ? 'entrar' : 'criar'));

    const loc = deps.location || (typeof location !== 'undefined' ? location : null);
    if (loc && loc.hash) {
      const adopted = client.adoptRedirectHash(loc.hash);
      if (adopted && typeof loc.replaceHash === 'function') loc.replaceHash();
      else if (adopted && typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', (loc.pathname || '/') + (loc.search || ''));
      }
    }

    const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    let heldCaptchaToken = '';
    let turnstileWidgetId = null;
    let turnstileScript = null;

    function resetCaptcha() {
      heldCaptchaToken = '';
      const api = typeof globalThis !== 'undefined' ? globalThis.turnstile : undefined;
      if (!api || turnstileWidgetId == null || typeof api.reset !== 'function') return;
      try { api.reset(turnstileWidgetId); } catch { /* desafio já descartado */ }
    }

    function renderTurnstile() {
      const siteKey = config.ok ? config.turnstileSiteKey : '';
      if (!siteKey || turnstileWidgetId != null || turnstileScript || !$('auth-turnstile')) return;
      if (typeof documentRef.createElement !== 'function') return;
      const parent = documentRef.head || documentRef.body || documentRef.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') return;
      const script = documentRef.createElement('script');
      script.src = TURNSTILE_SRC;
      script.async = true;
      if (typeof script.setAttribute === 'function') script.setAttribute('data-turnstile', 'explicit');
      script.onload = () => {
        const api = typeof globalThis !== 'undefined' ? globalThis.turnstile : undefined;
        const target = $('auth-turnstile');
        if (!api || typeof api.render !== 'function' || !target || turnstileWidgetId != null) return;
        try {
          turnstileWidgetId = api.render(target, {
            sitekey: siteKey,
            callback(token) { heldCaptchaToken = typeof token === 'string' ? token : ''; },
            'expired-callback'() { heldCaptchaToken = ''; },
            'error-callback'() { heldCaptchaToken = ''; },
          });
        } catch { turnstileWidgetId = null; }
      };
      script.onerror = () => {
        turnstileScript = null;
        if (typeof script.remove === 'function') script.remove();
      };
      turnstileScript = script;
      parent.appendChild(script);
    }

    function openLogin() {
      rememberChat();
      const dialog = $('auth-dialog');
      const error = $('auth-error');
      if (error) error.hidden = true;
      if (!config.ok && error) { error.hidden = false; error.textContent = config.message; }
      if (config.ok && config.turnstileSiteKey) renderTurnstile();
      if (dialog && dialog.showModal) dialog.showModal();
    }
    const chatLogin = $('chat-login');
    if (chatLogin) chatLogin.addEventListener('click', openLogin);
    const authButton = $('auth-button');
    if (authButton) authButton.addEventListener('click', async () => {
      const current = client.readSession();
      if (current && !tokenExp(current.accessToken, Date.now())) {
        clearChatDraft();
        if ($('chat-mensagem')) $('chat-mensagem').value = '';
        await client.logout();
        renderSession();
        return;
      }
      openLogin();
    });
    const authForm = $('auth-form');
    if (authForm) authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = $('auth-error');
      const email = $('auth-email') ? $('auth-email').value.trim() : '';
      const password = $('auth-password') ? $('auth-password').value : '';
      const siteKey = config.ok ? config.turnstileSiteKey : '';
      if (siteKey && $('auth-turnstile') && !heldCaptchaToken) {
        if (error) { error.hidden = false; error.textContent = MESSAGES.captcha_pendente; }
        const status = $('auth-status');
        if (status) status.hidden = true;
        return;
      }
      const captchaToken = heldCaptchaToken;
      try {
        const result = authMode === 'criar'
          ? await client.signup(email, password, deps.location, captchaToken)
          : await client.login(email, password, captchaToken);
        if ($('auth-password')) $('auth-password').value = '';
        if (!result.ok) {
          if (error) { error.hidden = false; error.textContent = result.message; }
          const status = $('auth-status');
          if (status) status.hidden = true;
          return;
        }
        if (result.confirmation === 'email' || result.confirmation === 'ambiguo') {
          const status = $('auth-status');
          if (status) { status.hidden = false; status.textContent = result.message; }
          if (error) error.hidden = true;
          renderSession();
          return;
        }
        const dialog = $('auth-dialog');
        if (dialog && dialog.close) dialog.close();
        renderSession();
      } finally {
        if (siteKey) resetCaptcha();
      }
    });
    const authCancel = $('auth-cancel');
    if (authCancel) authCancel.addEventListener('click', () => {
      const dialog = $('auth-dialog');
      if (dialog && dialog.close) dialog.close();
    });
    const open = $('chat-open');
    if (open) open.addEventListener('click', () => {
      const panel = $('chat-panel');
      if (panel) panel.hidden = false;
      renderSession();
      resizeViewport();
      resizeMessage();
    });
    const close = $('chat-close');
    if (close) close.addEventListener('click', () => {
      const panel = $('chat-panel');
      if (panel) panel.hidden = true;
    });
    function resizeMessage() {
      const field = $('chat-mensagem');
      if (!field?.style) return;
      field.style.height = '44px';
      field.style.height = `${Math.min(96, Math.max(44, field.scrollHeight))}px`;
    }
    function resizeViewport() {
      const panel = $('chat-panel');
      if (!panel?.style || !view) return;
      const viewport = view.visualViewport;
      const height = viewport?.height || view.innerHeight;
      const offset = viewport?.offsetTop || 0;
      const header = view.innerWidth <= 820 ? 62 : 70;
      const top = Math.max(header, offset);
      panel.style.setProperty('--chat-top', `${top}px`);
      panel.style.setProperty('--chat-height', `${Math.max(0, height - (top - offset))}px`);
      panel.style.setProperty('--chat-visible-height', `${height}px`);
    }
    $('chat-mensagem')?.addEventListener?.('input', resizeMessage);
    const viewport = view && view.visualViewport;
    if (viewport && typeof viewport.addEventListener === 'function') {
      viewport.addEventListener('resize', resizeViewport);
      viewport.addEventListener('scroll', resizeViewport);
    }
    if (view && typeof view.addEventListener === 'function') view.addEventListener('resize', resizeViewport);
    const chips = documentRef.querySelectorAll?.('input[name="chat-model-chip"]') || [];
    for (const chip of chips) chip.addEventListener('change', () => { if (chip.checked && $('chat-modelo')) $('chat-modelo').value = chip.value; });
    $('chat-modelo')?.addEventListener('change', () => { for (const chip of chips) chip.checked = chip.value === $('chat-modelo').value; });
    resizeViewport();
    const form = $('chat-form');
    if (form) form.addEventListener('submit', onAsk);
    const cancel = $('chat-cancel');
    if (cancel) cancel.addEventListener('click', () => { if (inflight) inflight.abort(); });
    client.restore();
    const saved = client.readSession();
    if (saved && tokenExp(saved.accessToken, Date.now())) {
      client.refresh().finally(renderSession);
    } else {
      renderSession();
    }
    return { client, renderSession };
  }

  function boot() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    if (!document.getElementById('chat-panel')) return;
    mount(document, { config: typeof globalThis !== 'undefined' ? globalThis.ATLAS_PUBLIC_CONFIG : null });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return {
    MESSAGES,
    INTENDED_ORIGIN,
    esc,
    signupRedirect,
    sessionFromRedirectHash,
    tokenExp,
    parsePublicConfig,
    buildChatBody,
    createSseParser,
    parseSse,
    mapChatFailure,
    sessionFromTokenResponse,
    createClient,
    mount,
  };
});
