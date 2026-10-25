// Builds the correction letter in the format plans examiners send:
// discipline sections numbered A1, S1..., comments grouped by sheet in plan-set order,
// the code citation at the end of each comment, "No comments." for a clean discipline,
// and on a recheck the open comments carried forward with their original numbers and a PCn note.

export const SECTIONS = [
  ["A", "Architectural", ["General", "Building", "Fire and Life Safety"]],
  ["C", "Site and Civil", ["Site and Civil"]],
  ["D", "Accessibility", ["Accessibility"]],
  ["M", "Mechanical", ["Mechanical"]],
  ["E", "Electrical", ["Electrical"]],
  ["P", "Plumbing", ["Plumbing"]],
  ["G", "Green Building", ["Green Building"]],
  ["T", "Energy Compliance", ["Energy"]],
  ["S", "Structural", ["Structural"]],
];
const ROUND = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const sectionKey = (disc) => (SECTIONS.find(([, , d]) => d.includes(disc)) || SECTIONS[0])[0];
const sectionIndex = (key) => SECTIONS.findIndex(([k]) => k === key);

// "2025 CRC §R311.3" -> "CRC R311.3"
export function cite(section) {
  return String(section || "").replace(/(^|[;,]\s*)\d{4}\s+(?=[A-Z])/g, "$1").replace(/§\s*/g, "").replace(/\s+/g, " ").trim();
}

// Comment text with the citation at the end, unless the comment already names that section.
export function withCite(comment, section) {
  const text = String(comment || "").trim();
  const c = cite(section);
  if (!c) return text;
  const num = (c.match(/[A-Z]{0,3}-?\d[\w.()-]*/) || [])[0];
  if (num && text.includes(num.replace(/[.)]+$/, ""))) return text;
  return text.replace(/[.\s]*$/, ".") + " " + c.replace(/\.$/, "") + ".";
}

// Next review round from the previous letter's notes: no PC notes -> 2, "PC2:" -> 3.
export function roundFrom(text) {
  let max = 1, m;
  const re = /\bPC\s*(\d)\s*:/gi;
  while ((m = re.exec(String(text || "")))) max = Math.max(max, +m[1]);
  return max + 1;
}

const isCalc = (sheet) => /calc/i.test(sheet || "");
function sheetKey(f) {
  const s = String(f.sheet || "").trim();
  if (!s || /^(general|n\/?a|all|various)$/i.test(s) || /whole set|plan set/i.test(s)) return "";
  if (isCalc(s)) return "calcs";
  return s.toUpperCase().replace(/\s+/g, " ");
}
const sheetLabel = (sheet) => (/[,&]|\band\b/i.test(sheet) ? "Sheets " : "Sheet ") + sheet.trim();
const calcPage = (sheet) => { const m = String(sheet).match(/p(?:age|g|\.)?\s*(\d+)/i); return m ? `Page ${m[1]}` : ""; };

// Plan-set order: whole-set items first, then by file and page, calculations last.
export function sortItems(items, fileOrder = []) {
  const fileRank = (f) => { const i = fileOrder.indexOf(f.file); return i < 0 ? 99 : i; };
  const rank = (f) => { const k = sheetKey(f); return k === "" ? 0 : k === "calcs" ? 2 : 1; };
  return [...items].sort((a, b) =>
    sectionIndex(sectionKey(a.discipline)) - sectionIndex(sectionKey(b.discipline))
    || rank(a) - rank(b) || fileRank(a) - fileRank(b) || (a.page || 0) - (b.page || 0)
    || String(a.sheet).localeCompare(String(b.sheet), undefined, { numeric: true }));
}

