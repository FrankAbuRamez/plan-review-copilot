// Document review: plans and calcs -> Claude -> senior audit -> QA gate -> reviewer edits -> letter.
// Runs entirely in the browser. The API key is sent only to Anthropic.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";

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
const DISC_ORDER = ["General", "Building", "Fire and Life Safety", "Accessibility", "Structural", "Site and Civil", "Mechanical", "Plumbing", "Electrical", "Energy", "Green Building"];
const SEV = ["Critical", "Major", "Minor"];
let files = [];
let running = false;
let mode = "new"; // "new" or "recheck"
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
$("#use-last").onclick = () => { if (state && state.mode !== "recheck") { $("#prev").value = plainLetter(); refresh(); } else { $("#prev").placeholder = "No earlier review saved in this browser. Paste the letter instead."; } };
$("#prev").addEventListener("input", refresh);
const libCount = () => { const n = $("#lib").value.split(/\n/).filter((l) => l.trim().length > 15).length; $("#lib-count").textContent = n ? `${n} standard comments saved` : ""; };
$("#lib").value = store.get("prc_lib") || ""; libCount();
$("#lib").addEventListener("input", () => { store.set("prc_lib", $("#lib").value); libCount(); });

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

// ---------- run ----------
function stage(id, n, live = true) { $("#" + id).classList.toggle("live", live); if (n !== undefined) $("#" + id + "n").textContent = n; }
function showErr(msg) { $("#err").hidden = !msg; $("#err").textContent = msg || ""; }
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });

async function streamReview(client, params, progress) {
  const attach = (s) => {
    s.on("streamEvent", (ev) => { if (ev.type === "content_block_start") progress.phase = ev.content_block.type; });
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

    const r = E.runDocs(raw);
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
    state = {
      mode: recheck ? "recheck" : "new", recheck: rc,
      raw, code, modelKey, usage, when: new Date().toISOString(), log: r.log,
      items: r.accepted.map((f) => ({ ...f, status: "letter", include: true, problems: [] }))
        .concat(r.rejected.map((x) => ({ ...x.finding, status: "held", include: false, problems: x.problems }))),
    };
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
      : (e?.message || String(e)));
  } finally { running = false; refresh(); }
}
$("#go").onclick = generate;

// ---------- reviewer workspace ----------
function save() { if (state) store.set("prc_last", JSON.stringify(state)); }
const meta = () => ({ pc: $("#pc").value.trim(), rv: $("#rv").value.trim(), jx: $("#jx").value.trim() });
["#pc", "#rv", "#jx"].forEach((s) => $(s).addEventListener("input", () => { if (state) { state.meta = meta(); save(); render(); } }));
const order = (a, b) => (DISC_ORDER.indexOf(a.discipline) + 1 || 99) - (DISC_ORDER.indexOf(b.discipline) + 1 || 99)
  || SEV.indexOf(a.severity) - SEV.indexOf(b.severity);

function letterItems() {
  const items = state.items.filter((i) => i.status === "letter");
  return $("#group").checked ? [...items].sort(order) : items;
}

