"""Lookup of common, real section numbers by code family (numbers and titles only, no code text).

Used in document mode: a citation that matches the index is marked INDEXED; anything else
is flagged VERIFY_CITATION for the reviewer. The index does not prove the section says what
the comment claims, only that the number is a real, commonly cited section in that code.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

INDEX = {k: v for k, v in json.loads((Path(__file__).with_name("section_index.json")).read_text(encoding="utf-8")).items()
         if not k.startswith("_")}

FAMILIES = [
    ("statute", re.compile(r"Business and Professions|B&P|Government Code|Gov\.? Code", re.I)),
    ("calgreen", re.compile(r"CALGreen|Green Building", re.I)),
    ("energy", re.compile(r"Energy Code|Part 6", re.I)),
    ("plumbing", re.compile(r"\bCPC\b|Plumbing Code", re.I)),
    ("mechanical", re.compile(r"\bCMC\b|Mechanical Code", re.I)),
    ("electrical", re.compile(r"\bCEC\b|Electrical Code|\bNEC\b", re.I)),
    ("residential", re.compile(r"\bCRC\b|\bIRC\b|Residential", re.I)),
    ("building", re.compile(r"\bCBC\b|\bIBC\b|Building Code|FBC", re.I)),
]


def lookup(citation: str) -> tuple[str, str] | None:
    """Return (section, title) when the citation matches a known section, else None."""
    for family, pattern in FAMILIES:
        if not pattern.search(citation):
            continue
        for section in sorted(INDEX[family], key=len, reverse=True):
            if re.search(r"(?:§|Article |Section |Table )\s*" + re.escape(section) + r"(?![0-9.])", citation):
                return section, INDEX[family][section]
        return None
    return None
