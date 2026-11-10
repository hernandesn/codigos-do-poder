#!/usr/bin/env python3
"""Árvore única: gerar_sync_atlas.py e run_pglite.mjs acham pesquisa/ sozinhos.

Roda offline. Gera o SQL de sincronização com os caminhos padrão a partir de um
diretório de execução qualquer e, se @electric-sql/pglite estiver resolvível a
partir de site/supabase/tests/, aplica-o com run_pglite.mjs sem ATLAS_SYNC_SQL.
Nenhum teste lê segredos nem conecta a banco real.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
SITE = TESTS.parents[1]
REPO = SITE.parent
GERADOR = SITE / "supabase/scripts/gerar_sync_atlas.py"
RUNNER = TESTS / "run_pglite.mjs"
BASE = REPO / "pesquisa/dados/base-investigativa.json"
SAIDA_PADRAO = REPO / "pesquisa/database/sync/006_sync_atlas_dataset.sql"


def carregar_gerador():
    spec = importlib.util.spec_from_file_location("gerar_sync_atlas_layout", GERADOR)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # dataclasses precisa do módulo registrado
    spec.loader.exec_module(mod)
    return mod


def pglite_disponivel() -> bool:
    if not shutil.which("node"):
        return False
    proc = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import.meta.resolve('@electric-sql/pglite')"],
        cwd=TESTS, capture_output=True, text=True,
    )
    return proc.returncode == 0


class LayoutArvoreUnica(unittest.TestCase):
    def test_caminhos_padrao_do_gerador_apontam_para_pesquisa(self):
        mod = carregar_gerador()
        self.assertEqual(mod.REPO_ROOT, REPO)
        self.assertEqual(mod.DEFAULT_INPUT, BASE)
        self.assertTrue(mod.DEFAULT_INPUT.is_file())
        self.assertTrue(mod.SCHEMA.is_file())
        self.assertEqual(mod.DEFAULT_OUTPUT, SAIDA_PADRAO)
        # O esquema que o gerador confere é o mesmo aplicado no Supabase.
        self.assertEqual(mod.SCHEMA.read_bytes(),
                         (SITE / "supabase/migrations/001_initial_knowledge_graph.sql").read_bytes())

    def test_runner_usa_o_mesmo_caminho_padrao(self):
        src = RUNNER.read_text(encoding="utf-8")
        m = re.search(r"DEFAULT_SYNC_SQL = new URL\('([^']+)', repoRoot\)", src)
        self.assertIsNotNone(m)
        self.assertEqual(REPO / m.group(1), SAIDA_PADRAO)
        self.assertIn("new URL('../../../', import.meta.url)", src)
        self.assertNotIn("'dados/006_sync_atlas_dataset.sql'", src)

    def test_gera_de_qualquer_cwd_e_aplica_no_pglite(self):
        raw = BASE.read_bytes()
        base = json.loads(raw)
        with tempfile.TemporaryDirectory() as tmp:
            saida = Path(tmp) / "006.sql"
            proc = subprocess.run(
                [sys.executable, str(GERADOR), "--output", str(saida)],
                cwd=tmp, capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            sql = saida.read_text(encoding="utf-8")
            self.assertIn(f"-- Input SHA-256: {hashlib.sha256(raw).hexdigest()}", sql)
            self.assertIn(
                f"entities {len(base['nos'])}, relationships {len(base['conexoes'])}, "
                f"sources {len(base['fontes'])}.", sql)
            # Determinístico: segunda geração byte-idêntica.
            saida2 = Path(tmp) / "006b.sql"
            subprocess.run([sys.executable, str(GERADOR), "--output", str(saida2)],
                           cwd=tmp, check=True, capture_output=True)
            self.assertEqual(saida.read_bytes(), saida2.read_bytes())

            if not pglite_disponivel():
                self.skipTest("@electric-sql/pglite não resolvível a partir de site/supabase/tests")
            # Sem ATLAS_SYNC_SQL: o runner tem de achar o caminho padrão sozinho.
            SAIDA_PADRAO.parent.mkdir(parents=True, exist_ok=True)
            existia = SAIDA_PADRAO.exists()
            antigo = SAIDA_PADRAO.read_bytes() if existia else None
            try:
                shutil.copyfile(saida, SAIDA_PADRAO)
                env = {k: v for k, v in os.environ.items() if k != "ATLAS_SYNC_SQL"}
                run = subprocess.run(["node", str(RUNNER)], cwd=tmp, env=env,
                                     capture_output=True, text=True, timeout=600)
            finally:
                if existia:
                    SAIDA_PADRAO.write_bytes(antigo)
                else:
                    SAIDA_PADRAO.unlink()
                    try:
                        SAIDA_PADRAO.parent.rmdir()
                    except OSError:
                        pass
            self.assertEqual(run.returncode, 0, (run.stdout + run.stderr)[-3000:])
            self.assertIn("APPLY 006_sync_atlas_dataset.sql", run.stdout)
            self.assertIn("PGlite: 2 SQL suites passed, 0 failed", run.stdout)


if __name__ == "__main__":
    unittest.main()