function render() {
  if (!state) return;
  const p = state.raw.project || {};
  const when = new Date(state.when).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const items = letterItems();
  let n = 0, lastDisc = "";
  const cards = items.map((f) => {
    const idx = state.items.indexOf(f);
    const head = $("#group").checked && f.discipline !== lastDisc ? `<div class="dh">${esc(f.discipline)}</div>` : "";
    lastDisc = f.discipline;
    const num = f.include ? ++n : "–";
    return `${head}<div class="cm ${f.include ? "" : "off"}" data-i="${idx}"><div class="i">${num}</div><div>
      <div class="chips"><span class="chip ${f.severity}">${f.severity}</span><span class="chip plain">${esc(f.discipline)}</span>
      <span class="chip plain">Sheet ${esc(f.sheet)}</span><span class="chip plain">${esc(f.section)}</span>
      ${f.notes.includes("VERIFY_CITATION") ? '<span class="chip verify" title="Not in the section index; confirm the section exists and applies">verify citation</span>' : ""}
      ${f.notes.includes("INDEXED") ? `<span class="chip idx" title="${esc((E.indexLookup(f.section) || ["", ""])[1])}">✓ section</span>` : ""}
      ${f.page > 0 ? `<button class="chip pg" data-pg="${idx}" title="Open the page">📄 p.${f.page}</button>` : ""}</div>
      <div class="t" data-edit="${idx}">${esc(f.comment)}</div><div class="b">Basis: ${esc(f.evidence)}</div>
      <div class="tools"><label><input type="checkbox" data-inc="${idx}" ${f.include ? "checked" : ""}> In letter</label>
        <button data-ed="${idx}">Edit</button><button data-hold="${idx}">Move to held</button></div></div></div>`;
  }).join("");
  const u = state.usage;
  const m = state.meta || {};
  const inc = items.filter((i) => i.include);
  const sum = SEV.map((s) => [s, inc.filter((i) => i.severity === s).length]).filter(([, c]) => c)
    .map(([s, c]) => `<span class="${s}">${c} ${s}</span>`).join("");
  const details = [m.jx, m.pc && `Plan check ${m.pc}`, m.rv && `Reviewer ${m.rv}`].filter(Boolean).map(esc).join(" · ");
  const rcHtml = state.recheck ? `<div class="dh">Previous comments</div>` + state.recheck.map((x, k) => `<div class="rc"><div class="i">${x.number}</div>
      <span class="rs ${x.status.replace(/[^A-Za-z]/g, "")}">${esc(x.status)}</span><div><div class="o">${esc(x.original)}</div>
      <div class="e">Sheet ${esc(x.sheet)} · ${esc(x.evidence)}</div>
      ${x.follow_up ? `<div class="fu" data-rcedit="${k}">${esc(x.follow_up)}</div>${x.problems.length ? `<small style="color:var(--held)">${esc(x.problems.join("; "))}</small>` : ""}
      <div class="tools"><label><input type="checkbox" data-rcinc="${k}" ${x.include ? "checked" : ""}> In letter</label><button data-rced="${k}">Edit</button>
      ${x.page > 0 ? `<button data-rcpg="${k}">📄 p.${x.page}</button>` : ""}</div>` : ""}</div></div>`).join("") + `<div class="dh">New comments</div>` : "";
  const rcSum = state.recheck ? ["Cleared", "Partly cleared", "Not cleared", "Cannot verify"].map((s) => [s, state.recheck.filter((x) => x.status === s).length])
    .filter(([, c]) => c).map(([s, c]) => `<span class="rs ${s.replace(/[^A-Za-z]/g, "")}">${c} ${s}</span>`).join("") : "";
  $("#letter").innerHTML = `<div class="lh"><div><h3>Plan Review Corrections${state.recheck ? " · Recheck" : ""}</h3><div>${esc(p.name && p.name !== "Not shown" ? p.name : "Project name not shown on the plans")}</div>${details ? `<div class="lhd">${details}</div>` : ""}</div>
      <div class="m">${when}<br>${esc(p.governing_code || state.code)}</div></div>
    <div class="proj">
      <div><b>Occupancy</b>${esc(p.occupancy)}</div><div><b>Construction</b>${esc(p.construction_type)}</div><div><b>Sprinklered</b>${esc(p.sprinklered)}</div>
      <div><b>Stories</b>${esc(p.stories)}</div><div><b>Area</b>${esc(p.building_area)}</div><div><b>Scope</b>${esc(p.scope)}</div>
    </div>
    <div class="sum">${rcSum}${sum}<span class="plain">${inc.length} ${state.recheck ? "new " : ""}comments</span></div>
    ${rcHtml}
    ${cards || '<div class="clean">No comments in the letter. See "Held for human review".</div>'}
    ${u ? `<div class="meta">${MODELS[state.modelKey]?.id || ""} · ${u.secs}s · ${Math.round(u.inTok / 1000)}k tokens in, ${Math.round(u.outTok / 1000)}k out · about $${u.cost.toFixed(2)}</div>` : ""}`;

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
$("#group").onchange = render;

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
function plainLetter() {
  const p = state.raw.project || {};
  const m = state.meta || {};
  const lines = ["PLAN REVIEW CORRECTIONS", p.name || "", m.jx || "", m.pc ? `Plan check ${m.pc}` : "", m.rv ? `Reviewer ${m.rv}` : "",
    `${p.governing_code || state.code}`, new Date(state.when).toLocaleDateString(), ""].filter((x, i) => x || i === 7);
  if (state.recheck) {
    lines.push("PREVIOUS COMMENTS NOT CLEARED");
    for (const x of state.recheck.filter((r) => r.include)) lines.push(`${x.number}. [${x.status}] Sheet ${x.sheet}`, `   ${x.follow_up}`);
    lines.push("", "NEW COMMENTS");
  }
  let n = 0, last = "";
  for (const f of letterItems().filter((i) => i.include)) {
    if ($("#group").checked && f.discipline !== last) { lines.push("", f.discipline.toUpperCase()); last = f.discipline; }
    lines.push(`${++n}. [${f.severity}] Sheet ${f.sheet} · ${f.section}`, `   ${f.comment}`);
  }
  return lines.join("\n");
}
function wordLetter() {
  const p = state.raw.project || {};
  let n = 0, last = "", body = "";
  if (state.recheck) {
    body += "<h3>Previous comments not cleared</h3>";
    for (const x of state.recheck.filter((r) => r.include)) body += `<p><b>${x.number}. Sheet ${esc(x.sheet)}</b> <i>(${esc(x.status)})</i><br>${esc(x.follow_up)}</p>`;
    body += "<h3>New comments</h3>";
  }
  for (const f of letterItems().filter((i) => i.include)) {
    if ($("#group").checked && f.discipline !== last) { body += `<h3>${esc(f.discipline)}</h3>`; last = f.discipline; }
    body += `<p><b>${++n}. Sheet ${esc(f.sheet)} · ${esc(f.section)}</b> <i>(${f.severity})</i><br>${esc(f.comment)}</p>`;
  }
  return `<html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1{font-size:16pt}h3{font-size:12pt;margin-top:14pt;border-bottom:1px solid #999}</style></head>
    <body><h1>Plan Review Corrections</h1><p><b>${esc(p.name)}</b><br>${[state.meta?.jx, state.meta?.pc && `Plan check ${state.meta.pc}`, state.meta?.rv && `Reviewer ${state.meta.rv}`].filter(Boolean).map(esc).join("<br>")}${state.meta?.jx || state.meta?.pc || state.meta?.rv ? "<br>" : ""}${esc(p.governing_code || state.code)}<br>${new Date(state.when).toLocaleDateString()}</p>
    <p>Occupancy ${esc(p.occupancy)} · Construction ${esc(p.construction_type)} · Sprinklered ${esc(p.sprinklered)} · ${esc(p.stories)} story · ${esc(p.building_area)}</p>${body}</body></html>`;
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
$("#print").onclick = () => window.print();
$("#json").onclick = () => download(fileBase() + "_review.json", "application/json", JSON.stringify(state, null, 2));
$("#clear").onclick = () => { store.del("prc_last"); state = null; $("#out").hidden = true; $("#stages").hidden = true; };

// Restore the last review after a refresh.
try {
  const last = JSON.parse(store.get("prc_last") || "null");
  if (last?.items) { state = last; const m = last.meta || {}; $("#pc").value = m.pc || ""; $("#rv").value = m.rv || ""; $("#jx").value = m.jx || ""; render(); }
} catch (e) { store.del("prc_last"); }
refresh();
