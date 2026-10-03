"""Stage 3: automated QA gate.

A comment only reaches the correction letter if it passes every rule below.
Anything rejected goes to a human-review queue with the reasons attached, so a
weak comment is never silently sent to an applicant.
"""
from __future__ import annotations

import re

from .models import SEVERITIES, Finding
from .senior_audit import section_number
from .code_refs import is_known

ACTION_VERBS = ("Provide", "Revise", "Clarify", "Show", "Verify", "Coordinate", "Remove", "Add", "Specify")
HEDGES = ("maybe", "might", "possibly", "perhaps", "consider", "i think", "probably", "it seems")
# Plan reviewers cite requirements, not products. Brand or model references are
# a common failure mode for LLM drafts, so they are blocked outright.
PRODUCT_PATTERNS = (
    re.compile(r"[®™]"),
    re.compile(r"\bmodel\s+[A-Z0-9-]{2,}\b", re.IGNORECASE),
    re.compile(r"\b(Simpson|Hilti|USG|Kidde|Tyco|Viking|Hager|Schlage|Von Duprin|Allegion|Owens Corning)\b"),
)
QUANTITATIVE_CHECKS = {"EXITS-COUNT", "EXIT-SEP", "EGRESS-WIDTH", "STAIR-WIDTH", "TRAVEL", "CORRIDOR"}


def check(finding: Finding) -> list[str]:
    problems: list[str] = []
    text = finding.comment.strip()

    if finding.severity not in SEVERITIES:
        problems.append(f"severity '{finding.severity}' is not one of {SEVERITIES}")
    number = section_number(finding.section)
    if number is None:
        problems.append("missing code citation")
    elif not is_known(number) or "UNVERIFIED_CITATION" in finding.notes:
        problems.append(f"citation §{number} is not in the verified reference library")
    if not finding.sheet.strip():
        problems.append("missing sheet reference")
    if not text.startswith(ACTION_VERBS):
        problems.append("comment does not start with an action the applicant can take")
    if not 40 <= len(text) <= 400:
        problems.append(f"comment length {len(text)} outside 40-400 characters")
    lowered = text.lower()
    hedges = [h for h in HEDGES if h in lowered]
    if hedges:
        problems.append(f"hedging language: {', '.join(hedges)}")
    if any(p.search(text) for p in PRODUCT_PATTERNS):
        problems.append("names a product or model instead of a requirement")
    if finding.check_id in QUANTITATIVE_CHECKS and not re.search(r"\d", finding.evidence):
        problems.append("quantitative comment has no supporting numbers")
    return problems


def gate(findings: list[Finding]) -> tuple[list[Finding], list[tuple[Finding, list[str]]]]:
    accepted: list[Finding] = []
    rejected: list[tuple[Finding, list[str]]] = []
    for finding in findings:
        problems = check(finding)
        if problems:
            rejected.append((finding, problems))
        else:
            accepted.append(finding)
    return accepted, rejected
