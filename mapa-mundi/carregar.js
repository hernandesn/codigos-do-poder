/* Gancho sempre carregado. O mapa, o d3 e o JSON só entram em #mapa-mundi. */
(function () {
  'use strict';
  var nav = document.getElementById('map-mode');
  if (!nav || nav.querySelector('[data-mapa-mundi]')) return;

  var botao = document.createElement('button');
  botao.type = 'button';
  botao.setAttribute('data-mapa-mundi', '');
  botao.textContent = 'Mapa-múndi';
  nav.appendChild(botao);

  var ancora = null;
  var promessa = null;
  var passe = false;
  var guarda = false;
  var fila = '';

  function isoDe(hash) {
    var m = String(hash == null ? location.hash : hash).match(/^#mapa-mundi(?:\/([A-Z]{2}))?$/);
    if (!m) return null;
    return m[1] || '';
  }

  function base() {
    var s = document.querySelector('script[src*="mapa-mundi/carregar.js"]');
    return new URL('.', s ? s.src : 'mapa-mundi/carregar.js').href;
  }

  function vista() {
    try { return window.mural && window.mural.getState().view; } catch (e) { return ''; }
  }

  function marcar() {
    if (!document.body.classList.contains('mapa-mundi-aberto')) return;
    guarda = true;
    if (nav.hidden) nav.hidden = false;
    var bs = nav.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var atual = bs[i].getAttribute('aria-current') === 'page';
      var quer = bs[i].hasAttribute('data-mapa-mundi');
      if (quer && !atual) bs[i].setAttribute('aria-current', 'page');
      else if (!quer && atual) bs[i].removeAttribute('aria-current');
    }
    var c = document.getElementById('map-mode-count');
    if (c && c.textContent) {
      if (!c.dataset.mmTexto) c.dataset.mmTexto = c.textContent;
      c.textContent = '';
    }
    guarda = false;
  }

  function restaurar() {
    guarda = true;
    var v = vista();
    var bs = nav.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var ativo = (v === 'temas' && bs[i].hasAttribute('data-modo-temas')) || (v === 'all' && bs[i].hasAttribute('data-mapa-completo'));
      if (ativo) bs[i].setAttribute('aria-current', 'page');
      else bs[i].removeAttribute('aria-current');
    }
    var c = document.getElementById('map-mode-count');
    if (c && c.dataset.mmTexto) c.textContent = c.dataset.mmTexto;
    nav.hidden = !(v === 'temas' || v === 'all');
    guarda = false;
  }

  function levantar() {
    if (nav.parentElement === document.body) return;
    ancora = { parent: nav.parentElement, next: nav.nextSibling };
    document.body.appendChild(nav);
  }

  function pousar() {
    if (!ancora) return;
    ancora.parent.insertBefore(nav, ancora.next);
    ancora = null;
  }

  function fechar() {
    fila = null;
    pousar();
    document.body.classList.remove('mapa-mundi-aberto', 'folha-aberta', 'folha-cheia', 'com-sel');
    var tela = document.getElementById('mapa-mundi-tela');
    if (tela) tela.hidden = true;
    restaurar();
  }

  function script(src) {
    return new Promise(function (ok, falha) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { ok(); };
      s.onerror = function () { falha(new Error(src)); };
      document.body.appendChild(s);
    });
  }

  function css(href) {
    return new Promise(function (ok) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = function () { ok(); };
      l.onerror = function () { ok(); };
      document.head.appendChild(l);
    });
  }

  function garantir() {
    if (promessa) return promessa;
    var raiz = base();
    promessa = css(raiz + 'mapa-mundi.css').then(function () {
      return script(raiz + 'vendor/d3-mapa.min.js');
    }).then(function () {
      return script(raiz + 'mapa-mundi.js');
    }).then(function () {
      return Promise.all([
        fetch(raiz + 'vendor/countries-110m.json').then(function (r) { return r.json(); }),
        fetch(raiz + 'dados-mundo.json').then(function (r) { return r.json(); })
      ]);
    }).then(function (par) {
      window.MapaMundi.mount({ world: par[0], dados: par[1] });
    });
    return promessa;
  }

  function entrar(iso) {
    var pedido = iso || '';
    fila = pedido;
    levantar();
    document.body.classList.add('mapa-mundi-aberto');
    marcar();
    return garantir().then(function () {
      if (fila !== pedido) return;
      if (!document.body.classList.contains('mapa-mundi-aberto')) return;
      window.MapaMundi.mostrar(pedido);
    });
  }

  function aoNavegar() {
    var iso = isoDe(location.hash);
    if (iso === null) {
      if (document.body.classList.contains('mapa-mundi-aberto')) fechar();
      return;
    }
    entrar(iso);
  }

  new MutationObserver(function () {
    if (!guarda) marcar();
  }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current', 'hidden'] });

  nav.addEventListener('click', function (ev) {
    if (passe) return;
    var b = ev.target.closest('button');
    if (!b || !nav.contains(b)) return;
    if (b.hasAttribute('data-mapa-mundi')) {
      ev.preventDefault();
      ev.stopPropagation();
      if (isoDe(location.hash) === '') return;
      history.pushState({ mm: '' }, '', location.pathname + location.search + '#mapa-mundi');
      entrar('');
      return;
    }
    if (!document.body.classList.contains('mapa-mundi-aberto')) return;
    if (!b.hasAttribute('data-modo-temas') && !b.hasAttribute('data-mapa-completo')) return;
    ev.preventDefault();
    ev.stopPropagation();
    var temas = b.hasAttribute('data-modo-temas');
    var v = vista();
    fechar();
    var noop = temas ? v === 'temas' : v === 'all';
    if (noop || !window.mural) {
      history.pushState(temas ? { ux6: 'lista' } : { ux6: 'mapa' }, '', location.pathname + location.search + (temas ? '' : '#all'));
      return;
    }
    passe = true;
    b.click();
    passe = false;
  }, true);

  window.addEventListener('hashchange', aoNavegar);
  window.addEventListener('popstate', aoNavegar);
  if (isoDe(location.hash) !== null) entrar(isoDe(location.hash));
})();
