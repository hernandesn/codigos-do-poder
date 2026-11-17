// Links antigos do app na raiz vão para /mapa/, com a mesma query e o mesmo hash.
// Hash vazio ('') ou '#' fica na raiz. Hash cujo id existe na landing também fica:
// o navegador rola até a seção. A lista sai de index.html (scripts/gerar-ancoras-landing.mjs).
// O script roda no <head>, antes do body, e decide na hora. Âncora da landing não
// ganha a classe que esconde o body. Query do app redireciona mesmo com âncora.
(function () {
  var hash = location.hash || '';
  var search = location.search || '';
  var params;
  try { params = new URLSearchParams(search); }
  catch (e) { params = new URLSearchParams(); }
  var appQuery = params.get('editor') === '1' || params.get('debug') === '1' || params.has('access_token');
  var id = '';
  if (hash.length > 1) {
    try { id = decodeURIComponent(hash.slice(1)); }
    catch (e2) { id = hash.slice(1); }
  }
  // ANCORAS-LANDING:inicio
  var ancoras = ["hero-t","base","base-t","exemplos","ex-t","perc-t","como","como-t","planos","pl-t","faq","faq-t","comecar","fin-t"];
  // ANCORAS-LANDING:fim
  var hashVazio = hash === '' || hash === '#';
  var ancoraDaLanding = !hashVazio && ancoras.indexOf(id) !== -1;
  if (!appQuery && (hashVazio || ancoraDaLanding)) return;
  document.documentElement.classList.add('redir-app');
  location.replace('/mapa/' + search + hash);
})();
