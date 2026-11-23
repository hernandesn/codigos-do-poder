#!/usr/bin/env python3
"""Gera só app.html/vincular.html; nunca escreve index, config ou dados do atlas."""
import base64
import hashlib
import re
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
SITE = SCRIPTS.parent.parent
# index.html da raiz é a landing (#23); o app do atlas foi para mapa/index.html.
INDEX_SHA = '8e1182b0a26398143be78e2776e59133f045a3ad8d4a7f9feb4e1b979168b168'
# O atlas (app do mural com o grafo) é mapa/index.html, gerado pelo construir_site.py da pesquisa.
MAPA_SHA = '68681b197983985b0291877bfeb8aacca1c5d5b894be4867c8a0c9b5a67fc3f9'
TURNSTILE_STYLE_ATTR = "style-src-attr 'unsafe-hashes' 'sha256-HcrxrymsUfZBh2iqACpi+YzaRtmhmGlNKYCmyB23K2o='"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def public_origin():
    # Lê exclusivamente o host público; não copia chaves para novos arquivos.
    match = re.search(r'"supabaseUrl"\s*:\s*"(https://[a-z0-9]+\.supabase\.co)"', (SITE / 'config.js').read_text())
    if not match:
        raise ValueError('Host público do Supabase ausente.')
    return match[1]


def csp(html, origin, telegram):
    def hashes(tag):
        return ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(x.encode()).digest()).decode() + "'" for x in re.findall(fr'<{tag}>([\s\S]*?)</{tag}>', html))
    if telegram:
        script_extra = 'https://telegram.org/js/telegram-web-app.js '
        style_attr = "style-src-attr 'none'"
        frame = "frame-src 'none'"
    else:
        script_extra = 'https://challenges.cloudflare.com '
        style_attr = TURNSTILE_STYLE_ATTR
        frame = 'frame-src https://challenges.cloudflare.com'
    return '; '.join([
        "default-src 'self'", "script-src 'self' " + script_extra + hashes('script'),
        "style-src 'self' " + hashes('style'), style_attr, "connect-src 'self' " + origin,
        "img-src 'self' data:", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", frame,
    ]) + ';'


def render(page, origin=None):
    origin = origin or public_origin()
    css = (SCRIPTS / 'couro-osso.css').read_text() + '\n' + (SCRIPTS / 'telegram-pages.css').read_text()
    if page == 'app':
        css += '\n' + (SCRIPTS / 'telegram-app.css').read_text()
    js = (SCRIPTS / ('telegram-app.js' if page == 'app' else 'telegram-link.js')).read_text().replace('__SUPABASE_ORIGIN__', origin)
    slots = {'__CSS__': css, '__JS__': js}
    if page == 'vincular':
        slots['__AUTH_JS__'] = (SCRIPTS / 'site-chat.js').read_text()
        slots['__COPY_JS__'] = (SCRIPTS / 'copy-toast.js').read_text()
    html = (SCRIPTS / (page + '.template')).read_text()
    for slot in slots:
        if html.count(slot) != 1:
            raise ValueError('Slot ausente/repetido: ' + slot)
    html = re.sub('|'.join(map(re.escape, slots)), lambda m: slots[m[0]], html)
    return html.replace('__CSP__', csp(html, origin, page == 'app'), 1)


def build():
    protected = [SITE / 'index.html', SITE / 'mapa' / 'index.html', SITE / 'config.js', *sorted(SITE.glob('dados-*.json'))]
    before = {p: digest(p.read_bytes()) for p in protected}
    if before[SITE / 'index.html'] != INDEX_SHA or before[SITE / 'mapa' / 'index.html'] != MAPA_SHA:
        raise ValueError('Index diverge da base pública; geração recusada.')
    for page in ('app', 'vincular'):
        (SITE / (page + '.html')).write_bytes(render(page).encode())
    if any(digest(p.read_bytes()) != sha for p, sha in before.items()):
        raise ValueError('Artefato protegido mudou.')
    print('app.html e vincular.html gerados; index, config e dados byte-idênticos.')


if __name__ == '__main__':
    build()
