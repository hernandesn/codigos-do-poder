/* Somente esta página carrega o SDK Telegram; nenhuma identidade vem do body. */
(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const status = (message, warning = false) => { $('status').textContent = message; $('status').classList.toggle('warning', warning); };
  const webapp = window.Telegram && window.Telegram.WebApp;
  const initData = webapp && webapp.initData;
  if (!initData) {
    status('Abra este mini app pelo @aion_codigosdopoder_bot no Telegram.');
    $('link-panel').hidden = false;
    return;
  }
  const config = window.ATLAS_PUBLIC_CONFIG;
  if (!config || config.supabaseUrl !== '__SUPABASE_ORIGIN__') {
    status('A configuração do serviço está indisponível.', true);
    return;
  }
  webapp.ready();
  webapp.expand();
  let proof = '';
  async function request(route, body) {
    const response = await fetch(config.supabaseUrl + '/functions/v1/telegram/app/' + route, {
      method: 'POST',
      headers: { authorization: 'tma ' + initData, 'content-type': 'application/json', ...(proof ? { 'x-telegram-app-session': proof } : {}) },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(75000),
      credentials: 'omit',
      redirect: 'error',
    });
    const result = await response.json();
    return { response, result };
  }
  function failed(response, result) {
    const messages = { sem_creditos: 'Seus créditos acabaram.', orcamento_esgotado: 'Chat temporariamente indisponível.', fora_da_base: 'Não encontrei isso na base do atlas.', rate_limit: 'Muitas perguntas seguidas. Aguarde um minuto.', sem_vinculo: 'Vincule sua conta e reabra o mini app pelo bot.', replay: 'Esta abertura já foi usada. Feche e abra novamente pelo bot.', sem_login: 'Sua sessão expirou. Feche e abra novamente pelo bot.' };
    status(messages[result.code] || result.message || 'Não foi possível concluir a pergunta.', true);
    if (result.code === 'sem_vinculo') { $('link-panel').hidden = false; $('chat-section').hidden = true; }
    if (response.status === 401) { proof = ''; $('send').disabled = true; }
  }
  function bubble(label, text, type) {
    const node = document.createElement('article');
    node.className = 'bubble ' + type;
    const title = document.createElement('h2'); title.textContent = label; node.append(title);
    if (text) { const p = document.createElement('p'); p.textContent = text; node.append(p); }
    $('history').append(node);
    return node;
  }
  function renderFinal(final) {
    const node = bubble('Resposta da base', '', 'answer');
    for (const block of final.blocos || []) {
      const section = document.createElement('section');
      section.className = 'answer-block' + (block.tipo === 'inferencia' ? ' inference' : '');
      const label = document.createElement('small'); label.textContent = block.tipo === 'inferencia' ? 'INFERÊNCIA' : 'DOCUMENTADO';
      const p = document.createElement('p'); p.textContent = block.texto;
      section.append(label, p); node.append(section);
    }
    for (const notice of final.avisos || []) { const p = document.createElement('p'); p.textContent = notice.texto; node.append(p); }
    for (const source of final.fontes || []) {
      const p = document.createElement('p'), detail = (final.fontes_detalhe || {})[source];
      p.className = 'sources'; p.textContent = '[' + source + '] ' + (detail ? detail.titulo + (detail.localizador ? ' · ' + detail.localizador : '') : source); node.append(p);
    }
    $('quota').textContent = 'Cota grátis restante: ' + final.gratis_restantes + '. Saldo pago: ' + final.saldo_pago + '.';
  }
  try {
    const { response, result } = await request('session');
    if (!response.ok) { failed(response, result); return; }
    proof = result.session;
    if (!result.linked) { status('Sua conta do Telegram ainda não está vinculada.'); $('link-panel').hidden = false; return; }
    $('chat-section').hidden = false;
    status('Conta vinculada. Faça sua pergunta à base.');
  } catch { status('Não foi possível conectar. Feche e abra novamente pelo bot.', true); return; }
  $('question-form').addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('question').value.trim();
    if (!message || !proof || $('send').disabled) return;
    $('send').disabled = true; $('question').disabled = true; $('model').disabled = true;
    $('question-form').setAttribute('aria-busy', 'true');
    bubble('Sua pergunta', message, 'question');
    status('Consultando a base…');
    try {
      const { response, result } = await request('chat', { mensagem: message, modelo: $('model').value });
      if (!response.ok || !result.final) { failed(response, result); return; }
      renderFinal(result.final); $('question').value = ''; status('Resposta concluída.');
    } catch { status('Não foi possível conectar. Tente novamente em instantes.', true); }
    finally {
      $('send').disabled = !proof; $('question').disabled = !proof; $('model').disabled = !proof;
      $('question-form').setAttribute('aria-busy', 'false');
    }
  });
})();
