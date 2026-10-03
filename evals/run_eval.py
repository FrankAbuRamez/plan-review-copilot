"""Score the pipeline against the answer keys and the QA-gate red-team set.

Usage:
    python -m evals.run_eval            # rule-based reviewer only (no API key needed)
    python -m evals.run_eval --llm      # rules + Claude reviewer
    python -m evals.run_eval --report evals/RESULTS.md
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from copilot import qa_gate
from copilot.models import Finding
from copilot.pipeline import load_project, run
from copilot.senior_audit import section_number

ROOT = Path(__file__).resolve().parent.parent


def score_projects(use_llm: bool) -> tuple[list[dict], dict]:
    rows = []
    tp = fp = fn = 0
    for path in sorted((ROOT / "data" / "projects").glob("*.json")):
        project = load_project(path)
        result = run(project, use_llm=use_llm)
        expected = {e["section"] for e in project["expected_findings"]}
        predicted = {section_number(f.section) for f in result.accepted}
        hit, extra, missed = expected & predicted, predicted - expected, expected - predicted
        tp, fp, fn = tp + len(hit), fp + len(extra), fn + len(missed)
        rows.append({
            "project": f"{project['id']} {project['name']}",
            "expected": len(expected), "found": len(hit),
            "false_positives": sorted(extra), "missed": sorted(missed),
            "held_for_review": len(result.rejected),
        })
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    return rows, {"precision": precision, "recall": recall, "tp": tp, "fp": fp, "fn": fn}


def score_gate() -> dict:
    cases = json.loads((ROOT / "evals" / "qa_gate_cases.json").read_text(encoding="utf-8"))
    leaks, blocks = [], []
    for case in cases["should_reject"]:
        if not qa_gate.check(Finding.from_dict(case)):
            leaks.append(case["label"])
    for case in cases["should_accept"]:
        problems = qa_gate.check(Finding.from_dict(case))
        if problems:
            blocks.append(f"{case['label']}: {problems}")
    return {
        "bad_caught": len(cases["should_reject"]) - len(leaks), "bad_total": len(cases["should_reject"]),
        "good_passed": len(cases["should_accept"]) - len(blocks), "good_total": len(cases["should_accept"]),
        "leaks": leaks, "false_blocks": blocks,
    }


def to_markdown(rows: list[dict], totals: dict, gate: dict, mode: str) -> str:
    lines = [
        f"# Evaluation results ({mode})", "",
        f"**Precision {totals['precision']:.0%} · Recall {totals['recall']:.0%}** "
        f"({totals['tp']} correct, {totals['fp']} false positives, {totals['fn']} missed)", "",
        f"**QA gate red team:** caught {gate['bad_caught']}/{gate['bad_total']} bad comments, "
        f"passed {gate['good_passed']}/{gate['good_total']} good ones", "",
        "| Project | Expected | Found | False positives | Missed |", "|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| {r['project']} | {r['expected']} | {r['found']} | "
                     f"{', '.join(r['false_positives']) or '-'} | {', '.join(r['missed']) or '-'} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm", action="store_true")
    parser.add_argument("--report")
    args = parser.parse_args()
    rows, totals = score_projects(args.llm)
    gate = score_gate()
    report = to_markdown(rows, totals, gate, "rules + Claude" if args.llm else "rules only")
    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
