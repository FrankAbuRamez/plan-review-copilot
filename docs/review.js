// Document review: plans and calcs -> Claude -> senior audit -> QA gate -> reviewer edits -> letter.
// Runs entirely in the browser. The API key is sent only to Anthropic.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";
import { buildLetter, letterHtml, letterText, sortItems, roundFrom, SECTIONS, LETTER_CSS } from "./letter.js?v=1792896364";

const D = window.PRC_DATA, E = window.PRC.make(D);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Sonnet is the default: about half the cost of Opus. Opus is there for harder sets.
const MODELS = {
  sonnet: { id: "claude-sonnet-5-5", inPerM: 2, outPerM: 10, effort: "high" },
  opus: { id: "claude-opus-5-5", inPerM: 4, outPerM: 20, effort: "high" },
};
const LIMIT = 32 * 1024 * 1024 * 0.95; // request limit, measured after base64 encoding
const DISC = ["Building", "Fire and Life Safety", "Accessibility", "Structural", "Mechanical", "Electrical", "Plumbing", "Energy", "Green Building"];
const SEV = ["Critical", "Major", "Minor"];
const FINAL_SCHEMA = { type: "object", additionalProperties: false, required: ["verdicts"], properties: { verdicts: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["id", "verdict", "severity", "section", "comment", "reason"],
  properties: { id: { type: "string" }, verdict: { type: "string", enum: ["Confirmed", "Revise", "Drop"] },
    severity: { type: "string", enum: ["Critical", "Major", "Minor"] }, section: { type: "string" }, comment: { type: "string" }, reason: { type: "string" } } } } } };
const FINAL_TASK = `Final check. You drafted the comments below from these documents. Re-check each one against the sheets and the code basis as a senior plans examiner would:
- Confirmed: the issue is real, shown on the cited sheet, and the citation is the right section of the right code.
- Revise: the issue is real but the citation, severity, or wording needs fixing. Return the corrected section ("<code> §<number>"), severity, and comment (40-400 characters, starting with an action, no straight double quotes).
- Drop: the documents do not support it, or it is not a code requirement.
Use Critical only for a deficiency the documents show that affects life safety or structural adequacy. Missing information is Major. Give a one-sentence reason for each verdict. Return every id.`;
let files = [];
let running = false;
let mode = "new"; // "new" or "recheck"
let view = "work"; // "work" (reviewer workspace) or "letter" (the letter as it will be sent)
document.head.insertAdjacentHTML("beforeend", `<style>${LETTER_CSS}</style>`);
// Current review shown on screen; also saved so a refresh doesn't lose it.
let state = null; // { raw, code, modelKey, when, usage, log, items: [{...finding, status, include, problems}] }

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked or full */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
};

// ---------- settings ----------
$("#disc").innerHTML = DISC.map((d) => `<label><input type="checkbox" value="${d}" checked> ${d}</label>`).join("");
$("#code").onchange = () => { $("#code-other").hidden = $("#code").value !== "other"; };
const savedKey = store.get("prc_key");
if (savedKey) { $("#key").value = savedKey; $("#remember").checked = true; }
$("#key").oninput = refresh;
$("#remember").onchange = () => { $("#remember").checked ? store.set("prc_key", $("#key").value) : store.del("prc_key"); };

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#recheck-box").hidden = m !== "recheck";
  $("#disc").hidden = m === "recheck";
  $("#rtype").closest("label").hidden = m === "recheck";
  $("#mode-hint").textContent = m === "recheck" ? "Upload the resubmitted plans and the earlier letter; each item is marked cleared or not, and new issues are flagged." : "Upload plans and calcs; get a correction letter.";
  $("#go").textContent = m === "recheck" ? "Run recheck" : "Generate comments";
  refresh();
}
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#use-last").onclick = () => { if (state) { $("#prev").value = plainLetter(); refresh(); } else { $("#prev").placeholder = "No earlier review saved in this browser. Paste the letter instead."; } };
$("#prev").addEventListener("input", refresh);
const libCount = () => { const n = $("#lib").value.split(/\n/).filter((l) => l.trim().length > 15).length; $("#lib-count").textContent = n ? `${n} standard comments saved` : ""; };
$("#lib").value = store.get("prc_lib") || ""; libCount();
$("#lib").addEventListener("input", () => { store.set("prc_lib", $("#lib").value); libCount(); });

