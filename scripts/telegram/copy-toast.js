/* Cópia com um único toast. Texto só por textContent. Posição só por classe (CSP: sem atributo style). */
(function (root) {
  'use strict';
  const TOAST_MS = 2000;
  const ANNOUNCE_MS = 50;
  let toastEl = null;
  let hideTimer = 0;
  let announceTimer = 0;

  function mountToast() {
    if (toastEl || !document.body) return toastEl;
    const el = document.createElement('div');
    el.className = 'copy-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
    toastEl = el;
    return el;
  }

  if (document.body) mountToast();
  else document.addEventListener('DOMContentLoaded', mountToast);

  function showToast(msg) {
    const el = mountToast();
    const text = msg == null ? '' : String(msg);
    clearTimeout(announceTimer);
    clearTimeout(hideTimer);
    el.textContent = '';
    el.classList.add('is-visible');
    hideTimer = setTimeout(() => { el.classList.remove('is-visible'); }, TOAST_MS);
    announceTimer = setTimeout(() => { el.textContent = text; }, ANNOUNCE_MS);
  }

  function selectElement(selectEl) {
    if (!selectEl) return;
    if (selectEl.classList && typeof selectEl.classList.add === 'function') selectEl.classList.add('copy-select-all');
    try {
      const range = document.createRange();
      range.selectNodeContents(selectEl);
      const selection = root.getSelection && root.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
    } catch { /* o CSS user-select: all deixa o código selecionável */ }
  }

  function fallbackCopy(text) {
    if (typeof document.execCommand !== 'function') return false;
    const area = document.createElement('textarea');
    area.className = 'copy-fallback';
    area.readOnly = true;
    area.value = text;
    const previous = document.activeElement || null;
    document.body.appendChild(area);
    try {
      if (typeof area.focus === 'function') area.focus();
      if (typeof area.select === 'function') area.select();
      return document.execCommand('copy') === true;
    } finally {
      area.remove();
      if (previous && previous !== area && typeof previous.focus === 'function') {
        try { previous.focus(); } catch { /* o botão de copiar continua utilizável */ }
      }
    }
  }

  async function copyText(text, selectEl) {
    const value = text == null ? '' : String(text);
    let copied = false;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (root.isSecureContext === true && clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(value);
        copied = true;
      } catch { copied = false; }
    }
    if (!copied) {
      try { copied = fallbackCopy(value) === true; }
      catch { copied = false; }
    }
    if (copied) {
      showToast('Copiado!');
      return true;
    }
    selectElement(selectEl);
    showToast('Não deu para copiar, selecione o código');
    return false;
  }

  root.copyText = copyText;
  root.showToast = showToast;
})(window);
