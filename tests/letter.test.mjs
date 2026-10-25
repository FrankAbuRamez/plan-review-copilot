import { buildLetter, letterText, letterHtml, roundFrom, withCite, cite } from "../docs/letter.js";
import assert from "node:assert/strict";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f = (discipline, sheet, page, comment, section, extra = {}) => ({ discipline, sheet, page, file: "plans.pdf", comment, section, severity: "Major",
  evidence: "x", notes: [], status: "letter", include: true, ...extra });

assert.equal(cite("2025 CRC §R311.3"), "CRC R311.3");
assert.equal(withCite("Provide a landing at the rear door.", "2025 CRC §R311.3"), "Provide a landing at the rear door. CRC R311.3.");
assert.equal(withCite("Provide landings per CRC R311.3 at all doors.", "2025 CRC §R311.3"), "Provide landings per CRC R311.3 at all doors.");
assert.equal(roundFrom("A1. text"), 2);
assert.equal(roundFrom("A1. text\n   PC2: remains"), 3);

const state = {
  when: "2026-10-24T12:00:00Z", code: "2025 California codes", disciplines: ["Building", "Structural", "Energy", "Mechanical"],
  fileOrder: ["plans.pdf", "calcs.pdf"], meta: { jx: "City of Example", pc: "B26-0001", rv: "A. Reviewer" },
  raw: { project: { name: "Sample ADU", scope: "New 484 sf detached ADU", governing_code: "2025 CRC", occupancy: "R-3", construction_type: "V-B",
    sprinklered: "No", stories: "1", building_area: "484 sf", documents: [{ type: "Drawings", date: "May 1, 2026", prepared_by: "Example Design" }] } },
  items: [
    f("Building", "A-2", 5, "Provide the 36 in. landing at the rear door.", "2025 CRC §R311.3"),
    f("General", "General", 0, "Provide the designer's signature on every sheet.", "B&P Code §5536.1"),
    f("Building", "A-1", 2, "Revise the sheet index to match the set.", "2025 CBC §107.2"),
    f("Building", "A-2", 5, "Show tempered glazing at window C.", "2025 CRC §R308.4.2"),
    f("Structural", "Calcs p. 12", 12, "Revise the header at window C to the 6 ft span.", "2025 CRC §R602.7", { file: "calcs.pdf" }),
    f("Structural", "Calcs p. 4", 4, "Update the seismic values to ASCE 7-22.", "2025 CRC §R301.2.2", { file: "calcs.pdf" }),
    f("Structural", "S-1", 1, "Provide the special inspection list.", "2025 CBC §1704.2.3", { file: "plans.pdf", include: false }),
    f("Energy", "A-1", 2, "List the HERS features on the cover sheet.", "2025 California Energy Code §150.1"),
  ],
};
const L = buildLetter(state);
const txt = letterText(L);
console.log(txt, "\n---------------\n");
assert.match(txt, /First review/);
assert.match(txt, /A1\. Provide the designer's signature/);
assert.match(txt, /A2\. Sheet A-1 – Revise the sheet index/);
assert.match(txt, /A3\. Sheet A-2, please address the following:\n   a\) Provide the 36 in\. landing at the rear door\. CRC R311\.3\./);
assert.match(txt, /MECHANICAL COMMENTS\nNo comments\./);
assert.match(txt, /S1\. Structural calculations, please address the following:\n   a\) Page 4 – Update/);
assert.ok(!/special inspection/.test(txt), "switched-off item left out");
assert.equal(L.labels.get(3), "A3.b");

// Recheck against that letter
const re = {
  ...state, round: roundFrom(txt), items: [f("Building", "A-3", 7, "Show the new skylight's listing on the roof plan.", "2025 CRC §R308.6")],
  recheck: [
    { number: "A1", group_header: "", original: "Provide the designer's signature on every sheet. B&P Code 5536.1.", status: "Cleared", follow_up: "", discipline: "General", include: false },
    { number: "A3.a", group_header: "Sheet A-2, please address the following:", original: "a) Provide the 36 in. landing at the rear door. CRC R311.3.", status: "Not cleared", follow_up: "Show the landing on the floor plan; a general note is not enough. Comment remains.", discipline: "Building", include: true },
    { number: "A3.b", group_header: "Sheet A-2, please address the following:", original: "Show tempered glazing at window C. CRC R308.4.2.", status: "Cleared", follow_up: "", discipline: "Building", include: false },
    { number: "S1.b", group_header: "Structural calculations, please address the following:", original: "Page 12 – Revise the header.", status: "Partly cleared", follow_up: "Thank you for revising the header. Provide the post below it as well.", discipline: "Structural", include: true },
    { number: "T1", group_header: "", original: "Sheet A-1 – List the HERS features.", status: "Cleared", follow_up: "", discipline: "Energy", include: false },
  ],
};
const R = buildLetter(re);
const rtxt = letterText(R);
console.log(rtxt, "\n---------------\n");
assert.match(rtxt, /Second review/);
assert.match(rtxt, /A3\. Sheet A-2, please address the following:\n   a\) Provide the 36 in\. landing at the rear door\. CRC R311\.3\.\n      PC2: Show the landing/);
assert.ok(!/A1\./.test(rtxt) && !/tempered glazing/.test(rtxt));
assert.match(rtxt, /Additional PC2 comments\nA4\. Sheet A-3 – Show the new skylight/);
assert.match(rtxt, /ENERGY COMPLIANCE COMMENTS\nNo comments\./);

// Third round: carried text keeps the PC2 note, PC3 goes under it
const r3 = { ...re, round: roundFrom(rtxt), items: [], recheck: [
  { number: "A3.a", group_header: "Sheet A-2, please address the following:", original: "Provide the 36 in. landing at the rear door. CRC R311.3.\nPC2: Show the landing on the floor plan; a general note is not enough. Comment remains.", status: "Not cleared", follow_up: "", discipline: "Building", include: true },
] };
const t3 = letterText(buildLetter(r3));
assert.match(t3, /Third review/);
assert.match(t3, /      PC2: Show the landing.*\n      PC3: Comment not addressed\. Comment remains\./);

// Everything cleared -> final letter
const fin = letterText(buildLetter({ ...re, items: [], recheck: re.recheck.map((x) => ({ ...x, status: "Cleared", include: false })) }));
assert.match(fin, /no further comments/);
assert.ok(letterHtml(R, esc).includes("Additional PC2 comments"));
console.log(t3, "\nall letter tests pass");