if (store.get("prc_guide") === "hidden") $("#guide").hidden = true;
$("#guide-x").onclick = () => { $("#guide").hidden = true; store.set("prc_guide", "hidden"); };

// ---------- files ----------
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const encoded = () => files.reduce((t, f) => t + Math.ceil(f.size / 3) * 4, 0);
function addFiles(list) {
  for (const f of list) {
    if (/\.(pdf|png|jpe?g)$/i.test(f.name) && !files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
  }
  renderFiles();
}
function renderFiles() {
  $("#flist").innerHTML = files.map((f, i) => `<li>📄<span>${esc(f.name)}</span><small>${mb(f.size)}</small><button data-i="${i}" title="Remove">✕</button></li>`).join("");
  document.querySelectorAll("#flist button").forEach((b) => (b.onclick = () => { files.splice(+b.dataset.i, 1); renderFiles(); }));
  const enc = encoded();
  $("#size").className = "size" + (enc > LIMIT ? " bad" : "");
  $("#size").textContent = !files.length ? "" : enc > LIMIT
    ? `Too large for one review (${mb(enc)} encoded, limit about 30 MB). Split the set or remove sheets outside the scope.`
    : `${files.length} file(s) · ${mb(enc)} of about 30 MB`;
  refresh();
}
function refresh() {
  const needLetter = mode === "recheck" && $("#prev").value.trim().length < 40 && !files.some((f) => /letter|correction|comment/i.test(f.name));
  $("#go").disabled = running || !files.length || !$("#key").value.trim() || encoded() > LIMIT || needLetter;
}
$("#files").onchange = (e) => addFiles(e.target.files);
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

const toBase64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(f);
});

// Same rule as copilot/doc_reviewer.py: show a residential and a building citation.
function exampleCitation(code) {
  const year = code.split(" ")[0];
  if (/California/.test(code)) return `${year} CRC §R310.2.1 for a dwelling, or ${year} CBC §1005.3.2`;
  if (/I-Codes/.test(code)) return `${year} IRC §R310.2.1 for a dwelling, or ${year} IBC §1005.3.2`;
  if (/Florida/.test(code)) return "FBC Residential §R310.2.1 for a dwelling, or FBC Building §1005.3.2";
  return `${code.split("(")[0].trim()} §1005.3.2`;
}

// ---------- high detail: zoomed tiles of the densest sheets ----------
const MAX_TILES = 80;
async function detailTiles(pdfFiles, budgetBytes, note) {
  const lib = await loadPdfJs();
  const pages = [];
  for (const f of pdfFiles) {
    const doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const words = (await page.getTextContent()).items.length;
      pages.push({ f, n, page, words });
    }
  }
  // Densest sheets first: schedules, general notes and energy forms carry the small text.
  const pick = pages.sort((a, b) => b.words - a.words).slice(0, Math.floor(MAX_TILES / 4));
  const blocks = [];
  let used = 0;
  for (const [k, p] of pick.entries()) {
    note(`preparing zoomed tiles ${k + 1}/${pick.length}`);
    const v1 = p.page.getViewport({ scale: 1 });
    const vp = p.page.getViewport({ scale: 2600 / Math.max(v1.width, v1.height) });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await p.page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const names = ["top-left", "top-right", "bottom-left", "bottom-right"];
    for (let t = 0; t < 4; t++) {
      const w = Math.ceil(c.width / 2), h = Math.ceil(c.height / 2);
      const tile = document.createElement("canvas");
      tile.width = w; tile.height = h;
      tile.getContext("2d").drawImage(c, (t % 2) * w, Math.floor(t / 2) * h, w, h, 0, 0, w, h);
      const data = tile.toDataURL("image/jpeg", 0.72).split(",")[1];
      if (used + data.length > budgetBytes) return blocks;
      used += data.length;
      blocks.push({ type: "text", text: `Zoomed tile, ${p.f.name} page ${p.n}, ${names[t]} quarter` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
  }
  return blocks;
}

// ---------- run ----------
function stage(id, n, live = true) { $("#" + id).classList.toggle("live", live); if (n !== undefined) $("#" + id + "n").textContent = n; }
function showErr(msg) { $("#err").hidden = !msg; $("#err").textContent = msg || ""; }
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

async function streamReview(client, params, progress) {
  const attach = (s) => {
    s.on("streamEvent", (ev) => { if (ev.type === "content_block_start" && !progress.locked) progress.phase = ev.content_block.type; });
    s.on("text", (d) => { progress.text += d; });
    return s.finalMessage();
  };
  try {
    return await attach(client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }));
  } catch (e) {
    if (!/fallback/i.test(String(e?.message))) throw e;
    return await attach(client.messages.stream(params)); // retry without the fallback beta
  }
}

