#!/usr/bin/env python3
"""Generate an offline, idempotent dataset sync; never connect to a database.

Uses the original importer's conversions and column mapping. Only cases referenced
by relationships are included, to satisfy relationships.case_id. Other optional
tables are outside this sync's scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from migrate_json_to_postgres import (
    decimal_value,
    evidence_id,
    extras,
    first_year,
    iso_date,
    normalized_name,
    period_bounds,
    refs,
    sql_value,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "dados/base-investigativa.json"
DEFAULT_OUTPUT = ROOT / "database/sync/006_sync_atlas_dataset.sql"
SCHEMA = ROOT / "database/migrations/001_initial_knowledge_graph.sql"


@dataclass
class TableRows:
    name: str
    primary_key: str
    columns: list[str]
    rows: list[tuple[Any, ...]]


def audit(data: dict[str, Any]) -> None:
    """Validate the input used by this sync without requiring unrelated datasets."""
    ids: dict[str, set[str]] = {}
    for collection in ("nos", "fontes", "conexoes", "casos"):
        rows = data.get(collection)
        if not isinstance(rows, list):
            raise ValueError(f"Coleção ausente ou inválida: {collection}")
        ids[collection] = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
                raise ValueError(f"Registro sem id válido em {collection}")
            if row["id"] in ids[collection]:
                raise ValueError(f"ID duplicado em {collection}: {row['id']}")
            ids[collection].add(row["id"])

    for collection, field in (("nos", "nome"), ("fontes", "titulo")):
        for row in data[collection]:
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f"{row['id']}: {field} vazio ou inválido")

    for row in data["conexoes"]:
        if row.get("origem") not in ids["nos"] or row.get("destino") not in ids["nos"]:
            raise ValueError(f"{row['id']}: entidade ausente")
        source_ids = refs(row)
        if not source_ids or len(source_ids) != len(set(source_ids)):
            raise ValueError(f"{row['id']}: fontes vazias ou repetidas")
        if set(source_ids) - ids["fontes"]:
            raise ValueError(f"{row['id']}: fonte ausente")
        if row.get("caso_id") is not None and row["caso_id"] not in ids["casos"]:
            raise ValueError(f"{row['id']}: caso ausente")
        if not 1 <= int(row.get("intensidade", 0)) <= 5:
            raise ValueError(f"{row['id']}: intensidade fora de 1–5")
        capital_pct = decimal_value(row.get("capital_pct"), f"{row['id']}.capital_pct")
        if capital_pct is not None and not 0 <= capital_pct <= 100:
            raise ValueError(f"{row['id']}: capital_pct fora de 0–100")

    needed_cases = {row.get("caso_id") for row in data["conexoes"]}
    for row in data["casos"]:
        if row["id"] in needed_cases and row.get("no_mural") is not None and row["no_mural"] not in ids["nos"]:
            raise ValueError(f"{row['id']}: entidade no_mural ausente")


def make_tables(data: dict[str, Any]) -> list[TableRows]:
    """Map exactly the same dataset fields as the original importer."""
    tables: list[TableRows] = []

    url_counts = Counter((row.get("url") or "").strip() for row in data["fontes"])
    source_known = {
        "id", "titulo", "editor", "autor", "url", "tipo", "publicado_em", "consultado_em",
        "localizador", "acesso", "arquivo_local", "sha256", "sha256_fonte_original",
    }
    source_rows = []
    for row in data["fontes"]:
        url = (row.get("url") or "").strip()
        url_key = "url:" + hashlib.sha256(url.encode("utf-8")).hexdigest() if url else None
        assessment = "duplicate_url" if url_counts[url] > 1 else "unreviewed"
        source_rows.append((
            row["id"], row["titulo"], url, row.get("autor"), row.get("editor"), row.get("tipo"),
            iso_date(row.get("publicado_em")), first_year(row.get("publicado_em")),
            row.get("publicado_em"), iso_date(row.get("consultado_em")), row.get("localizador"),
            row.get("acesso"), row.get("arquivo_local"), row.get("sha256"),
            row.get("sha256_fonte_original"), url_key, assessment, extras(row, source_known),
        ))
    tables.append(TableRows("sources", "source_id", (
        "source_id title source_url author publisher source_type published_on published_year "
        "published_at_raw accessed_on passage_locator access_note local_file_path sha256 "
        "original_sha256 independence_key independence_assessment metadata"
    ).split(), source_rows))

    entity_rows = [(
        row["id"], row["nome"], normalized_name(row["nome"]), row["tipo"], row.get("nucleo"),
        row.get("nota") or None, extras(row, {"id", "nome", "tipo", "nucleo", "nota"}),
    ) for row in data["nos"]]
    tables.append(TableRows("entities", "entity_id", (
        "entity_id canonical_name normalized_name entity_type research_cluster note metadata"
    ).split(), entity_rows))

    # This is the only additional table needed by the four core tables' FKs.
    needed_cases = {row.get("caso_id") for row in data["conexoes"]}
    case_known = {
        "id", "titulo", "periodo", "esfera", "atores", "mecanismo", "decisao_pretendida",
        "resultado", "beneficiarios", "explicacoes_concorrentes", "conclusao", "limites",
        "documentos_faltantes", "fontes", "no_mural", "recorte", "conexoes", "entidades_mural",
    }
    case_rows = [(
        row["id"], row["titulo"], row.get("periodo"), row.get("esfera"), row.get("atores") or [],
        row.get("mecanismo"), row.get("decisao_pretendida"), row.get("resultado"),
        row.get("beneficiarios") or [], row.get("explicacoes_concorrentes") or [],
        row.get("conclusao"), row.get("limites") or [], row.get("documentos_faltantes") or [],
        row.get("no_mural"), extras(row, case_known),
    ) for row in data["casos"] if row["id"] in needed_cases]
    tables.append(TableRows("investigation_cases", "case_id", (
        "case_id title period_label sphere actors mechanism intended_decision outcome beneficiaries "
        "competing_explanations conclusion limitations missing_documents map_entity_id metadata"
    ).split(), case_rows))

    relation_known = {
        "id", "origem", "destino", "tipo", "intensidade", "periodo", "afirmacao", "fontes",
        "limite", "estado", "data_referencia", "inicio", "fim", "confianca", "nota", "caso_id",
        "recorte_pesquisa", "valor", "moeda", "valor_bruto_positivo", "ajustes_negativos",
        "destinatario_fec", "natureza_valor", "capital_pct",
    }
    state_map = {
        "historico": "source_linked_claim", "retrato_documental": "source_linked_claim",
        "identificacao": "identification", "rascunho": "hypothesis", "anunciado": "announced",
    }
    relation_rows = []
    for row in data["conexoes"]:
        p_start, p_end = period_bounds(row.get("periodo"))
        relation_rows.append((
            row["id"], row["origem"], row["destino"], row["tipo"], int(row["intensidade"]),
            row.get("periodo"), p_start, p_end, iso_date(row.get("inicio")),
            first_year(row.get("inicio")), row.get("inicio"), iso_date(row.get("fim")),
            first_year(row.get("fim")), row.get("fim"), row.get("afirmacao", ""),
            row.get("limite"), row.get("estado", ""), state_map.get(row.get("estado"), "needs_review"),
            row.get("confianca"), iso_date(row.get("data_referencia")),
            first_year(row.get("data_referencia")), row.get("data_referencia"), row.get("caso_id"),
            row.get("recorte_pesquisa"), decimal_value(row.get("valor"), f"{row['id']}.valor"),
            row.get("moeda"), decimal_value(row.get("valor_bruto_positivo"), f"{row['id']}.valor_bruto_positivo"),
            decimal_value(row.get("ajustes_negativos"), f"{row['id']}.ajustes_negativos"),
            row.get("natureza_valor"), decimal_value(row.get("capital_pct"), f"{row['id']}.capital_pct"),
            row.get("destinatario_fec"), extras(row, relation_known),
        ))
    tables.append(TableRows("relationships", "relationship_id", (
        "relationship_id source_entity_id target_entity_id relation_type weight period_label "
        "period_start_year period_end_year start_on start_year start_raw end_on end_year end_raw "
        "assertion limitation review_status epistemic_status confidence reference_on reference_year "
        "reference_raw case_id research_scope amount currency gross_positive_amount "
        "negative_adjustments amount_nature capital_pct fec_recipient_id metadata"
    ).split(), relation_rows))

    source_by_id = {row["id"]: row for row in data["fontes"]}
    evidence_rows = []
    for row in data["conexoes"]:
        for source_id in refs(row):
            source = source_by_id[source_id]
            url_key = "url:" + hashlib.sha256((source.get("url") or "").strip().encode("utf-8")).hexdigest()
            locator = row.get("localizadores_fontes", {}).get(source_id, source.get("localizador"))
            if isinstance(locator, list):
                locator = "\n".join(locator)
            metadata = {"legacy_access_note": source.get("acesso")}
            referencia = row.get("acesso_fontes", {}).get(source_id)
            if referencia:
                metadata["acesso_referencia"] = referencia
            evidence_rows.append((
                evidence_id(row["id"], source_id), row["id"], source_id, "citation_reference",
                locator, row.get("afirmacao"), "legacy_relationship_claim", None, url_key,
                "Imported citation locator; no passage-level verification is implied.", None, metadata,
            ))
    tables.append(TableRows("evidence", "evidence_id", (
        "evidence_id relationship_id source_id evidence_level passage_locator summary summary_basis "
        "excerpt_text independence_key verification_note verified_at metadata"
    ).split(), evidence_rows))
    return tables


def verify_columns(tables: list[TableRows]) -> None:
    """Fail if a mapped column list or PK differs from the checked-in schema.

    Migrations 002–005 do not change these tables' column layouts. Database-owned
    timestamps are deliberately omitted from inserts and conflict updates.
    """
    schema = SCHEMA.read_text(encoding="utf-8")
    for table in tables:
        match = re.search(
            rf"^CREATE TABLE IF NOT EXISTS {table.name} \(\n(.*?)^\);", schema, re.M | re.S,
        )
        if match is None:
            raise ValueError(f"Tabela ausente na migration 001: {table.name}")
        body = match.group(1)
        columns = re.findall(r"^  ([a-z_][a-z_0-9]*)\s+", body, re.M)
        columns = [column for column in columns if column not in {"created_at", "updated_at"}]
        primary_key = re.findall(r"^  ([a-z_][a-z_0-9]*)\s+[^\n]*\bPRIMARY KEY\b", body, re.M)
        if table.columns != columns or primary_key != [table.primary_key]:
            raise ValueError(f"Colunas/PK divergentes da migration 001: {table.name}")


def upsert_sql(table: TableRows) -> str:
    """Stable batches with an explicit PK conflict target; no volatile updates."""
    rows = sorted(table.rows, key=lambda row: row[table.columns.index(table.primary_key)])
    keys = [row[table.columns.index(table.primary_key)] for row in rows]
    if len(keys) != len(set(keys)) or any(len(row) != len(table.columns) for row in rows):
        raise ValueError(f"Linhas/PKs inválidas: {table.name}")
    updates = ",\n  ".join(
        f"{column} = EXCLUDED.{column}" for column in table.columns if column != table.primary_key
    )
    statements = []
    for offset in range(0, len(rows), 100):
        values = ",\n".join(
            "(" + ", ".join(sql_value(value) for value in row) + ")"
            for row in rows[offset:offset + 100]
        )
        if "\0" in values:
            raise ValueError(f"Caractere NUL inválido para PostgreSQL: {table.name}")
        statements.append(
            f"INSERT INTO {table.name} ({', '.join(table.columns)}) VALUES\n{values}\n"
            f"ON CONFLICT ({table.primary_key}) DO UPDATE SET\n  {updates};\n"
        )
    return "\n".join(statements)


def generate(data: dict[str, Any], digest: str) -> tuple[str, dict[str, int]]:
    audit(data)
    tables = make_tables(data)
    verify_columns(tables)
    counts = {table.name: len(table.rows) for table in tables}
    header = (
        "-- Generated by scripts/gerar_sync_atlas.py; generate only, not executed.\n"
        f"-- Expected final counts: entities {counts['entities']}, "
        f"relationships {counts['relationships']}, sources {counts['sources']}.\n"
        f"-- Dataset evidence rows: {counts['evidence']}; required cases: {counts['investigation_cases']}.\n"
        "-- Counts describe the dataset; existing extra database rows are retained.\n"
        f"-- Input SHA-256: {digest}\n"
        "-- Order: sources, entities, required investigation_cases, relationships, evidence.\n"
        "-- Existing PKs receive dataset values in every listed non-PK column.\n"
        "-- Evidence remains citation_reference, without passage-level verification.\n"
        "-- Database timestamps are preserved; transaction control belongs to the caller.\n"
        "-- Uses PostgreSQL's default standard_conforming_strings = on, as the original importer.\n\n"
    )
    return header + "\n".join(upsert_sql(table) for table in tables), counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Formato JSON inesperado na base")
    sql, counts = generate(data, hashlib.sha256(raw).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(sql, encoding="utf-8")
    print(f"SQL gerado (não executado): {args.output}")
    print("Contagens esperadas: " + ", ".join(f"{table}={count}" for table, count in counts.items()))


if __name__ == "__main__":
    main()
