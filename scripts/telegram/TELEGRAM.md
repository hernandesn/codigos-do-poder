# Páginas Telegram — geração separada do atlas

`scripts/telegram/gerar_app_html.py` lê o host público de `config.js`, o tema couro-osso extraído do mini app de 11/11 e o cliente de login copiado do app do atlas (hoje `mapa/index.html`; a raiz `index.html` é a landing). Escreve somente `app.html` e `vincular.html` na raiz do clone. Confere o SHA-256 da landing (`index.html`) e do atlas (`mapa/index.html`) antes da geração e o deles, `config.js` e `dados-*.json` depois. Não altera o mapa, o bundle da página principal nem os dados.

```sh
python3 scripts/telegram/gerar_app_html.py
cd scripts/telegram && python3 -m unittest test_telegram_pages.py
node --test tests/telegram_link_node_test.cjs
```

`app.html` referencia o SDK oficial `https://telegram.org/js/telegram-web-app.js` no head, antes dos scripts próprios. A CSP libera só esse caminho, não a origem inteira `https://telegram.org`. Fora do Telegram, a página orienta abrir @aion_codigosdopoder_bot. Não usa `initDataUnsafe` nem envia ids de usuário: o backend valida o initData e resolve o vínculo. A troca inicial de initData por prova de sessão fica só em memória; cada pergunta usa `Authorization: tma` e a prova. Rebind exige reabrir o mini app.

`vincular.html` incorpora a cópia do cliente de login já existente (`site-chat.js`), extraída do index atual. O `boot()` desse cliente só monta o chat se existir `#chat-panel`, então a cópia não abre o mural aqui. O widget Turnstile só é montado quando `parsePublicConfig` existe e `turnstileSiteKey` vem preenchida. Sem site key, o login continua `{email, password}`. O logout explícito espera uma emissão em voo, envia `{revogar:true}` e só sai da conta se o HTTP estiver ok e o corpo trouxer `{revogado:true}`. Se a revogação falhar, a conta continua conectada e o erro aparece na página. O botão de sair permanece desabilitado durante a emissão. `pagehide` só apaga o código da tela e não revoga. A CSP desta página libera `https://challenges.cloudflare.com` em `script-src` e `frame-src`, e o mesmo `style-src-attr` do index. `connect-src` continua restrito a `'self'` e ao host Supabase.

Cada página tem CSP própria com hashes dos bytes exatos dos scripts e estilos inline. Não há `unsafe-inline`, `unsafe-eval` nem handlers inline. Respostas e fontes entram por `textContent`.

O teste de navegador fica escrito e não roda sem o pacote e o Chromium já presentes. Sem `PLAYWRIGHT_PATH`, `node --test tests/` ignora esse arquivo. Comando para a box:

```sh
PLAYWRIGHT_PATH=<pacote-local>/playwright node --test tests/telegram_app_test.cjs
```

Os prints vão para `prints/` na raiz do job (`../prints` a partir deste clone), com nomes `telegram-{desktop|celular}-*.png`. O teste serve só app, vincular, config sintético e fontes; intercepta o SDK e o backend. O initData de teste é assinado com token falso. Nenhuma chamada a `api.telegram.org`.

Publicação futura: o PR do site leva as páginas, o gerador, os testes e os arquivos novos em `supabase/` (funções, migração 013 e teste SQL). Não leva a 012 nem substitui `chat_core.ts`. Index e dados permanecem byte-idênticos. Nenhum publish/deploy foi feito.