// Turn sorted comments of one section into numbered letter items: one item per sheet
// (in order of the sheet's first appearance), and one item per whole-set comment.
function numberSection(list, prefix, start, labels) {
  const groups = [], byKey = new Map();
  for (const g of list) {
    const key = sheetKey(g.f);
    if (!key) { groups.push([g]); continue; }
    if (!byKey.has(key)) { byKey.set(key, []); groups.push(byKey.get(key)); }
    byKey.get(key).push(g);
  }
  const out = [];
  let n = start;
  for (const group of groups) {
    const key = sheetKey(group[0].f);
    const num = prefix + n++;
    if (group.length === 1) {
      const g = group[0];
      const lead = key === "calcs" ? `Structural calculations${calcPage(g.f.sheet) ? ", " + calcPage(g.f.sheet).toLowerCase() : ""} – ` : key ? `${sheetLabel(g.f.sheet)} – ` : "";
      out.push({ num, text: lead + withCite(g.f.comment, g.f.section), ref: g.ref, subs: [] });
      labels.set(g.ref, num);
    } else {
      const header = key === "calcs" ? "Structural calculations, please address the following:" : `${sheetLabel(group[0].f.sheet)}, please address the following:`;
      const subs = group.map((g, k) => {
        const label = LETTERS[k] || String(k + 1);
        labels.set(g.ref, `${num}.${label}`);
        const lead = key === "calcs" && calcPage(g.f.sheet) ? calcPage(g.f.sheet) + " – " : "";
        return { label, text: lead + withCite(g.f.comment, g.f.section), ref: g.ref };
      });
      out.push({ num, header, subs });
    }
  }
  return out;
}

