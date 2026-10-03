"""Stage 2: senior-reviewer audit.

Mirrors what a senior plans examiner does with a junior's draft: drop duplicate
comments, check every citation against the reference library, and calibrate
severity so life-safety items are never understated and paperwork items are
never overstated.
"""
from __future__ import annotations

import re

from .code_refs import is_known
from .models import SEVERITIES, Finding

LIFE_SAFETY_PREFIXES = ("903.", "1005.", "1006.", "1007.", "1017.")
DOCUMENTATION_SECTIONS = ("107.2.3", "1004.3")
SECTION_RE = re.compile(r"§\s*([0-9]+(?:\.[0-9]+)*)")


def section_number(citation: str) -> str | None:
    match = SECTION_RE.search(citation)
    return match.group(1) if match else None


def audit(findings: list[Finding]) -> tuple[list[Finding], list[str]]:
    log: list[str] = []
    by_key: dict[tuple[str, str], Finding] = {}

    for finding in findings:
        number = section_number(finding.section)
        if number is None or not is_known(number):
            finding.notes.append("UNVERIFIED_CITATION")
            log.append(f"{finding.check_id}: citation '{finding.section}' not in reference library")

        if number and number.startswith(LIFE_SAFETY_PREFIXES) and finding.severity != "Critical":
            log.append(f"{finding.check_id}: severity raised {finding.severity} -> Critical (life safety)")
            finding.severity = "Critical"
        if number in DOCUMENTATION_SECTIONS and finding.severity == "Critical":
            log.append(f"{finding.check_id}: severity lowered Critical -> Major (documentation item)")
            finding.severity = "Major"

        key = (number or finding.section, finding.sheet)
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = finding
            continue
        keep, drop = (existing, finding)
        if SEVERITIES.index(finding.severity) < SEVERITIES.index(existing.severity):
            keep, drop = finding, existing
        keep.notes.append(f"merged duplicate from {drop.source}")
        by_key[key] = keep
        log.append(f"{drop.check_id} ({drop.source}): merged into {keep.check_id} ({keep.source})")

    ordered = sorted(by_key.values(), key=lambda f: (SEVERITIES.index(f.severity) if f.severity in SEVERITIES else 99, f.check_id))
    return ordered, log