async function generate() {
  showErr("");
  const key = $("#key").value.trim();
  if ($("#remember").checked) store.set("prc_key", key);
  const code = $("#code").value === "other" ? ($("#code-other").value.trim() || "2024 I-Codes (IRC for dwellings, IBC for everything else)") : $("#code").value;
  const disciplines = [...document.querySelectorAll("#disc input:checked")].map((i) => i.value);
  if (!disciplines.length) { showErr("Pick at least one discipline."); return; }
  const modelKey = MODELS[$("#model").value] ? $("#model").value : "sonnet";
  const model = MODELS[modelKey];
  const rtype = D.reviewTypes[$("#rtype").value] ? $("#rtype").value : "full";
  const recheck = mode === "recheck";
  const prev = $("#prev").value.trim() || "(The previous letter is one of the uploaded files.)";
  const system = recheck
    ? D.recheckPrompt.replaceAll("{code_basis}", code).replaceAll("{previous_letter}", prev)
    : D.docPrompt.replaceAll("{code_basis}", code).replaceAll("{disciplines}", disciplines.join(", "))
      .replaceAll("{review_type}", D.reviewTypes[rtype])
      .replaceAll("{example_citation}", exampleCitation(code));

  running = true; refresh();
  $("#stages").hidden = false; $("#out").hidden = true;
  ["s1", "s2", "s3"].forEach((s) => stage(s, "–", false));
  stage("s1", "…");
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const progress = { phase: "upload", text: "" };
  const tick = setInterval(() => {
    const n = (progress.text.match(/"(comment|follow_up)"\s*:/g) || []).length;
    const label = progress.phase === "upload" ? `sending ${files.length} file(s)`
      : progress.phase === "final" ? "final check"
      : progress.phase === "tiles" ? (progress.tilesNote || "preparing zoomed tiles")
      : progress.phase === "thinking" ? "reading the sheets and checking the code"
      : `writing comments${n ? ` (${n} so far)` : ""}`;
    $("#s1s").textContent = `${label} · ${secs()}s`;
  }, 500);

  try {
    const content = [];
    for (const f of files) {
      const data = await toBase64(f);
      content.push({ type: "text", text: `File: ${f.name}` });
      content.push(/\.pdf$/i.test(f.name)
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: /\.png$/i.test(f.name) ? "image/png" : "image/jpeg", data } });
    }
    if ($("#detail").checked) {
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
      const budget = LIMIT - encoded() - 200000;
      if (pdfs.length && budget > 1e6) {
        progress.phase = "tiles";
        const tiles = await detailTiles(pdfs, budget, (m) => { progress.tilesNote = m; });
        if (tiles.length) content.push({ type: "text", text: "The zoomed tiles below repeat the densest sheets at higher resolution. Use them to read small text; cite the page number of the original sheet." }, ...tiles);
        progress.phase = "upload";
      }
    }
    if ($("#final").checked && content.length) content[content.length - 1].cache_control = { type: "ephemeral" };
    const notes = $("#notes").value.trim();
    const lib = $("#lib").value.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 15).slice(0, 400);
    if (lib.length) content.push({ type: "text", text: "The reviewer's standard comments are below. When one fits an issue you found, use its wording, adjusted to the project. Do not add a comment just because it is in this list.\n" + lib.map((l) => "- " + l).join("\n") });
    content.push({ type: "text", text: (recheck ? "Recheck this resubmittal against the previous letter." : "Review these documents and draft correction comments.") + (notes ? `\nReviewer notes: ${notes}` : "") });

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, timeout: 20 * 60 * 1000 });
    const msg = await streamReview(client, {
      model: model.id, max_tokens: 64000, system,
      output_config: { effort: model.effort, format: { type: "json_schema", schema: recheck ? D.recheckSchema : D.docSchema } },
      messages: [{ role: "user", content }],
    }, progress);
    clearInterval(tick);
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request. Route this submittal to a human reviewer.");
    if (msg.stop_reason === "max_tokens") throw new Error("The review ran out of room. Try fewer sheets or fewer disciplines at a time.");
    const raw = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    const u = msg.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const usage = { inTok, outTok: u.output_tokens || 0, cost: (inTok * model.inPerM + (u.output_tokens || 0) * model.outPerM) / 1e6, secs: secs() };

    let r = E.runDocs(raw);
    if ($("#final").checked && !recheck) {
      const pick = r.accepted.filter((f) => f.severity === "Critical" || f.notes.includes("VERIFY_CITATION"))
        .concat(r.rejected.map((x) => x.finding));
      if (pick.length) {
        progress.phase = "final"; progress.locked = true; progress.text = "";
        $("#s1s").textContent = `final check on ${pick.length} comments · ${secs()}s`;
        const list = pick.map((f) => ({ id: f.check_id, sheet: f.sheet, section: f.section, severity: f.severity, comment: f.comment, basis: f.evidence }));
        const fin = await streamReview(client, {
          model: model.id, max_tokens: 32000, system,
          output_config: { effort: model.effort, format: { type: "json_schema", schema: FINAL_SCHEMA } },
          messages: [{ role: "user", content: content.concat([{ type: "text", text: FINAL_TASK + "\n\n" + JSON.stringify(list, null, 1) }]) }],
        }, progress);
        const fu = fin.usage || {};
        const fIn = (fu.input_tokens || 0) + (fu.cache_creation_input_tokens || 0);
        usage.cost += (fIn * model.inPerM + (fu.cache_read_input_tokens || 0) * model.inPerM * 0.1 + (fu.output_tokens || 0) * model.outPerM) / 1e6;
        usage.inTok += fIn + (fu.cache_read_input_tokens || 0); usage.outTok += fu.output_tokens || 0; usage.secs = secs();
        if (fin.stop_reason !== "refusal") {
          const verdicts = JSON.parse(fin.content.filter((b) => b.type === "text").map((b) => b.text).join("")).verdicts || [];
          const byId = Object.fromEntries(verdicts.map((v) => [v.id, v]));
          raw.comments = raw.comments.map((c, i) => {
            const v = byId["C" + String(i + 1).padStart(2, "0")];
            if (!v) return c;
            if (v.verdict === "Revise") return { ...c, section: v.section || c.section, severity: v.severity || c.severity, comment: v.comment || c.comment, final: "Revised: " + v.reason };
            if (v.verdict === "Drop") return { ...c, final: "Dropped: " + v.reason, drop: true };
            return { ...c, final: "Confirmed: " + v.reason };
          });
          r = E.runDocs(raw);
          const finalById = Object.fromEntries(raw.comments.map((c, i) => ["C" + String(i + 1).padStart(2, "0"), c]));
          for (const f of r.accepted.concat(r.rejected.map((x) => x.finding))) { const c = finalById[f.check_id]; if (c?.final) { f.final = c.final; f.drop = !!c.drop; } }
        }
      }
    }
    stage("s1", r.drafts.length);
    $("#s1s").textContent = `draft comments · ${usage.secs}s · about $${usage.cost.toFixed(2)}`;
    await pause(350); stage("s2", r.log.length);
    await pause(350); stage("s3", `${r.accepted.length} / ${r.rejected.length}`);
    const rc = recheck ? (raw.recheck || []).map((x) => {
      const open = x.status !== "Cleared" && x.follow_up && x.follow_up.trim();
      const probs = open ? E.check({ check_id: "R" + x.number, discipline: x.discipline, severity: "Major", sheet: x.sheet,
        section: x.section, comment: x.follow_up, evidence: x.evidence, notes: [] }, false) : [];
      return { ...x, include: !!open, problems: probs };
    }) : null;
    const pasted = $("#prev").value.trim();
    state = {
      mode: recheck ? "recheck" : "new", recheck: rc, disciplines, fileOrder: files.map((f) => f.name),
      round: recheck ? (pasted ? roundFrom(pasted) : Math.max(2, raw.review_round || 2)) : 1,
      raw, code, modelKey, usage, when: new Date().toISOString(), log: r.log,
      items: r.accepted.map((f) => f.drop ? { ...f, status: "held", include: false, problems: [f.final] } : { ...f, status: "letter", include: true, problems: [] })
        .concat(r.rejected.map((x) => ({ ...x.finding, status: "held", include: false, problems: x.finding.final ? [x.finding.final, ...x.problems] : x.problems }))),
    };
    view = "work";
    save();
    render();
    $("#out").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    clearInterval(tick);
    stage("s1", "!", false);
    const status = e?.status;
    showErr(status === 401 ? "That API key was rejected. Check it at platform.claude.com/settings/keys."
      : status === 429 ? "Rate limited by the API. Wait a minute and try again."
      : status === 413 ? "The files are too large for one request. Split the plan set."
      : status === 529 ? "Anthropic's API is busy right now. Try again in a few minutes."
      : /credit balance/i.test(String(e?.message)) ? "Your Anthropic API credit balance is too low. Add credits at platform.claude.com/settings/billing, then run it again."
      : (e?.message || String(e)));
  } finally { running = false; refresh(); }
}
$("#go").onclick = generate;

