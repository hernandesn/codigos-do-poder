// Links antigos do app na raiz vão para /mapa/, com a mesma query e o mesmo hash.
// Qualquer hash não vazio redireciona, inclusive âncoras da landing num carregamento direto.
(function () {
  var hash = location.hash || '';
  var search = location.search || '';
  var params;
  try { params = new URLSearchParams(search); }
  catch (e) { params = new URLSearchParams(); }
  var appQuery = params.get('editor') === '1' || params.get('debug') === '1' || params.has('access_token');
  var appHash = hash.length > 1;
  if (!appHash && !appQuery) return;
  document.documentElement.classList.add('redir-app');
  location.replace('/mapa/' + search + hash);
})();
