"""Usage: python -m copilot data/projects/p2_bistro.json [--llm] [--out letter.md]"""
import argparse
from pathlib import Path

from .pipeline import load_project, render_letter, run


def main() -> None:
    parser = argparse.ArgumentParser(description="Draft a plan review correction letter.")
    parser.add_argument("project", help="path to a project JSON file")
    parser.add_argument("--llm", action="store_true", help="add Claude as a second first-pass reviewer")
    parser.add_argument("--out", help="write the letter to this Markdown file")
    args = parser.parse_args()

    project = load_project(args.project)
    result = run(project, use_llm=args.llm)
    letter = render_letter(project, result)
    if args.out:
        Path(args.out).write_text(letter, encoding="utf-8")
        print(f"Wrote {args.out}: {len(result.accepted)} corrections, {len(result.rejected)} held for review")
    else:
        print(letter)


if __name__ == "__main__":
    main()
