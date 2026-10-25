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
import re
from pathlib import Path

from . import qa_gate, senior_audit
from .models import Finding

MODEL = "claude-sonnet-5-5"  # lower cost; pass --model claude-opus-5-5 for a deeper review
HERE = Path(__file__).resolve().parent
PROMPT = (HERE / "doc_review_prompt.md").read_text(encoding="utf-8")
SCHEMA = json.loads((HERE / "doc_review_schema.json").read_text(encoding="utf-8"))
REVIEW_TYPES = json.loads((HERE / "review_types.json").read_text(encoding="utf-8"))
RECHECK_PROMPT = (HERE / "recheck_prompt.md").read_text(encoding="utf-8")
RECHECK_SCHEMA = json.loads((HERE / "recheck_schema.json").read_text(encoding="utf-8"))
CODE_NOTES = json.loads((HERE / "code_notes.json").read_text(encoding="utf-8"))
DISCIPLINES = ["Building", "Fire and Life Safety", "Accessibility", "Structural",
               "Mechanical", "Electrical", "Plumbing", "Energy", "Green Building"]
MEDIA = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
MAX_REQUEST_BYTES = 32 * 1024 * 1024


def code_notes(code_basis: str) -> dict | None:
    """Edition-specific section numbers (the 2025 CRC renumbered Chapter 3); same table as the web app."""
    return next((n for n in CODE_NOTES if re.search(n["match"], code_basis, re.I)), None)


def example_citation(code_basis: str) -> str:
    year = code_basis.split()[0]
    if "Florida" in code_basis:
        return "FBC Residential §R310.2.1 for a dwelling, or FBC Building §1005.3.2"
    notes = code_notes(code_basis)
    if notes:
        return notes["example"].replace("{year}", year)
    return f"{code_basis.split('(')[0].strip()} §1005.3.2"


def system_prompt(code_basis: str, disciplines: list[str], review_type: str = "full") -> str:
    notes = code_notes(code_basis)
    return (PROMPT.replace("{code_basis}", code_basis)
            .replace("{review_type}", REVIEW_TYPES.get(review_type, REVIEW_TYPES["full"]))
            .replace("{disciplines}", ", ".join(disciplines))
            .replace("{example_citation}", example_citation(code_basis))
            .replace("{code_notes}", notes["notes"] if notes else "Use the section numbers of the edition named in the code basis."))


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


def _call(system: str, schema: dict, content: list[dict], model: str) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=model,
        max_tokens=128000,  # Sonnet and Opus 5.5 allow 128K output; a master list makes letters longer
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=system,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise RuntimeError("Claude declined this request; route the submittal to a human reviewer.")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("The review ran out of room. Review fewer sheets or disciplines at a time.")
    return json.loads(next(block.text for block in message.content if block.type == "text"))


def recheck(paths: list[str], previous_letter: str, code_basis: str, model: str = MODEL):
    """Recheck a resubmittal against the previous letter. Returns (raw, open_items, accepted, rejected, log)."""
    notes = code_notes(code_basis)
    system = (RECHECK_PROMPT.replace("{code_basis}", code_basis).replace("{previous_letter}", previous_letter)
              .replace("{code_notes}", notes["notes"] if notes else "Use the section numbers of the edition named in the code basis."))
    raw = _call(system, RECHECK_SCHEMA, document_blocks(paths) + [{"type": "text", "text": "Recheck this resubmittal against the previous letter."}], model)
    open_items = [x for x in raw["recheck"] if x["status"] != "Cleared"]
    audited, log = senior_audit.audit(to_findings(raw), strict=False)
    accepted, rejected = qa_gate.gate(audited, strict=False)
    return raw, open_items, accepted, rejected, log


def library_block(lines: list[str]) -> list[dict]:
    """The reviewer's standard comments, used for wording when one fits (same text as the web app)."""
    lines = [x.strip() for x in lines if len(x.strip()) > 15][:400]
    if not lines:
        return []
    return [{"type": "text", "text": "The reviewer's standard comments are below. When one fits an issue you found, use its wording, "
             "adjusted to the project. Do not add a comment just because it is in this list.\n" + "\n".join("- " + x for x in lines)}]


MASTER_MAX = 700_000  # characters across master lists, about 175k tokens (same as the web app)


