import unittest
from pathlib import Path

from copilot import qa_gate, rules, senior_audit
from copilot.models import Finding
from copilot.pipeline import load_project, render_letter, run
from evals.run_eval import score_gate

PROJECTS = Path(__file__).resolve().parent.parent / "data" / "projects"


def finding(**overrides):
    base = dict(check_id="DOOR-WIDTH", discipline="Building", severity="Major", sheet="A-601",
                section="IBC 2021 §1010.1.1",
                comment="Revise door D2 to provide a minimum 32 in. clear opening width.", evidence="D2=30 in.")
    base.update(overrides)
    return Finding(**base)


class RuleTests(unittest.TestCase):
    def test_occupant_load_rounds_up_per_space(self):
        project = load_project(PROJECTS / "p2_bistro.json")
        self.assertEqual(rules.occupant_load(project), 120 + 5)

    def test_required_exits_table(self):
        self.assertEqual([rules.required_exits(n) for n in (49, 500, 501, 1000, 1001)], [2, 2, 3, 3, 4])

    def test_clean_project_has_no_findings(self):
        result = run(load_project(PROJECTS / "p1_dental_office.json"))
        self.assertEqual(result.accepted, [])
        self.assertEqual(result.rejected, [])

    def test_sprinklered_building_uses_one_third_diagonal(self):
        ids = {f.check_id for f in rules.review(load_project(PROJECTS / "p3_tech_office.json"))}
        self.assertIn("EXIT-SEP", ids)  # 60 ft < 210/3 = 70 ft
        self.assertIn("TRAVEL", ids)    # 320 ft > 300 ft


class AuditTests(unittest.TestCase):
    def test_life_safety_severity_is_raised(self):
        audited, log = senior_audit.audit([finding(check_id="TRAVEL", severity="Minor", section="IBC 2021 §1017.2")])
        self.assertEqual(audited[0].severity, "Critical")
        self.assertTrue(any("raised" in line for line in log))

    def test_documentation_item_is_capped_at_major(self):
        audited, _ = senior_audit.audit([finding(check_id="OL-DOC", severity="Critical", section="IBC 2021 §107.2.3")])
        self.assertEqual(audited[0].severity, "Major")

    def test_duplicates_merge_keeping_higher_severity(self):
        llm = finding(severity="Critical", source="llm")
        audited, _ = senior_audit.audit([finding(), llm])
        self.assertEqual(len(audited), 1)
        self.assertEqual(audited[0].source, "llm")

    def test_unknown_citation_is_flagged_then_rejected(self):
        audited, _ = senior_audit.audit([finding(section="IBC 2021 §1010.9.9")])
        accepted, rejected = qa_gate.gate(audited)
        self.assertEqual(accepted, [])
        self.assertIn("not in the verified reference library", rejected[0][1][0])


class GateTests(unittest.TestCase):
    def test_red_team_set(self):
        gate = score_gate()
        self.assertEqual(gate["leaks"], [], "bad comments leaked through the gate")
        self.assertEqual(gate["false_blocks"], [], "good comments were blocked")


class LetterTests(unittest.TestCase):
    def test_letter_lists_corrections_with_citations(self):
        project = load_project(PROJECTS / "p4_community_hall.json")
        letter = render_letter(project, run(project))
        self.assertIn("IBC 2021 §1006.3.3", letter)
        self.assertIn("Synthetic demo data", letter)


if __name__ == "__main__":
    unittest.main()