// ---------- reviewer workspace ----------
function save() { if (state) store.set("prc_last", JSON.stringify(state)); }
const meta = () => ({ pc: $("#pc").value.trim(), rv: $("#rv").value.trim(), jx: $("#jx").value.trim() });
["#pc", "#rv", "#jx"].forEach((s) => $(s).addEventListener("input", () => { if (state) { state.meta = meta(); save(); render(); } }));
const discSection = (d) => (SECTIONS.find(([, , list]) => list.includes(d)) || SECTIONS[0]);

// Letter items in letter order (plan-set order within each discipline), including ones switched off.
function letterItems() {
  return sortItems(state.items.map((f, ref) => ({ f, ref, discipline: f.discipline, sheet: f.sheet, file: f.file, page: f.page }))
    .filter((x) => x.f.status === "letter"), state.fileOrder || []);
}

function render() {
  if (!state) return;
  const p = state.raw.project || {};
  const when = new Date(state.when).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const L = buildLetter(state);
  const pc = L.pc;
  let lastSec = "";
  const cards = letterItems().map(({ f, ref: idx }) => {
    const sec = discSection(f.discipline);
    const head = sec[0] !== lastSec ? `<div class="dh">${esc(sec[1])}${state.recheck ? ` · additional ${pc} comments` : ""}</div>` : "";
    lastSec = sec[0];
    const num = f.include ? (L.labels.get(idx) || "") : "–";
    return `${head}<div class="cm ${f.include ? "" : "off"}" data-i="${idx}"><div class="i">${esc(num)}</div><div>
      <div class="chips"><span class="chip ${f.severity}">${f.severity}</span><span class="chip plain">${esc(f.discipline)}</span>
      <span class="chip plain">Sheet ${esc(f.sheet)}</span><span class="chip plain">${esc(f.section)}</span>
      ${f.notes.includes("VERIFY_CITATION") ? '<span class="chip verify" title="Not in the section index; confirm the section exists and applies">verify citation</span>' : ""}
      ${f.final && !f.drop ? `<span class="chip fc" title="${esc(f.final)}">${f.final.startsWith("Revised") ? "✎ revised in final check" : "✓ final check"}</span>` : ""}
      ${f.notes.includes("INDEXED") ? `<span class="chip idx" title="${esc((E.indexLookup(f.section) || ["", ""])[1])}">✓ section</span>` : ""}
      ${f.page > 0 ? `<button class="chip pg" data-pg="${idx}" title="Open the page">📄 p.${f.page}</button>` : ""}</div>
      <div class="t" data-edit="${idx}">${esc(f.comment)}</div><div class="b">Basis: ${esc(f.evidence)}</div>
      <div class="tools"><label><input type="checkbox" data-inc="${idx}" ${f.include ? "checked" : ""}> In letter</label>
        <button data-ed="${idx}">Edit</button><button data-hold="${idx}">Move to held</button></div></div></div>`;
  }).join("");
  const u = state.usage;
  const m = state.meta || {};
  const inc = state.items.filter((i) => i.status === "letter" && i.include);
  const sum = SEV.map((s) => [s, inc.filter((i) => i.severity === s).length]).filter(([, c]) => c)
    .map(([s, c]) => `<span class="${s}">${c} ${s}</span>`).join("");
  const details = [m.jx, m.pc && `Plan check ${m.pc}`, m.rv && `Reviewer ${m.rv}`].filter(Boolean).map(esc).join(" · ");
  const rcHtml = state.recheck ? `<div class="dh">Comments from the previous letter</div>` + state.recheck.map((x, k) => `<div class="rc ${x.status === "Cleared" ? "done" : ""}"><div class="i">${esc(x.number)}</div>
      <span class="rs ${x.status.replace(/[^A-Za-z]/g, "")}">${esc(x.status)}</span><div><div class="o">${esc(x.original)}</div>
      <div class="e">Sheet ${esc(x.sheet)} · ${esc(x.evidence)}</div>
      ${x.status !== "Cleared" ? `<div class="fu"><b>${pc}:</b> <span data-rcedit="${k}">${esc(x.follow_up || "Comment not addressed. Comment remains.")}</span></div>${x.problems.length ? `<small style="color:var(--held)">${esc(x.problems.join("; "))}</small>` : ""}
      <div class="tools"><label><input type="checkbox" data-rcinc="${k}" ${x.include ? "checked" : ""}> In letter</label><button data-rced="${k}">Edit</button>
      ${x.page > 0 ? `<button data-rcpg="${k}">📄 p.${x.page}</button>` : ""}</div>` : ""}</div></div>`).join("") : "";
  const rcSum = state.recheck ? ["Cleared", "Partly cleared", "Not cleared", "Cannot verify"].map((s) => [s, state.recheck.filter((x) => x.status === s).length])
    .filter(([, c]) => c).map(([s, c]) => `<span class="rs ${s.replace(/[^A-Za-z]/g, "")}">${c} ${s}</span>`).join("") : "";
  const tabs = `<div class="vt"><button data-view="work" class="${view === "work" ? "on" : ""}">Review workspace</button><button data-view="letter" class="${view === "letter" ? "on" : ""}">Letter as sent</button></div>`;
  const work = `<div class="lh"><div><h3>Plan Review Comments · ${esc(L.roundWord)}</h3><div>${esc(p.name && p.name !== "Not shown" ? p.name : "Project name not shown on the plans")}</div>${details ? `<div class="lhd">${details}</div>` : ""}</div>
      <div class="m">${when}<br>${esc(p.governing_code || state.code)}</div></div>
    <div class="proj">
      <div><b>Occupancy</b>${esc(p.occupancy)}</div><div><b>Construction</b>${esc(p.construction_type)}</div><div><b>Sprinklered</b>${esc(p.sprinklered)}</div>
      <div><b>Stories</b>${esc(p.stories)}</div><div><b>Area</b>${esc(p.building_area)}</div><div><b>Scope</b>${esc(p.scope)}</div>
    </div>
    <div class="sum">${rcSum}${sum}<span class="plain">${inc.length} ${state.recheck ? "new " : ""}comments</span></div>
    ${rcHtml}
    ${cards || (state.recheck ? "" : '<div class="clean">No comments in the letter. See "Held for human review".</div>')}`;
  $("#letter").innerHTML = tabs + (view === "letter" ? `<div class="sent">${letterHtml(L, esc)}</div>` : work)
    + (u ? `<div class="meta">${MODELS[state.modelKey]?.id || ""} · ${u.secs}s · ${Math.round(u.inTok / 1000)}k tokens in, ${Math.round(u.outTok / 1000)}k out · about $${u.cost.toFixed(2)}</div>` : "");

  const held = state.items.filter((i) => i.status === "held");
  $("#held").innerHTML = held.length ? held.map((f) => {
    const idx = state.items.indexOf(f);
    return `<li><b>${esc(f.sheet)}</b> ${esc(f.comment)}<br><small>${esc(f.problems.join("; ") || "moved here by the reviewer")}</small>
      <div class="tools"><button data-back="${idx}">Move to letter</button></div></li>`;
  }).join("") : '<li class="empty" style="border:0;background:none">Nothing held.</li>';
  const ck = state.raw.checklist || [];
  $("#ck-panel").hidden = !ck.length;
  const cnt = (s) => ck.filter((c) => c.status === s).length;
  $("#cksum").textContent = ck.length ? `${cnt("Complies")} ok · ${cnt("Not shown")} not shown · ${cnt("Noncompliant")} noncompliant` : "";
  const rank = { Noncompliant: 0, "Not shown": 1, Complies: 2, "N/A": 3 };
  $("#ck").innerHTML = ck.length ? [...ck].sort((a, b) => rank[a.status] - rank[b.status]).map((c) =>
    `<li><span class="st ${c.status.replace(/[^A-Za-z]/g, "")}">${esc(c.status)}</span><div><b>${esc(c.item)}</b> · ${esc(c.code)} · ${esc(c.sheet)}<small>${esc(c.note)}</small></div></li>`).join("")
    : '<li class="empty">No checklist returned.</li>';
  const nr = (state.raw.not_reviewed || []).filter((x) => /[A-Za-z]{3}/.test(x));
  $("#nr").innerHTML = nr.length ? nr.map((x) => `<li>${esc(x)}</li>`).join("") : '<li class="empty">Nothing flagged.</li>';
  $("#log").innerHTML = state.log?.length ? state.log.map((l) => `<li>${esc(l)}</li>`).join("") : '<li class="empty">No changes needed.</li>';
  $("#stages").hidden = false;
  $("#out").hidden = false;
  wire();
}