def master_text(path: str) -> str:
    """A master comment list as text: Word paragraphs indented by list level, or a plain text file."""
    p = Path(path)
    if p.suffix.lower() != ".docx":
        return p.read_text(encoding="utf-8")
    import html
    import zipfile
    xml = zipfile.ZipFile(p).read("word/document.xml").decode("utf-8")
    lines = []
    for para in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
        text = html.unescape("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", para)))
        level = re.search(r'<w:ilvl w:val="(\d+)"', para)
        if text.strip():
            lines.append("  " * (int(level.group(1)) if level else 0) + text)
    return "\n".join(lines)


def master_blocks(paths: list[str]) -> list[dict]:
    """The reviewer's master comment lists, with the same instructions as the web app."""
    blocks, room = [], MASTER_MAX
    for path in paths:
        text = master_text(path)[:max(0, room)]
        room -= len(text)
        if text:
            blocks.append({"type": "text", "text": f'The reviewer\'s master comment list "{Path(path).name}" is below. It is the wording this office uses. '
                           "When an issue you found matches a comment in it, use that wording, adjusted to the project (fill in the sheet, window, door "
                           "or detail references, and drop placeholders such as ENTER TEXT or XXX). Do not add a comment just because it is in the list, "
                           "and do not copy comments for conditions the documents do not show. When a standard comment lists several sub-items, keep "
                           "only the ones that apply and keep each comment under 400 characters; split it into separate comments when needed. "
                           "Its section numbers may come from an older edition, so "
                           "always cite the section numbers for the code basis above. Apply a jurisdiction-specific item only when the plans or the "
                           f"reviewer notes place the project in that jurisdiction.\n\n{text}"})
    return blocks


def draft(paths: list[str], code_basis: str, disciplines: list[str], notes: str = "", model: str = MODEL,
          review_type: str = "full", library: list[str] | None = None, masters: list[str] | None = None) -> dict:
    """Send the documents to Claude and return the parsed JSON review."""
    content = document_blocks(paths) + master_blocks(masters or []) + library_block(library or []) + [{"type": "text", "text":
        "Review these documents and draft correction comments." + (f"\nReviewer notes: {notes}" if notes else "")}]
    return _call(system_prompt(code_basis, disciplines, review_type), SCHEMA, content, model)


def to_findings(review: dict) -> list[Finding]:
    findings = []
    for i, c in enumerate(review["comments"], 1):
        findings.append(Finding(check_id=f"C{i:02d}", discipline=c["discipline"], severity=c["severity"],
                                sheet=c["sheet"], section=c["section"], comment=c["comment"],
                                evidence=c["basis"], source="claude"))
    return findings


def review_documents(paths: list[str], code_basis: str, disciplines: list[str] | None = None, notes: str = "",
                     model: str = MODEL, review_type: str = "full", library: list[str] | None = None,
                     masters: list[str] | None = None):
    raw = draft(paths, code_basis, disciplines or DISCIPLINES, notes, model, review_type, library, masters)
    audited, log = senior_audit.audit(to_findings(raw), strict=False)
    accepted, rejected = qa_gate.gate(audited, strict=False)
    return raw, accepted, rejected, log


def render(raw: dict, accepted: list[Finding], rejected, code_basis: str) -> str:
    p = raw["project"]
    lines = [f"# Plan Review Corrections — {p['name']}", "",
             f"Governing code {p['governing_code']} · Occupancy {p['occupancy']} · Construction {p['construction_type']} · "
             f"Sprinklered {p['sprinklered']} · {p['stories']} stories · {p['building_area']}", "",
             f"Scope: {p['scope']}", ""]
    for i, f in enumerate(accepted, 1):
        flag = " · verify citation" if "VERIFY_CITATION" in f.notes else ""
        lines += [f"**{i}. [{f.severity}] {f.discipline} — Sheet {f.sheet} — {f.section}{flag}**", "",
                  f.comment, "", f"_Basis: {f.evidence}_", ""]
    if rejected:
        lines += ["---", "", "## Held for human review (failed QA gate)", ""]
        lines += [f"- {f.comment} ({'; '.join(problems)})" for f, problems in rejected]
    if raw.get("checklist"):
        lines += ["", "## Code checklist", ""]
        lines += [f"- {c['status']}: {c['item']} ({c['code']}, sheet {c['sheet']}) {c['note']}" for c in raw["checklist"]]
    if raw.get("not_reviewed"):
        lines += ["", "## Not reviewed", ""] + [f"- {x}" for x in raw["not_reviewed"]]
    lines += ["", "_Draft for a certified plans examiner to verify before sending._"]
    return "\n".join(lines)
