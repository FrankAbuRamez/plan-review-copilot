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

LIFE_SAFETY_PREFIXES = ("903.", "1005.", "1006.", "1007.", "1017.",
                        "R302.", "R310.", "R311.", "R313.", "R314.", "R315.")  # residential code life safety
DOCUMENTATION_SECTIONS = ("107.2.3", "1004.3")
# Accepts IBC-style (1005.3.2), CBC-style (11B-404.2.3) and IRC/CRC-style (R302.1, N1102.1) section numbers.
# Also accepts "Article 220", "Chapter 7", "Table R602.3(1)" and "Section 1005.3" written without the § sign.
SECTION_RE = re.compile(r"(?:§|\b(?:Section|Article|Chapter|Table)\s)\s*([A-Z]{0,2}[0-9]+[A-Z]?(?:[.-][0-9]+[A-Z]?)*)")


def section_number(citation: str) -> str | None:
    match = SECTION_RE.search(citation)
    return match.group(1) if match else None


def audit(findings: list[Finding], strict: bool = True) -> tuple[list[Finding], list[str]]:
    """strict=True: citations must be in the verified library (synthetic projects).
    strict=False: real documents cite the full code, so unknown sections are flagged
    for the reviewer to verify instead of being blocked."""
    log: list[str] = []
    by_key: dict[tuple[str, str], Finding] = {}

    for finding in findings:
        number = section_number(finding.section)
        if number is None or (strict and not is_known(number)):
            finding.notes.append("UNVERIFIED_CITATION")
            log.append(f"{finding.check_id}: citation '{finding.section}' not in reference library")
        elif not is_known(number):
            finding.notes.append("VERIFY_CITATION")

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