function wire() {
  document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { view = b.dataset.view; render(); }));
  document.querySelectorAll("[data-rcinc]").forEach((c) => (c.onchange = () => { state.recheck[+c.dataset.rcinc].include = c.checked; save(); render(); }));
  document.querySelectorAll("[data-rcpg]").forEach((b) => (b.onclick = () => showPage(state.recheck[+b.dataset.rcpg])));
  document.querySelectorAll("[data-rced]").forEach((b) => (b.onclick = () => {
    const k = +b.dataset.rced, el = document.querySelector(`[data-rcedit="${k}"]`);
    if (el.isContentEditable) { state.recheck[k].follow_up = el.innerText.trim(); el.contentEditable = "false"; save(); render(); }
    else { el.contentEditable = "true"; el.focus(); b.textContent = "Save"; }
  }));
  document.querySelectorAll("[data-pg]").forEach((b) => (b.onclick = () => showPage(state.items[+b.dataset.pg])));
  document.querySelectorAll("[data-inc]").forEach((c) => (c.onchange = () => { state.items[+c.dataset.inc].include = c.checked; save(); render(); }));
  document.querySelectorAll("[data-hold]").forEach((b) => (b.onclick = () => { Object.assign(state.items[+b.dataset.hold], { status: "held", include: false }); save(); render(); }));
  document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => { Object.assign(state.items[+b.dataset.back], { status: "letter", include: true }); save(); render(); }));
  document.querySelectorAll("[data-ed]").forEach((b) => (b.onclick = () => {
    const i = +b.dataset.ed, el = document.querySelector(`[data-edit="${i}"]`);
    if (el.isContentEditable) {
      state.items[i].comment = el.innerText.trim(); el.contentEditable = "false"; b.textContent = "Edit"; save(); render();
    } else { el.contentEditable = "true"; el.focus(); b.textContent = "Save"; }
  }));
}

