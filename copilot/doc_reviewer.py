"""Review real documents: plan PDFs, calculation PDFs, or sheet images.

Claude reads the documents and drafts correction comments as structured JSON.
The comments then go through the same senior audit and QA gate as the rules
engine, in non-strict mode: the full building code is larger than the verified
library, so unknown sections are flagged "verify citation" instead of blocked.

Requires `pip install anthropic` and an ANTHROPIC_API_KEY (or `ant auth login`).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

from . import qa_gate, senior_audit
from .models import Finding

MODEL = "claude-sonnet-5-5"  # lower cost; pass --model claude-opus-5-5 for a deeper review
HERE = Path(__file__).resolve().parent
PROMPT = (HERE / "doc_review_prompt.md").read_text(encoding="utf-8")
SCHEMA = json.loads((HERE / "doc_review_schema.json").read_text(encoding="utf-8"))
DISCIPLINES = ["Building", "Fire and Life Safety", "Accessibility", "Structural",
               "Mechanical", "Electrical", "Plumbing", "Energy", "Green Building"]
MEDIA = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
MAX_REQUEST_BYTES = 32 * 1024 * 1024


def system_prompt(code_basis: str, disciplines: list[str]) -> str:
    edition = code_basis.split("(")[0].strip()
    return (PROMPT.replace("{code_basis}", code_basis)
            .replace("{disciplines}", ", ".join(disciplines))
            .replace("{example_citation}", f"{edition} §1005.3.2"))


def document_blocks(paths: list[str]) -> list[dict]:
    blocks, total = [], 0
    for p in map(Path, paths):
        media = MEDIA.get(p.suffix.lower())
        if media is None:
            raise ValueError(f"{p.name}: only PDF, PNG and JPG files are supported")
        data = base64.standard_b64encode(p.read_bytes()).decode("ascii")
        total += len(data)
        kind = "document" if media == "application/pdf" else "image"
        blocks.append({"type": "text", "text": f"File: {p.name}"})
        blocks.append({"type": kind, "source": {"type": "base64", "media_type": media, "data": data}})
    if total > MAX_REQUEST_BYTES * 0.95:
        raise ValueError("The files are too large for one request (32 MB limit after encoding). "
                         "Split the plan set or remove sheets outside the review scope.")
    return blocks


def draft(paths: list[str], code_basis: str, disciplines: list[str], notes: str = "", model: str = MODEL) -> dict:
    """Send the documents to Claude and return the parsed JSON review."""
    import anthropic

    client = anthropic.Anthropic()
    content = document_blocks(paths) + [{"type": "text", "text":
        "Review these documents and draft correction comments." + (f"\nReviewer notes: {notes}" if notes else "")}]
    with client.beta.messages.stream(
        model=model,
        max_tokens=64000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=system_prompt(code_basis, disciplines),
        output_config={"effort": "high" if "opus" in model else "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise RuntimeError("Claude declined this request; route the submittal to a human reviewer.")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("The review ran out of room. Review fewer sheets or disciplines at a time.")
    text = next(block.text for block in message.content if block.type == "text")
    return json.loads(text)


def to_findings(review: dict) -> list[Finding]:
    findings = []
    for i, c in enumerate(review["comments"], 1):
        findings.append(Finding(check_id=f"C{i:02d}", discipline=c["discipline"], severity=c["severity"],
                                sheet=c["sheet"], section=c["section"], comment=c["comment"],
                                evidence=c["basis"], source="claude"))
    return findings


def review_documents(paths: list[str], code_basis: str, disciplines: list[str] | None = None, notes: str = "", model: str = MODEL):
    raw = draft(paths, code_basis, disciplines or DISCIPLINES, notes, model)
    audited, log = senior_audit.audit(to_findings(raw), strict=False)
    accepted, rejected = qa_gate.gate(audited, strict=False)
    return raw, accepted, rejected, log


def render(raw: dict, accepted: list[Finding], rejected, code_basis: str) -> str:
    p = raw["project"]
    lines = [f"# Plan Review Corrections — {p['name']}", "",
             f"Code basis {code_basis} · Occupancy {p['occupancy']} · Construction {p['construction_type']} · "
             f"Sprinklered {p['sprinklered']} · {p['stories']} stories · {p['building_area']}", "",
             f"Scope: {p['scope']}", ""]
    for i, f in enumerate(accepted, 1):
        flag = " · verify citation" if "VERIFY_CITATION" in f.notes else ""
        lines += [f"**{i}. [{f.severity}] {f.discipline} — Sheet {f.sheet} — {f.section}{flag}**", "",
                  f.comment, "", f"_Basis: {f.evidence}_", ""]
    if rejected:
        lines += ["---", "", "## Held for human review (failed QA gate)", ""]
        lines += [f"- {f.comment} ({'; '.join(problems)})" for f, problems in rejected]
    if raw.get("not_reviewed"):
        lines += ["", "## Not reviewed", ""] + [f"- {x}" for x in raw["not_reviewed"]]
    lines += ["", "_Draft for a certified plans examiner to verify before sending._"]
    return "\n".join(lines)
