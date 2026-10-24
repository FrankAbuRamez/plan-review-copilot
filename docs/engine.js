// Browser port of the Python pipeline (copilot/rules.py, senior_audit.py, qa_gate.py).
// Same checks, same order, same wording, so the demo matches `python -m copilot`.
(function (root) {
  "use strict";
  const SEVERITIES = ["Critical", "Major", "Minor"];

  function make(D) {
    const cite = (s) => `${D.edition} §${s}`;
    const isKnown = (s) => Object.prototype.hasOwnProperty.call(D.sections, s);

    // Python's format(x, ".0f") rounds half to even; match it so numbers agree.
    function f0(x) {
      const r = Math.round(x);
      if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return String(r - 1);
      return String(r);
    }

    function occupantLoad(p) {
      return p.spaces.reduce((t, s) => t + Math.ceil(s.area_sf / D.factors[s.use]), 0);
    }
    function requiredExits(load) { return load > 1000 ? 4 : load > 500 ? 3 : 2; }
    function sheet(p, key, def = "Code analysis") { return (p.sheets || {})[key] || def; }

    // ---------- Stage 1: rules ----------
    function review(p) {
      const out = [];
      const load = occupantLoad(p);
      const exits = p.exits || [];
      const spr = !!p.sprinklered;
      const doc = p.documented || {};
      const isA = p.occupancy.startsWith("A");
      const eg = sheet(p, "egress");
      const add = (check_id, severity, sh, section, comment, evidence, discipline = "Building") =>
        out.push({ check_id, discipline, severity, sheet: sh, section: cite(section), comment, evidence, source: "rules", notes: [] });

      if (doc.occupant_load_on_plans === false)
        add("OL-DOC", "Major", sheet(p, "code_analysis"), "107.2.3",
          "Provide an occupant load calculation for each room and space on the code analysis sheet, using the factors in Table 1004.5.",
          `No occupant load shown; reviewer estimate is ${load} occupants.`);

      const needed = requiredExits(load);
      if (exits.length < needed)
        add("EXITS-COUNT", "Critical", eg, "1006.3.3",
          `Revise the egress plan to provide at least ${needed} exits from this story.`,
          `Occupant load ${load} requires ${needed} exits; ${exits.length} shown.`);

      if (exits.length >= 2 && p.overall_diagonal_ft) {
        const frac = spr ? 1 / 3 : 1 / 2;
        const min = p.overall_diagonal_ft * frac;
        const sep = p.exit_separation_ft || 0;
        if (sep < min)
          add("EXIT-SEP", "Critical", eg, "1007.1.1",
            `Revise exit locations so they are separated by at least ${f0(min)} ft, measured in a straight line between the nearest edges of the exit doors.`,
            `Diagonal ${p.overall_diagonal_ft} ft x ${spr ? "1/3" : "1/2"} = ${f0(min)} ft required; ${sep} ft shown.`);
      }

      const doorW = exits.reduce((t, e) => t + e.door_clear_width_in, 0);
      const reqW = load * 0.2;
      if (exits.length && doorW < reqW)
        add("EGRESS-WIDTH", "Critical", eg, "1005.3.2",
          `Revise exit doors to provide at least ${f0(reqW)} in. of total egress width.`,
          `${load} occupants x 0.2 in. = ${f0(reqW)} in. required; ${doorW} in. provided.`);

      const stair = p.stair_width_in;
      if (stair && (p.stories || 1) > 1) {
        const up = p.upper_floor_occupant_load ?? load;
        const need = up * 0.3;
        if (stair < need)
          add("STAIR-WIDTH", "Critical", eg, "1005.3.1",
            `Revise stair width to provide at least ${f0(need)} in. of egress capacity.`,
            `${up} occupants x 0.3 in. = ${f0(need)} in. required; ${stair} in. provided.`);
      }

      const narrow = exits.filter((e) => e.door_clear_width_in < 32).map((e) => e.id);
      if (narrow.length)
        add("DOOR-WIDTH", "Major", sheet(p, "door_schedule"), "1010.1.1",
          `Revise door(s) ${narrow.join(", ")} to provide a minimum 32 in. clear opening width.`,
          "Clear widths: " + exits.map((e) => `${e.id}=${e.door_clear_width_in} in.`).join(", "));

      const limits = D.travel[p.group_letter || p.occupancy[0]];
      const travel = p.max_travel_distance_ft;
      if (limits && travel) {
        const lim = spr ? limits[1] : limits[0];
        if (travel > lim)
          add("TRAVEL", "Critical", eg, "1017.2",
            `Revise the layout or add an exit so exit access travel distance does not exceed ${lim} ft.`,
            `Longest travel path ${travel} ft; limit ${lim} ft (${spr ? "sprinklered" : "not sprinklered"}).`);
      }

      for (const c of p.corridors || [])
        if (c.occupant_load_served >= 50 && c.width_in < 44)
          add("CORRIDOR", "Major", eg, "1020.3",
            `Revise the ${c.name} to a minimum 44 in. clear width.`,
            `Serves ${c.occupant_load_served} occupants; ${c.width_in} in. shown.`);

      if (p.occupancy === "A-2" && !spr) {
        const reasons = [];
        if ((p.fire_area_sf || 0) > 5000) reasons.push(`fire area ${p.fire_area_sf} sq ft > 5,000`);
        if (load >= 100) reasons.push(`occupant load ${load} >= 100`);
        if (p.at_level_of_exit_discharge === false) reasons.push("not on the level of exit discharge");
        if (reasons.length)
          add("SPRINKLER-A2", "Critical", sheet(p, "code_analysis"), "903.2.1.2",
            "Provide an automatic sprinkler system throughout the fire area, or revise the design so none of the triggers apply.",
            "Triggered by: " + reasons.join("; "), "Fire");
      }

      if (isA && doc.occupant_load_posting === false)
        add("POSTING", "Minor", eg, "1004.3",
          "Provide a note and location for the posted maximum occupant load sign.",
          "No occupant load posting shown for an assembly room.");

      if (needed >= 2 && doc.exit_signs_shown === false)
        add("EXIT-SIGNS", "Major", eg, "1013.1",
          "Provide exit sign locations on the egress plan.",
          `${needed} exits required; no exit signs shown.`);

      const acc = p.accessibility || {};
      if (acc.accessible_route_from_parking === false)
        add("ACCESSIBLE-ROUTE", "Major", sheet(p, "site", "Site plan"), "1104.1",
          "Provide an accessible route from the accessible parking to the accessible building entrance, and show it on the site plan.",
          "No accessible route from parking shown.", "Accessibility");
      if (acc.accessible_restroom === false)
        add("ACCESSIBLE-RESTROOM", "Major", sheet(p, "restrooms", sheet(p, "egress")), "1110.2",
          "Revise the restroom layout so each toilet room provided is accessible, and provide enlarged plans with clearances.",
          "Toilet room provided; no accessible fixtures or clearances shown.", "Accessibility");

      return out;
    }

    // ---------- Stage 2: senior audit ----------
    const LIFE = ["903.", "1005.", "1006.", "1007.", "1017.", "R302.", "R310.", "R311.", "R313.", "R314.", "R315."];
    const DOCS = ["107.2.3", "1004.3"];
    function sectionNumber(c) { const m = /§\s*([A-Z]{0,2}[0-9]+[A-Z]?(?:[.-][0-9]+[A-Z]?)*)/.exec(c || ""); return m ? m[1] : null; }

    // strict=false is document mode: unknown sections are flagged for the reviewer, not blocked.
    function audit(findings, strict = true) {
      const log = [];
      const byKey = new Map();
      for (const f of findings) {
        const n = sectionNumber(f.section);
        if (n === null || (strict && !isKnown(n))) { f.notes.push("UNVERIFIED_CITATION"); log.push(`${f.check_id}: citation '${f.section}' not in reference library`); }
        else if (!isKnown(n)) f.notes.push("VERIFY_CITATION");
        if (n && LIFE.some((p) => n.startsWith(p)) && f.severity !== "Critical") { log.push(`${f.check_id}: severity raised ${f.severity} -> Critical (life safety)`); f.severity = "Critical"; }
        if (DOCS.includes(n) && f.severity === "Critical") { log.push(`${f.check_id}: severity lowered Critical -> Major (documentation item)`); f.severity = "Major"; }
        const key = (n || f.section) + "|" + f.sheet;
        const ex = byKey.get(key);
        if (!ex) { byKey.set(key, f); continue; }
        let keep = ex, drop = f;
        if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(ex.severity)) { keep = f; drop = ex; }
        keep.notes.push(`merged duplicate from ${drop.source}`);
        byKey.set(key, keep);
        log.push(`${drop.check_id} (${drop.source}): merged into ${keep.check_id} (${keep.source})`);
      }
      const rank = (f) => { const i = SEVERITIES.indexOf(f.severity); return i < 0 ? 99 : i; };
      const ordered = [...byKey.values()].sort((a, b) => rank(a) - rank(b) || (a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0));
      return { audited: ordered, log };
    }

    // ---------- Stage 3: QA gate ----------
    const VERBS = ["Provide", "Revise", "Clarify", "Show", "Verify", "Coordinate", "Remove", "Add", "Specify", "Replace", "Correct", "Update",
      "Identify", "Indicate", "Include", "Label", "Dimension", "Detail", "Relocate", "Submit", "Obtain"];
    const HEDGES = ["maybe", "might", "possibly", "perhaps", "consider", "i think", "probably", "it seems"];
    const PRODUCTS = [/[®™]/, /\bmodel\s+[A-Z0-9-]{2,}\b/i, /\b(Simpson|Hilti|USG|Kidde|Tyco|Viking|Hager|Schlage|Von Duprin|Allegion|Owens Corning)\b/];
    const QUANT = ["EXITS-COUNT", "EXIT-SEP", "EGRESS-WIDTH", "STAIR-WIDTH", "TRAVEL", "CORRIDOR"];

    // Returns every rule with pass/fail so the UI can show the full checklist.
    function gateRules(f, strict = true) {
      const text = (f.comment || "").trim();
      const n = sectionNumber(f.section);
      const low = text.toLowerCase();
      const hedges = HEDGES.filter((h) => low.includes(h));
      return [
        { rule: "Valid severity", ok: SEVERITIES.includes(f.severity), why: `severity '${f.severity}' is not one of Critical, Major, Minor` },
        { rule: "Has a code citation", ok: n !== null, why: "missing code citation" },
        ...(strict ? [{ rule: "Citation is in the verified library", ok: n === null || (isKnown(n) && !(f.notes || []).includes("UNVERIFIED_CITATION")), why: `citation §${n} is not in the verified reference library` }] : []),
        { rule: "Has a sheet reference", ok: !!(f.sheet || "").trim(), why: "missing sheet reference" },
        { rule: "Starts with an action", ok: VERBS.some((v) => text.startsWith(v)), why: "comment does not start with an action the applicant can take" },
        { rule: "Length 40-400 characters", ok: text.length >= 40 && text.length <= 400, why: `comment length ${text.length} outside 40-400 characters` },
        { rule: "No hedging words", ok: hedges.length === 0, why: `hedging language: ${hedges.join(", ")}` },
        { rule: "No product or model names", ok: !PRODUCTS.some((r) => r.test(text)), why: "names a product or model instead of a requirement" },
        { rule: "Numbers behind quantitative calls", ok: !QUANT.includes(f.check_id) || /\d/.test(f.evidence || ""), why: "quantitative comment has no supporting numbers" },
      ];
    }
    function check(f, strict = true) {
      // Python reports "missing citation" OR "not in library", never both.
      const rs = gateRules(f, strict);
      return rs.filter((r) => !r.ok).map((r) => r.why);
    }
    function gate(findings, strict = true) {
      const accepted = [], rejected = [];
      for (const f of findings) { const p = check(f, strict); p.length ? rejected.push({ finding: f, problems: p }) : accepted.push(f); }
      return { accepted, rejected };
    }

    // Pre-recorded examples of the mistakes LLM drafts make. Used by the demo's
    // "mix in AI drafts" switch to show the audit and gate catching them.
    function sampleAiDrafts(p) {
      const eg = sheet(p, "egress"), ds = sheet(p, "door_schedule");
      const mk = (o) => Object.assign({ discipline: "Building", source: "ai-draft", notes: [] }, o);
      const narrow = (p.exits || []).some((x) => x.door_clear_width_in < 32);
      return [
        ...(narrow ? [mk({ check_id: "AI-DOOR", severity: "Minor", sheet: ds, section: cite("1010.1.1"),
          comment: "Revise egress doors to provide a minimum 32 in. clear opening width.", evidence: "Door schedule reviewed." })] : []),
        mk({ check_id: "AI-SEPARATION", severity: "Critical", sheet: eg, section: `${D.edition} §1007.9.4`,
          comment: "Revise exit locations to meet the required separation distance.", evidence: "Exits look close together." }),
        mk({ check_id: "AI-HARDWARE", severity: "Major", sheet: ds, section: "",
          comment: "Provide a Von Duprin exit device on the main exit door with panic hardware.", evidence: "" }),
        mk({ check_id: "AI-TRAVEL", severity: "Minor", sheet: eg, section: cite("1017.2"),
          comment: "Revise layout since travel distance might possibly exceed the limit in some areas.", evidence: "" }),
      ];
    }

    function run(p, withAi = false) {
      const drafts = review(JSON.parse(JSON.stringify(p))).concat(withAi ? sampleAiDrafts(p) : []);
      const draftsSnapshot = JSON.parse(JSON.stringify(drafts));
      const { audited, log } = audit(drafts);
      const { accepted, rejected } = gate(audited);
      return { drafts: draftsSnapshot, log, accepted, rejected, load: occupantLoad(p) };
    }

    function evaluate(projects) {
      let tp = 0, fp = 0, fn = 0;
      const rows = projects.map((p) => {
        const r = run(p);
        const exp = new Set(p.expected_findings.map((e) => e.section));
        const pred = new Set(r.accepted.map((f) => sectionNumber(f.section)));
        const hit = [...exp].filter((s) => pred.has(s));
        const extra = [...pred].filter((s) => !exp.has(s));
        const missed = [...exp].filter((s) => !pred.has(s));
        tp += hit.length; fp += extra.length; fn += missed.length;
        return { id: p.id, name: p.name, expected: exp.size, found: hit.length, extra, missed };
      });
      const gc = D.gateCases;
      const bad = gc.should_reject.filter((c) => check({ notes: [], ...c }).length > 0).length;
      const good = gc.should_accept.filter((c) => check({ notes: [], ...c }).length === 0).length;
      return {
        rows, tp, fp, fn,
        precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1,
        gate: { bad, badTotal: gc.should_reject.length, good, goodTotal: gc.should_accept.length },
      };
    }

    function runDocs(raw) {
      const drafts = (raw.comments || []).map((c, i) => ({ check_id: "C" + String(i + 1).padStart(2, "0"), discipline: c.discipline,
        severity: c.severity, sheet: c.sheet, section: c.section, comment: c.comment, evidence: c.basis, source: "claude", notes: [] }));
      const draftsSnapshot = JSON.parse(JSON.stringify(drafts));
      const { audited, log } = audit(drafts, false);
      const { accepted, rejected } = gate(audited, false);
      return { drafts: draftsSnapshot, log, accepted, rejected };
    }

    return { run, runDocs, review, audit, gate, gateRules, check, evaluate, occupantLoad, sectionNumber, cite };
  }

  root.PRC = { make, SEVERITIES };
  if (typeof module !== "undefined") module.exports = root.PRC;
})(typeof window !== "undefined" ? window : globalThis);