// ---------- page viewer ----------
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = ok; s.onerror = fail; document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return (pdfjs = window.pdfjsLib);
}
const docCache = new Map();
async function showPage(f) {
  $("#modal").hidden = false;
  $("#modal-t").textContent = `${f.file || ""} · page ${f.page} · Sheet ${f.sheet}`;
  const file = files.find((x) => x.name === f.file) || (files.length === 1 ? files[0] : null);
  if (!file || !/\.pdf$/i.test(file.name)) {
    $("#modal-b").innerHTML = `<p style="padding:20px">Add <b>${esc(f.file || "the plan file")}</b> again in step 1 to view this page.</p>`;
    return;
  }
  $("#modal-b").innerHTML = '<p style="padding:20px">Loading page…</p>';
  try {
    const lib = await loadPdfJs();
    if (!docCache.has(file)) docCache.set(file, lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise);
    const doc = await docCache.get(file);
    const page = await doc.getPage(Math.min(Math.max(1, f.page), doc.numPages));
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2.5, 2400 / v1.width) });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    $("#modal-b").innerHTML = ""; $("#modal-b").appendChild(c);
  } catch (e) { $("#modal-b").innerHTML = `<p style="padding:20px">Could not open the page: ${esc(e.message || e)}</p>`; }
}
$("#modal-x").onclick = () => { $("#modal").hidden = true; };
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