export function buildLetter(state, fileOrder = state.fileOrder || []) {
  const p = (state.raw && state.raw.project) || {};
  const recheck = !!state.recheck;
  const round = recheck ? Math.max(2, state.round || 2) : 1;
  const pc = "PC" + round;
  const labels = new Map();
  const sections = SECTIONS.map(([key, name]) => ({ key, name, items: [], added: [], present: false }));
  const byKey = (k) => sections.find((s) => s.key === k);
  const highest = {};

  if (recheck) {
    state.recheck.forEach((x, k) => {
      const num = String(x.number).trim();
      const parent = num.split(/[.\s(]/)[0] || num;
      const pre = (parent.match(/^([A-Z])\d/) || [])[1];
      const sec = (pre && byKey(pre)) || byKey(sectionKey(x.discipline));
      sec.present = true;
      const digits = (parent.match(/(\d+)/) || [])[1];
      if (digits) highest[sec.key] = Math.max(highest[sec.key] || 0, +digits);
      if (x.status === "Cleared" || !x.include) return;
      const note = `${pc}: ${String(x.follow_up || "").trim() || "Comment not addressed. Comment remains."}`;
      const sub = num.slice(parent.length).replace(/^[.\s(]+|\)$/g, "");
      let item = sec.items.find((it) => it.num === parent);
      if (!item) { item = { num: parent, carried: true, header: "", text: "", notes: [], subs: [] }; sec.items.push(item); }
      // The model sometimes copies the number or letter label into the text; the letter adds its own.
      const original = String(x.original || "").replace(/^\s*(?:[A-Z]{0,2}\d+(?:\.[a-z0-9]+)*\.?|\(?[a-z]{1,4}\))\s+/i, "");
      if (sub) {
        if (!item.header) item.header = String(x.group_header || "").trim().replace(/^\s*[A-Z]{0,2}\d+\.\s+/, "");
        item.subs.push({ label: sub.split(".").pop(), text: original, notes: [note], rc: k });
      } else { item.text = original; item.notes.push(note); item.rc = k; }
      labels.set("rc" + k, num);
    });
  }

  const items = sortItems((state.items || []).map((f, ref) => ({ ...f, ref })).filter((f) => f.status === "letter" && f.include), fileOrder);
  for (const s of sections) {
    const list = items.filter((f) => sectionKey(f.discipline) === s.key).map((f) => ({ f, ref: f.ref }));
    if (!list.length) continue;
    s.present = true;
    const numbered = numberSection(list, s.key, (highest[s.key] || 0) + 1, labels);
    if (recheck) s.added = numbered; else s.items = numbered;
  }
  if (!recheck) {
    const chosen = state.disciplines || [];
    for (const s of sections) if (s.key === "A" || SECTIONS[sectionIndex(s.key)][2].some((d) => chosen.includes(d))) s.present = true;
  }
  const open = sections.some((s) => s.items.length || s.added.length);
  return {
    recheck, round, pc, roundWord: (ROUND[round] || `Round ${round}`) + " review",
    final: recheck && !open, project: p, meta: state.meta || {}, code: p.governing_code || state.code || "",
    basis: state.code || "", when: state.when, sections: sections.filter((s) => s.present), labels,
  };
}

const generalInfo = (L) => {
  const ca = /California/i.test(L.basis + " " + L.code);
  return [
    `These comments are based on the ${(L.basis || L.code).replace(/\s*\(.*\)\s*$/, "")}${L.meta.jx ? ", with the local amendments adopted by " + L.meta.jx : ""}.`,
    "Other divisions and departments may send their own comments. This list covers the building review only.",
    "Respond to each comment in writing, on this list or in a response letter, and say which sheet, detail or calculation page shows the change. Cloud every revision on the plans.",
    `The architect or engineer in responsible charge must stamp and sign every sheet and the cover of the calculations${ca ? " (Business and Professions Code 5536.1 and 6735)" : ", as the state licensing law requires"}. This is checked before approval.`,
    L.meta.rv ? `For questions about these comments, contact ${L.meta.rv}.` : "For questions about these comments, contact the plan reviewer.",
  ];
};
const docLine = (d) => [d.type, d.date && d.date !== "Not shown" ? `dated ${d.date}` : "", d.prepared_by && d.prepared_by !== "Not shown" ? `by ${d.prepared_by}` : ""].filter(Boolean).join(", ");
const dateText = (when) => new Date(when || Date.now()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const shown = (v) => (v && v !== "Not shown" ? v : "Not shown on the plans");

export function letterText(L) {
  const p = L.project, m = L.meta, out = [];
  out.push("PLAN REVIEW COMMENTS", L.roundWord, dateText(L.when));
  if (m.jx) out.push(`Jurisdiction: ${m.jx}`);
  if (m.pc) out.push(`Plan check no.: ${m.pc}`);
  out.push(`Project: ${shown(p.name)}`, `Scope: ${shown(p.scope)}`, `Code basis: ${L.code}`, "");
  if ((p.documents || []).length) { out.push("DOCUMENTS REVIEWED"); p.documents.forEach((d, i) => out.push(`${i + 1}. ${docLine(d)}`)); out.push(""); }
  out.push("BUILDING SUMMARY", `Occupancy: ${shown(p.occupancy)}`, `Construction type: ${shown(p.construction_type)}`, `Sprinklers: ${shown(p.sprinklered)}`,
    `Stories: ${shown(p.stories)}`, `Area of work: ${shown(p.building_area)}`, "");
  if (L.final) {
    out.push("All comments from the previous review have been addressed. The review is complete and there are no further comments.", "");
  } else {
    out.push("GENERAL INFORMATION"); generalInfo(L).forEach((t, i) => out.push(`${"ABCDE"[i]}. ${t}`)); out.push("");
    for (const s of L.sections) {
      out.push(`${s.name.toUpperCase()} COMMENTS`);
      if (!s.items.length && !s.added.length) out.push("No comments.");
      const put = (it) => {
        const lines = String(it.header || it.text).split("\n");
        out.push(`${it.num}. ${lines[0]}`, ...lines.slice(1).map((l) => "   " + l));
        if (it.header && it.text) out.push("   " + it.text);
        (it.notes || []).forEach((n) => out.push("   " + n));
        for (const sub of it.subs) {
          const sl = String(sub.text).split("\n");
          out.push(`   ${sub.label}) ${sl[0]}`, ...sl.slice(1).map((l) => "      " + l));
          (sub.notes || []).forEach((n) => out.push("      " + n));
        }
      };
      s.items.forEach(put);
      if (s.added.length) { out.push(`Additional ${L.pc} comments`); s.added.forEach(put); }
      out.push("");
    }
  }
  out.push(m.rv ? `Reviewed by: ${m.rv}` : "", "[END]");
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function letterHtml(L, esc) {
  const p = L.project, m = L.meta;
  const lines = (t) => String(t || "").split("\n").map((l) => /^PC\d\s*:/i.test(l.trim()) ? `<div class="xn">${esc(l.trim())}</div>` : esc(l)).join("<br>").replace(/<br><div/g, "<div");
  const note = (n) => `<div class="xn">${esc(n)}</div>`;
  const item = (it) => `<div class="xi"><b>${esc(it.num)}.</b> <span>${lines(it.header || it.text)}${it.header && it.text ? "<br>" + lines(it.text) : ""}${(it.notes || []).map(note).join("")}${
    it.subs.map((s) => `<div class="xs"><b>${esc(s.label)})</b> <span>${lines(s.text)}${(s.notes || []).map(note).join("")}</span></div>`).join("")}</span></div>`;
  const head = [["Review", L.roundWord], ["Jurisdiction", m.jx], ["Plan check no.", m.pc], ["Project", shown(p.name)], ["Scope", shown(p.scope)], ["Code basis", L.code]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("");
  const sum = [["Occupancy", p.occupancy], ["Construction type", p.construction_type], ["Sprinklers", p.sprinklered], ["Stories", p.stories], ["Area of work", p.building_area]]
    .map(([k, v]) => `<tr><th>${k}</th><td>${esc(shown(v))}</td></tr>`).join("");
  const docs = (p.documents || []).length ? `<h4>Documents reviewed</h4><ol>${p.documents.map((d) => `<li>${esc(docLine(d))}</li>`).join("")}</ol>` : "";
  const body = L.final
    ? "<p><b>All comments from the previous review have been addressed. The review is complete and there are no further comments.</b></p>"
    : `<h4>General information</h4><ol type="A">${generalInfo(L).map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` + L.sections.map((s) =>
      `<h4>${esc(s.name)} comments</h4>` + (!s.items.length && !s.added.length ? "<p>No comments.</p>" : "")
      + s.items.map(item).join("") + (s.added.length ? `<p class="xa">Additional ${L.pc} comments</p>` + s.added.map(item).join("") : "")).join("");
  return `<div class="xl"><div class="xt">Plan Review Comments</div><div class="xd">${esc(dateText(L.when))}</div>
    <table class="xh">${head}</table>${docs}<h4>Building summary</h4><table class="xh">${sum}</table>${body}
    <p class="xe">${m.rv ? "Reviewed by " + esc(m.rv) + "<br>" : ""}[END]</p></div>`;
}

export const LETTER_CSS = `.xl{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.45}.xl .xt{font-size:15pt;font-weight:700}.xl .xd{margin-bottom:8px}
.xl h4{font-size:11pt;text-transform:uppercase;margin:14pt 0 4pt;border-bottom:1px solid #999}.xl table.xh{border-collapse:collapse;width:auto}
.xl .xh th,.xl .xh td{border:0;font-size:11pt;color:inherit;text-transform:none;letter-spacing:0;vertical-align:top}.xl .xh th{text-align:left;padding:1px 18px 1px 0;font-weight:600;white-space:nowrap}
.xl .xh td{padding:1px 0}.xl .xi{margin:6pt 0}.xl .xs{margin:3pt 0 3pt 22pt}.xl .xn{font-style:italic;margin:2pt 0 0 0}.xl .xa{font-weight:700;margin:8pt 0 2pt}.xl .xe{margin-top:14pt}`;
