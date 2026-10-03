"""Optional stage 1 reviewer powered by Claude.

The model drafts findings as structured JSON, restricted to the sections in the
reference library. Its output then goes through the same senior audit and QA
gate as the rule-based reviewer, so a fluent but wrong comment is caught the
same way a junior reviewer's would be.

Requires `pip install anthropic` and an ANTHROPIC_API_KEY (or `ant auth login`).
"""
from __future__ import annotations

import json

from .code_refs import CODE_EDITION, SECTIONS
from .models import Finding

MODEL = "claude-opus-5-5"

FINDINGS_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "check_id": {"type": "string"},
                    "discipline": {"type": "string", "enum": ["Building", "Fire", "Accessibility"]},
                    "severity": {"type": "string", "enum": ["Critical", "Major", "Minor"]},
                    "sheet": {"type": "string"},
                    "section": {"type": "string"},
                    "comment": {"type": "string"},
                    "evidence": {"type": "string"},
                },
                "required": ["check_id", "discipline", "severity", "sheet", "section", "comment", "evidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["findings"],
    "additionalProperties": False,
}

SYSTEM = f"""You are a first-pass plans examiner drafting correction comments for a building permit review.
Cite only these {CODE_EDITION} sections, written as "{CODE_EDITION} §<number>":
{json.dumps(SECTIONS, indent=2)}

Rules for every comment:
- Start with an action the applicant can take (Provide, Revise, Clarify, Show, Verify, Coordinate, Specify).
- Reference the sheet where the issue appears.
- Put the numbers that prove the issue in `evidence` (loads, widths, distances).
- Cite requirements, never products, brands or model numbers.
- If the data does not prove a violation, do not write a comment for it.
Use short upper-case check_ids such as EGRESS-WIDTH or ACCESSIBLE-ROUTE."""


def review(project: dict) -> list[Finding]:
    import anthropic

    client = anthropic.Anthropic()
    public = {k: v for k, v in project.items() if k != "expected_findings"}
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": FINDINGS_SCHEMA}},
        messages=[{"role": "user", "content": "Review this project record:\n" + json.dumps(public, indent=2)}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined the request; route this project to a human reviewer.")
    text = next(block.text for block in response.content if block.type == "text")
    findings = []
    for item in json.loads(text)["findings"]:
        finding = Finding.from_dict(item)
        finding.source = "llm"
        findings.append(finding)
    return findings