// ---------- export ----------
const plainLetter = () => letterText(buildLetter(state));
function wordLetter() {
  return `<html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}${LETTER_CSS}</style></head><body>${letterHtml(buildLetter(state), esc)}</body></html>`;
}
function download(name, type, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
}
const fileBase = () => ((state.raw.project?.name || "review").replace(/[^\w]+/g, "_").slice(0, 40) || "review");
$("#copy").onclick = async () => {
  try { await navigator.clipboard.writeText(plainLetter()); $("#copy").textContent = "Copied ✓"; setTimeout(() => ($("#copy").textContent = "Copy letter"), 1500); } catch (e) { /* clipboard blocked */ }
};
$("#word").onclick = () => download(fileBase() + "_corrections.doc", "application/msword", wordLetter());
$("#print").onclick = () => { if (view !== "letter") { view = "letter"; render(); } window.print(); };
$("#json").onclick = () => download(fileBase() + "_review.json", "application/json", JSON.stringify(state, null, 2));
$("#clear").onclick = () => { store.del("prc_last"); state = null; $("#out").hidden = true; $("#stages").hidden = true; };

// Restore the last review after a refresh.
try {
  const last = JSON.parse(store.get("prc_last") || "null");
  if (last?.items) { state = last; const m = last.meta || {}; $("#pc").value = m.pc || ""; $("#rv").value = m.rv || ""; $("#jx").value = m.jx || ""; render(); }
} catch (e) { store.del("prc_last"); }
refresh();
