// Document review: plans and calcs -> Claude -> senior audit -> QA gate -> letter.
// Runs entirely in the browser. The API key is sent only to Anthropic.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm";

const D = window.PRC_DATA, E = window.PRC.make(D);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MODEL = "claude-opus-5-5";
const LIMIT = 32 * 1024 * 1024 * 0.95; // request limit, measured after base64 encoding
const DISC = ["Building", "Fire and Life Safety", "Accessibility", "Structural", "Mechanical", "Electrical", "Plumbing", "Energy", "Green Building"];
let files = [];
let lastRaw = null, lastLetter = "";

// ---------- settings ----------
$("#disc").innerHTML = DISC.map((d) => `<label><input type="checkbox" value="${d}" checked> ${d}</label>`).join("");
$("#code").onchange = () => { $("#code-other").hidden = $("#code").value !== "other"; };
try { const k = localStorage.getItem("prc_key"); if (k) { $("#key").value = k; $("#remember").checked = true; } } catch (e) { /* storage blocked */ }
$("#key").oninput = refresh;
$("#remember").onchange = () => {
  try { $("#remember").checked ? localStorage.setItem("prc_key", $("#key").value) : localStorage.removeItem("prc_key"); } catch (e) { /* storage blocked */ }
};

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
function refresh() { $("#go").disabled = !files.length || !$("#key").value.trim() || encoded() > LIMIT; }
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

// ---------- run ----------
function stage(id, n, live = true) { $("#" + id).classList.toggle("live", live); if (n !== undefined) $("#" + id + "n").textContent = n; }
function showErr(msg) { $("#err").hidden = !msg; $("#err").textContent = msg || ""; }
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function streamReview(client, params, onText) {
  try {
    const s = client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    s.on("text", onText);
    return await s.finalMessage();
  } catch (e) {
    if (!/fallback/i.test(String(e?.message))) throw e;
    const s = client.messages.stream(params); // retry without the fallback beta
    s.on("text", onText);
    return await s.finalMessage();
  }
}

async function generate() {
  showErr("");
  const key = $("#key").value.trim();
  if ($("#remember").checked) { try { localStorage.setItem("prc_key", key); } catch (e) { /* storage blocked */ } }
  const code = $("#code").value === "other" ? ($("#code-other").value.trim() || "2024 IBC") : $("#code").value;
  const disciplines = [...document.querySelectorAll("#disc input:checked")].map((i) => i.value);
  if (!disciplines.length) { showErr("Pick at least one discipline."); return; }
  const edition = code.split("(")[0].trim();
  const system = D.docPrompt.replaceAll("{code_basis}", code).replaceAll("{disciplines}", disciplines.join(", "))
    .replaceAll("{example_citation}", `${edition} §1005.3.2`);

  $("#stages").hidden = false; $("#out").hidden = true;
  ["s1", "s2", "s3"].forEach((s) => stage(s, "–", false));
  stage("s1", "…"); $("#go").disabled = true;
  const t0 = Date.now();
  let chars = 0;
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const tick = setInterval(() => {
    $("#s1s").textContent = `reading ${files.length} file(s) · ${secs()}s` + (chars ? ` · writing ${chars.toLocaleString()} chars` : "");
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
    content.push({ type: "text", text: "Review these documents and draft correction comments." + (notes ? `\nReviewer notes: ${notes}` : "") });

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const msg = await streamReview(client, {
      model: MODEL, max_tokens: 64000, system,
      output_config: { effort: "high", format: { type: "json_schema", schema: D.docSchema } },
      messages: [{ role: "user", content }],
    }, (d) => { chars += d.length; });
    clearInterval(tick);
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request. Route this submittal to a human reviewer.");
    if (msg.stop_reason === "max_tokens") throw new Error("The review ran out of room. Try fewer sheets or fewer disciplines at a time.");
    const raw = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    lastRaw = raw;

    const r = E.runDocs(raw);
    stage("s1", r.drafts.length); $("#s1s").textContent = `draft comments · ${secs()}s`;
    await pause(350); stage("s2", r.log.length);
    await pause(350); stage("s3", `${r.accepted.length} / ${r.rejected.length}`);
    render(raw, r, code);
  } catch (e) {
    clearInterval(tick);
    stage("s1", "!", false);
    const status = e?.status;
    showErr(status === 401 ? "That API key was rejected. Check it at console.anthropic.com."
      : status === 429 ? "Rate limited by the API. Wait a minute and try again."
      : status === 413 ? "The files are too large for one request. Split the plan set."
      : (e?.message || String(e)));
  } finally { refresh(); }
}
$("#go").onclick = generate;

// ---------- output ----------
function render(raw, r, code) {
  const p = raw.project || {};
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const comments = r.accepted.map((f, i) => `<div class="cm"><div class="i">${i + 1}</div><div>
      <div class="chips"><span class="chip ${f.severity}">${f.severity}</span><span class="chip plain">${esc(f.discipline)}</span>
      <span class="chip plain">Sheet ${esc(f.sheet)}</span><span class="chip plain">${esc(f.section)}</span>
      ${f.notes.includes("VERIFY_CITATION") ? '<span class="chip verify">verify citation</span>' : ""}</div>
      <div class="t">${esc(f.comment)}</div><div class="b">Basis: ${esc(f.evidence)}</div></div></div>`).join("");
  $("#letter").innerHTML = `<div class="lh"><div><h3>Plan Review Corrections</h3><div>${esc(p.name)}</div></div>
      <div class="m">${today}<br>${esc(code)}</div></div>
    <div class="proj">
      <div><b>Occupancy</b>${esc(p.occupancy)}</div><div><b>Construction</b>${esc(p.construction_type)}</div><div><b>Sprinklered</b>${esc(p.sprinklered)}</div>
      <div><b>Stories</b>${esc(p.stories)}</div><div><b>Area</b>${esc(p.building_area)}</div><div><b>Scope</b>${esc(p.scope)}</div>
    </div>
    ${comments || '<div class="clean">No comments passed the gate. See "Held for human review".</div>'}`;
  $("#held").innerHTML = r.rejected.length
    ? r.rejected.map((x) => `<li><b>${esc(x.finding.sheet)}</b> ${esc(x.finding.comment)}<br><small>${esc(x.problems.join("; "))}</small></li>`).join("")
    : '<li class="empty" style="border:0;background:none">Nothing held.</li>';
  $("#nr").innerHTML = (raw.not_reviewed || []).length ? raw.not_reviewed.map((x) => `<li>${esc(x)}</li>`).join("") : '<li class="empty">Nothing flagged.</li>';
  $("#log").innerHTML = r.log.length ? r.log.map((l) => `<li>${esc(l)}</li>`).join("") : '<li class="empty">No changes needed.</li>';
  lastLetter = ["PLAN REVIEW CORRECTIONS", p.name || "", `${code} · ${today}`, ""]
    .concat(r.accepted.map((f, i) => `${i + 1}. [${f.severity}] ${f.discipline} · Sheet ${f.sheet} · ${f.section}\n   ${f.comment}`)).join("\n");
  $("#out").hidden = false;
  $("#out").scrollIntoView({ behavior: "smooth" });
}
$("#copy").onclick = async () => {
  try { await navigator.clipboard.writeText(lastLetter); $("#copy").textContent = "Copied ✓"; setTimeout(() => ($("#copy").textContent = "Copy letter"), 1500); } catch (e) { /* clipboard blocked */ }
};
$("#print").onclick = () => window.print();
$("#json").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(lastRaw, null, 2)], { type: "application/json" }));
  a.download = "review.json";
  a.click();
};
refresh();
