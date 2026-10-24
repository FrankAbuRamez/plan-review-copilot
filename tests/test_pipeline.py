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

    def test_accessibility_checks(self):
        bistro = {f.check_id for f in rules.review(load_project(PROJECTS / "p2_bistro.json"))}
        market = {f.check_id for f in rules.review(load_project(PROJECTS / "p5_corner_market.json"))}
        self.assertIn("ACCESSIBLE-RESTROOM", bistro)
        self.assertIn("ACCESSIBLE-ROUTE", market)
        self.assertNotIn("ACCESSIBLE-ROUTE", bistro)

    def test_sprinklered_storage_travel_limit(self):
        ids = {f.check_id for f in rules.review(load_project(PROJECTS / "p8_warehouse.json"))}
        self.assertEqual(ids, {"TRAVEL"})  # 265 ft > 250 ft; 36 in. corridor serves only 10, so no corridor comment


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


class DocumentModeTests(unittest.TestCase):
    """Real documents cite the whole code, so the gate runs in non-strict mode."""

    def setUp(self):
        from copilot import doc_reviewer
        self.dr = doc_reviewer
        self.raw = {"project": {}, "not_reviewed": [], "comments": [
            {"discipline": "Accessibility", "severity": "Major", "sheet": "A-401", "section": "2025 CBC §11B-304.3",
             "comment": "Provide a 60 in. turning space in toilet room 104 and dimension it on the enlarged plan.", "basis": "Room is 5'-2\" x 4'-8\"."},
            {"discipline": "Building", "severity": "Minor", "sheet": "A-101", "section": "2025 CBC §1017.2",
             "comment": "Revise layout since travel distance might exceed the limit.", "basis": ""},
            {"discipline": "Building", "severity": "Major", "sheet": "A-601", "section": "",
             "comment": "Provide panic hardware by a named manufacturer on doors serving the dining room.", "basis": ""},
        ]}

    def test_article_and_chapter_citations_parse(self):
        self.assertEqual(senior_audit.section_number("2025 CEC Article 220"), "220")
        self.assertEqual(senior_audit.section_number("2025 CPC Chapter 7"), "7")
        self.assertEqual(senior_audit.section_number("2025 CRC Table R602.3(1)"), "R602.3")
        self.assertIsNone(senior_audit.section_number("see the code"))

    def test_cbc_section_numbers_parse(self):
        self.assertEqual(senior_audit.section_number("2025 CBC §11B-304.3"), "11B-304.3")
        self.assertEqual(senior_audit.section_number("IBC 2021 §1005.3.2"), "1005.3.2")

    def test_non_strict_gate_flags_instead_of_blocking(self):
        audited, _ = senior_audit.audit(self.dr.to_findings(self.raw), strict=False)
        accepted, rejected = qa_gate.gate(audited, strict=False)
        self.assertEqual([f.check_id for f in accepted], ["C01"])
        self.assertIn("VERIFY_CITATION", accepted[0].notes)
        reasons = {f.check_id: problems for f, problems in rejected}
        self.assertTrue(any("hedging" in r for r in reasons["C02"]))
        self.assertTrue(any("missing code citation" in r for r in reasons["C03"]))
        travel = next(f for f, _ in rejected if f.check_id == "C02")
        self.assertEqual(travel.severity, "Major")  # document mode: life-safety items are never Minor

    def test_prompt_fills_placeholders(self):
        text = self.dr.system_prompt("2025 California codes (CRC for dwellings and ADUs, CBC for everything else)", ["Building"])
        self.assertNotIn("{", text)
        self.assertIn("2025 CRC §R310.2.1", text)

    def test_residential_sections_parse_and_count_as_life_safety(self):
        self.assertEqual(senior_audit.section_number("2025 CRC §R310.2.1"), "R310.2.1")
        f = Finding("C01", "Fire and Life Safety", "Major", "A-2", "2025 CRC §R310.2.1",
                    "Provide emergency escape and rescue openings in each bedroom.", "No window schedule.")
        audited, _ = senior_audit.audit([f], strict=False)
        self.assertEqual(audited[0].severity, "Major")

    def test_replace_counts_as_an_action(self):
        f = Finding("C02", "Structural", "Minor", "SNS-1", "2025 CRC §R602.3",
                    "Replace the web printout fastener table with the code fastening schedule.", "SNS-1 shows a web printout of the IRC table.")
        self.assertEqual(qa_gate.check(f, strict=False), [])

    def test_energy_model_is_not_a_product_model(self):
        f = Finding("C04", "Energy", "Major", "T24-2", "2025 California Energy Code §150.1",
                    "Coordinate the energy model with the plans so the water heater and roof assembly match.",
                    "CF1R water heater differs from the A1.0 legend.")
        self.assertEqual(qa_gate.check(f, strict=False), [])

    def test_code_edition_citation_is_allowed_in_document_mode(self):
        f = Finding("C05", "General", "Major", "General", "2025 California Building Standards Code (Title 24), effective January 1, 2026",
                    "Revise the governing code notes to the 2025 editions on every sheet that cites 2022.",
                    "S2 and UT-1 cite the 2022 CRC and CGBSC.")
        audited, _ = senior_audit.audit([f], strict=False)
        self.assertEqual(qa_gate.check(audited[0], strict=False), [])
        self.assertIn("VERIFY_CITATION", audited[0].notes)

    def test_section_index_marks_known_sections(self):
        from copilot.section_index import lookup
        self.assertEqual(lookup("2025 CRC §R310.2.1")[0], "R310.2.1")
        self.assertEqual(lookup("2025 California Energy Code §150.1(c)14")[0], "150.1(c)14")
        self.assertEqual(lookup("2025 CEC Article 220")[0], "220")
        self.assertIsNone(lookup("2025 CRC §R999.9"))
        f = Finding("C06", "Building", "Major", "A1.0", "2025 CRC §R308.4",
                    "Identify each hazardous location requiring safety glazing on the plans.", "A1.0 note only.")
        audited, _ = senior_audit.audit([f], strict=False)
        self.assertIn("INDEXED", audited[0].notes)

    def test_document_mode_life_safety_floor_is_major(self):
        f = Finding("C07", "Fire and Life Safety", "Minor", "A1.0", "2025 CRC §R310.2.1",
                    "Provide net clear opening dimensions for each bedroom escape window.", "Schedule has no net clear sizes.")
        audited, _ = senior_audit.audit([f], strict=False)
        self.assertEqual(audited[0].severity, "Major")

    def test_document_comment_needs_evidence(self):
        f = Finding("C03", "Building", "Major", "A-1", "2025 CRC §R302.1",
                    "Coordinate eave construction with the site plan fire separation distances.", ",")
        self.assertIn("no evidence from the documents", qa_gate.check(f, strict=False))
