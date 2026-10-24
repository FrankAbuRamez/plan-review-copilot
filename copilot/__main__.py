"""Usage:
    python -m copilot review plans.pdf calcs.pdf --code "2025 CBC" [--out letter.md]
    python -m copilot data/projects/p2_bistro.json [--llm] [--out letter.md]
"""
import argparse
import sys
from pathlib import Path


def review_cmd(argv: list[str]) -> None:
    from . import doc_reviewer

    parser = argparse.ArgumentParser(prog="python -m copilot review", description="Draft comments from plan and calc documents.")
    parser.add_argument("files", nargs="+", help="plan / calculation PDFs or sheet images")
    parser.add_argument("--code", default="2024 I-Codes (IRC for dwellings, IBC for everything else)",
                        help='code family, e.g. "2025 California codes" or "2023 Florida codes, 8th Edition"')
    parser.add_argument("--disciplines", help="comma-separated, default: all")
    parser.add_argument("--notes", default="", help="anything the reviewer should know (scope, jurisdiction)")
    parser.add_argument("--model", default="claude-sonnet-5-5", help="claude-sonnet-5-5 (default, lower cost) or claude-opus-5-5")
    parser.add_argument("--standard-plan", action="store_true",
                        help="pre-approved plan set: review site-specific items and deviations only")
    parser.add_argument("--out", help="write the letter to this Markdown file")
    args = parser.parse_args(argv)
    disciplines = [d.strip() for d in args.disciplines.split(",")] if args.disciplines else None
    raw, accepted, rejected, _log = doc_reviewer.review_documents(args.files, args.code, disciplines, args.notes, args.model,
                                                              "standard" if args.standard_plan else "full")
    letter = doc_reviewer.render(raw, accepted, rejected, args.code)
    if args.out:
        Path(args.out).write_text(letter, encoding="utf-8")
        print(f"Wrote {args.out}: {len(accepted)} comments, {len(rejected)} held for review")
    else:
        print(letter)


def project_cmd(argv: list[str]) -> None:
    from .pipeline import load_project, render_letter, run

    parser = argparse.ArgumentParser(description="Draft a correction letter from a structured project record.")
    parser.add_argument("project", help="path to a project JSON file")
    parser.add_argument("--llm", action="store_true", help="add Claude as a second first-pass reviewer")
    parser.add_argument("--out", help="write the letter to this Markdown file")
    args = parser.parse_args(argv)
    project = load_project(args.project)
    result = run(project, use_llm=args.llm)
    letter = render_letter(project, result)
    if args.out:
        Path(args.out).write_text(letter, encoding="utf-8")
        print(f"Wrote {args.out}: {len(result.accepted)} corrections, {len(result.rejected)} held for review")
    else:
        print(letter)


def main() -> None:
    argv = sys.argv[1:]
    if argv and argv[0] == "review":
        review_cmd(argv[1:])
    else:
        project_cmd(argv)


if __name__ == "__main__":
    main()
