import base64
import hashlib
import re
import unittest
from gerar_app_html import INDEX_SHA, MAPA_SHA, SITE, TURNSTILE_STYLE_ATTR, csp, public_origin, render


class TelegramPagesTest(unittest.TestCase):
    def test_artefatos_protegidos_byte_identicos(self):
        expected = {
            'index.html': INDEX_SHA,
            'mapa/index.html': MAPA_SHA,
            'dados-extensao.json': '655697537aa5362515849b7c91b39ceaa1e842ad880522f818d9da72cdbfd2c0',
            'dados-nucleo.json': '2a647c72025c3f45a1ba28cc39ffb9d2358c924fa5aade62498aef82bc5efdf5',
            'config.js': 'e80fe3275cabe130387a5f2fc96023f0337c6104d13259418861314bb61c65af',
        }
        for name, sha in expected.items():
            self.assertEqual(hashlib.sha256((SITE / name).read_bytes()).hexdigest(), sha)

    def test_geracao_deterministica_e_csp_exata(self):
        for name in ('app', 'vincular'):
            html = render(name)
            self.assertEqual((SITE / (name + '.html')).read_bytes(), html.encode())
            policy = re.search(r'Content-Security-Policy" content="([^"]+)"', html)[1]
            self.assertNotIn("'unsafe-inline'", policy)
            self.assertNotIn("'unsafe-eval'", policy)
            for tag in ('style', 'script'):
                for text in re.findall(fr'<{tag}>([\s\S]*?)</{tag}>', html):
                    hashed = base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()
                    self.assertIn("'sha256-" + hashed + "'", policy)
            self.assertIn("connect-src 'self' " + public_origin() + ';', policy)
            self.assertEqual(policy, csp(html, public_origin(), name == 'app'))
            self.assertNotRegex(html, r'\son(?:click|submit|load|error)=')
            self.assertNotRegex(html, r'\sstyle=')

    def test_sdk_so_no_app_no_caminho_oficial(self):
        html = render('app')
        sdk = '<script src="https://telegram.org/js/telegram-web-app.js"></script>'
        policy = re.search(r'Content-Security-Policy" content="([^"]+)"', html)[1]
        self.assertEqual(html.count(sdk), 1)
        self.assertLess(html.index(sdk), html.index('</head>'))
        self.assertLess(html.index(sdk), html.index('src="config.js"'))
        self.assertIn('https://telegram.org/js/telegram-web-app.js ', policy)
        self.assertNotIn('https://telegram.org ', policy)
        self.assertNotIn('challenges.cloudflare.com', policy)
        vincular = render('vincular')
        self.assertNotIn('https://telegram.org', vincular)
        self.assertNotIn('https://telegram.org', (SITE / 'index.html').read_text())
        self.assertNotIn('https://telegram.org', (SITE / 'mapa' / 'index.html').read_text())
        vpolicy = re.search(r'Content-Security-Policy" content="([^"]+)"', vincular)[1]
        self.assertIn('https://challenges.cloudflare.com ', vpolicy)
        self.assertIn('frame-src https://challenges.cloudflare.com', vpolicy)
        self.assertIn(TURNSTILE_STYLE_ATTR, vpolicy)

    def test_identidade_nao_vem_do_cliente_e_login_reutilizado(self):
        app = render('app')
        self.assertIn("authorization: 'tma ' + initData", app)
        self.assertNotIn('initDataUnsafe', app)
        self.assertNotIn('user_id:', app)
        self.assertIn('x-telegram-app-session', app)
        link = render('vincular')
        self.assertIn('root.atlasAuthChat = api', link)
        self.assertIn('createClient({ config })', link)
        self.assertIn('client.login(', link)
        self.assertIn('client.refresh()', link)
        self.assertIn('parsePublicConfig', link)
        self.assertIn('turnstileSiteKey', link)
        self.assertIn('revogar: true', link)
        self.assertIn("window.addEventListener('pagehide', invalidateGeneration)", link)
        self.assertNotIn('pagehide', link.split("window.addEventListener('pagehide', invalidateGeneration)", 1)[1])
        self.assertIn('id="auth-turnstile"', link)

    def test_toast_de_copia_no_html_gerado(self):
        component = (SITE / 'scripts/telegram/copy-toast.js').read_text()
        self.assertIn("setAttribute('role', 'status')", component)
        self.assertIn("setAttribute('aria-live', 'polite')", component)
        self.assertIn("setAttribute('aria-atomic', 'true')", component)
        self.assertIn('textContent', component)
        self.assertIn('Copiado!', component)
        self.assertIn('Não deu para copiar, selecione o código', component)
        self.assertNotIn('innerHTML', component)
        self.assertNotRegex(component, r'\sstyle=')
        link = render('vincular')
        self.assertIn(component, link)
        self.assertIn('role="status"', link)
        self.assertIn("setAttribute('role', 'status')", link)
        self.assertIn('window.copyText(', link)
        self.assertNotIn('Comando copiado.', link)
        self.assertNotIn('innerHTML', component)
        app = render('app')
        self.assertNotIn('window.copyText(', app)
        self.assertIn('.copy-toast', app)

    def test_indicador_de_pesquisa_e_vinculo_ja_feito(self):
        app = render('app')
        source = (SITE / 'scripts/telegram/telegram-app.js').read_text()
        self.assertIn('id="pending"', app)
        self.assertIn('id="account-link"', app)
        self.assertIn('Pesquisando…', source)
        self.assertIn('Searching…', source)
        self.assertIn('Investigando…', source)
        self.assertIn("setAttribute('aria-busy', 'true')", source)
        self.assertIn('clearTimeout(pendingTimer)', source)
        self.assertIn("$('account-link').hidden = true", source)
        self.assertIn('language_code', source)
        self.assertNotIn('initDataUnsafe', source)
        self.assertNotIn('CloudStorage', source)
        self.assertIn('pending-pulse', app)
        self.assertNotIn('id="pending"', render('vincular'))


if __name__ == '__main__':
    unittest.main()
