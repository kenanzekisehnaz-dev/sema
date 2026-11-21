// Saha Şema Okuyucu
// Veriyi tools/extract.py üretir: data/index.json + her sayfa için page-N.svg ve page-N.json.
// Telefona kurulan sürümde (tools/build_site.py) aynı dosyalar şifreli durur: page-N.svg.bin gibi.
"use strict";

const $ = (s) => document.querySelector(s);
const viewer = $("#viewer"), statusEl = $("#status"), sheet = $("#sheet");
const docSel = $("#docSel"), pageSel = $("#pageSel"), q = $("#q"), chips = $("#chips");

const S = {
  index: null, doc: null, pages: {}, // pages[n] = page-N.json içeriği
  n: null, svg: null, ov: null,
  vb: null,   // çizilmiş (kesin) görünüm
  live: null, // hareket sırasında anlık görünüm
  active: new Set(), // seçili devre renkleri
};
const svgCache = new Map();

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- Veri okuma ve şifre ----------
   Kurulan uygulamada şemalar şifreli saklanır (herkese açık bir adreste durdukları için).
   Şifre bir kez girilir; ondan türetilen anahtar veriyi açan asıl anahtarı çözer ve bu cihazda saklanır. */

const DATA = { enc: false, key: null };
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => btoa(String.fromCharCode(...u));

async function decryptBytes(key, buf) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
}
async function getText(path) {
  if (!DATA.enc) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(path);
    return r.text();
  }
  const r = await fetch(path + ".bin");
  if (!r.ok) throw new Error(path);
  const plain = await decryptBytes(DATA.key, new Uint8Array(await r.arrayBuffer()));
  // Dosyalar şifrelenmeden önce sıkıştırıldı (1,7 MB'lık şema ~400 KB'a iner)
  return new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
const getJSON = async (path) => JSON.parse(await getText(path));

const importKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);

async function unlock() {
  let meta = null;
  try { const r = await fetch("key.json", { cache: "no-store" }); if (r.ok) meta = await r.json(); } catch {}
  if (!meta) return; // şifresiz sürüm (geliştirme ya da claude.ai)
  DATA.enc = true;
  if (!crypto.subtle) {
    statusEl.textContent = "Bu adres güvenli değil (https değil). Uygulamayı https ile başlayan adresinden açın.";
    await new Promise(() => {});
  }

  const saved = store.get("dk");
  if (saved) {
    try { DATA.key = await importKey(b64d(saved)); await getText("data/index.json"); return; } catch { DATA.key = null; }
  }
  const lock = $("#lock"), err = $("#lockErr"), pw = $("#pw");
  lock.hidden = false; statusEl.hidden = true;
  await new Promise((done) => {
    $("#lockForm").onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw.value), "PBKDF2", false, ["deriveKey"]);
        const kek = await crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64d(meta.salt), iterations: meta.iter, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        const raw = new Uint8Array(await decryptBytes(kek, b64d(meta.wrap)));
        DATA.key = await importKey(raw);
        store.set("dk", b64e(raw));
        lock.hidden = true; statusEl.hidden = false;
        done();
      } catch {
        err.textContent = "Şifre yanlış. Tekrar deneyin.";
        err.hidden = false;
      }
    };
  });
}

/* ---------- Yükleme ---------- */

async function boot() {
  await unlock();
  if (DATA.enc && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    S.index = await getJSON("data/index.json");
  } catch {
    statusEl.textContent = "data/index.json bulunamadı. Önce tools/extract.py ile bir PDF dönüştürün.";
    return;
  }
  docSel.innerHTML = S.index.docs.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join("");
  const last = store.get("doc");
  await openDoc(S.index.docs.find((d) => d.id === last) || S.index.docs[0]);
}

async function openDoc(doc) {
  S.doc = doc; docSel.value = doc.id; store.set("doc", doc.id);
  statusEl.hidden = false; statusEl.textContent = "Şema yükleniyor…";
  const jsons = await Promise.all(doc.pages.map((p) => getJSON(`data/${doc.id}/page-${p.n}.json`)));
  S.pages = {};
  doc.pages.forEach((p, i) => { S.pages[p.n] = jsons[i]; });
  pageSel.innerHTML = doc.pages.map((p) => `<option value="${p.n}">s.${p.n} · ${esc(p.title)}</option>`).join("");
  const lastPage = Number(store.get("page:" + doc.id));
  await showPage(S.pages[lastPage] ? lastPage : doc.default);
  showHint();
}

async function showPage(n, then) {
  S.n = n; pageSel.value = n; store.set("page:" + S.doc.id, n);
  const key = `${S.doc.id}/${n}`;
  if (!svgCache.has(key)) svgCache.set(key, await getText(`data/${key.replace("/", "/page-")}.svg`));
  viewer.innerHTML = svgCache.get(key);
  statusEl.hidden = true;

  const svg = viewer.querySelector("svg");
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  S.svg = svg;

  // Lejanttaki renklerle birebir aynı renkteki çizgiler o devreye aittir.
  const page = S.pages[n];
  const colors = new Set(page.legend.map((l) => l.color));
  svg.querySelectorAll("[stroke]").forEach((el) => {
    const c = el.getAttribute("stroke").toLowerCase();
    if (colors.has(c)) el.dataset.c = c;
  });
  S.ov = document.createElementNS("http://www.w3.org/2000/svg", "g");
  S.ov.id = "ov";
  svg.appendChild(S.ov);

  S.active.clear(); S.tracing = false;
  renderChips(page.legend);
  fit();
  if (then) then();
}

/* ---------- Görünüm: yakınlaştırma ve kaydırma ----------
   Parmak hareket ederken SVG'yi CSS transform ile kaydırırız (hızlı, ama yakınlaşınca biraz bulanık).
   Parmak kalkınca görünümü viewBox'a işleriz: tarayıcı vektörü yeniden çizer ve her şey keskinleşir. */

const cw = () => viewer.clientWidth, ch = () => viewer.clientHeight;

function commit(v) {
  S.vb = S.live = v;
  S.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  S.svg.style.transform = "";
}
function preview(v) {
  S.live = v;
  const k = cw() / v.w, s = S.vb.w / v.w;
  S.svg.style.transform = `translate(${(S.vb.x - v.x) * k}px,${(S.vb.y - v.y) * k}px) scale(${s})`;
}
function fit() {
  const p = S.pages[S.n], s = Math.max(p.w / cw(), p.h / ch());
  const w = cw() * s, h = ch() * s;
  commit({ x: (p.w - w) / 2, y: (p.h - h) / 2, w, h });
}
function toSvg(px, py, v = S.live) {
  return { x: v.x + (px / cw()) * v.w, y: v.y + (py / ch()) * v.h };
}
function zoomAt(v, px, py, f) {
  const p = S.pages[S.n];
  const w = Math.min(Math.max(v.w / f, p.w / 60), p.w * 2);
  const P = toSvg(px, py, v), h = w * ch() / cw();
  return { x: P.x - (px / cw()) * w, y: P.y - (py / ch()) * h, w, h };
}
function zoomTo(b, minW = 260) {
  const w = Math.max((b[2] - b[0]) * 3, minW), h = w * ch() / cw();
  const cx = (b[0] + b[2]) / 2;
  // Alt panel açıksa hedefi ekranın üst yarısına koy
  const cy = (b[1] + b[3]) / 2 + (sheet.hidden ? 0 : h * 0.2);
  commit({ x: cx - w / 2, y: cy - h / 2, w, h });
}

const pts = new Map();
// offsetX, olayın hedefi bir SVG çizgisi olunca güvenilmez; görünüm kutusuna göre kendimiz hesaplarız.
const pos = (e) => { const r = viewer.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
let tap = null, lastTap = 0, wheelTimer = 0;

viewer.addEventListener("pointerdown", (e) => {
  viewer.setPointerCapture(e.pointerId);
  const p = pos(e);
  pts.set(e.pointerId, p);
  tap = pts.size === 1 ? { ...p, t: Date.now(), moved: false } : null;
});
viewer.addEventListener("pointermove", (e) => {
  if (!pts.has(e.pointerId) || !S.live) return;
  const prev = [...pts.values()].map((p) => ({ ...p }));
  const p = pos(e);
  pts.set(e.pointerId, p);
  const now = [...pts.values()];
  let v = S.live;
  if (now.length === 1) {
    const dx = now[0].x - prev[0].x, dy = now[0].y - prev[0].y;
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > 8) tap.moved = true;
    v = { ...v, x: v.x - dx * v.w / cw(), y: v.y - dy * v.h / ch() };
  } else if (now.length === 2) {
    const m0 = mid(prev), m1 = mid(now);
    const d0 = dist(prev), d1 = dist(now);
    v = { ...v, x: v.x - (m1.x - m0.x) * v.w / cw(), y: v.y - (m1.y - m0.y) * v.h / ch() };
    if (d0 > 0) v = zoomAt(v, m1.x, m1.y, d1 / d0);
  }
  preview(v);
});
function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (pts.size > 0) return;
  commit(S.live);
  if (tap && !tap.moved && Date.now() - tap.t < 400) {
    if (Date.now() - lastTap < 300) { commit(zoomAt(S.vb, tap.x, tap.y, 2.5)); lastTap = 0; }
    else { lastTap = Date.now(); onTap(tap.x, tap.y); }
  }
  tap = null;
}
viewer.addEventListener("pointerup", endPointer);
viewer.addEventListener("pointercancel", endPointer);
viewer.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = pos(e);
  preview(zoomAt(S.live, p.x, p.y, Math.exp(-e.deltaY * 0.0015)));
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => commit(S.live), 150);
}, { passive: false });
window.addEventListener("resize", () => {
  if (!S.vb) return;
  const v = S.vb, cy = v.y + v.h / 2, h = v.w * ch() / cw();
  commit({ x: v.x, y: cy - h / 2, w: v.w, h });
});
const mid = (a) => ({ x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 });
const dist = (a) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);

/* ---------- Etiket eşleştirme ----------
   Şemada kopuk duran iki "AL3" aslında aynı hattın iki ucudur.
   Bir etikete dokununca aynı etiketin geçtiği her yeri buluruz. Büyük/küçük harf önemlidir:
   Cat şemalarında "aL1" pilot hattı, "AL1" ana hattır. */

function onTap(px, py) {
  const P = toSvg(px, py), pad = 6 * S.live.w / cw();
  // Parmak ucu kalındır: yakındaki kelimeler arasından dokunulan noktaya en yakın olanı seç
  let best = null;
  for (const w of S.pages[S.n].words) {
    const dx = Math.max(w[0] - P.x, 0, P.x - w[2]), dy = Math.max(w[1] - P.y, 0, P.y - w[3]);
    const d = Math.hypot(dx, dy);
    if (d <= pad && (!best || d < best.d)) best = { w, d };
  }
  if (best) return showTag(best.w[4], best.w);
  const net = nearestNet(P, 10 * S.live.w / cw());
  if (net >= 0) showTrace(net);
}

function lineOf(n, w) {
  const cx = (w[0] + w[2]) / 2, cy = (w[1] + w[3]) / 2;
  const l = S.pages[n].lines.find((l) => cx >= l.b[0] && cx <= l.b[2] && cy >= l.b[1] && cy <= l.b[3]);
  return l ? l.t : w[4];
}

function showTag(text, from) {
  const hits = [];
  for (const p of S.doc.pages) for (const w of S.pages[p.n].words) if (w[4] === text) hits.push({ n: p.n, w });
  const here = hits.filter((h) => h.n === S.n);
  clearOverlay();
  mark(here.map((h) => h.w));
  const ctx = from ? lineOf(S.n, from) : "";
  openSheet(
    `<code>${esc(text)}</code><small>${here.length} yerde geçiyor (bu sayfa)` +
      (hits.length > here.length ? `, ${hits.length - here.length} yerde diğer sayfalarda` : "") +
      (ctx && ctx !== text ? ` · ${esc(ctx)}` : "") + "</small>",
    hits.map((h) => resRow(h.n, lineOf(h.n, h.w), text, h.w)).join("")
  );
}

// İşaret kutuları (.mk) eklenir; varsa hat takibi çizgisi yerinde kalır.
function mark(boxes) {
  S.ov.querySelectorAll(".mk").forEach((e) => e.remove());
  S.ov.insertAdjacentHTML("beforeend", boxes.map((b) => {
    const p = 3;
    return `<rect class="mk" x="${b[0] - p}" y="${b[1] - p}" width="${b[2] - b[0] + 2 * p}" height="${b[3] - b[1] + 2 * p}" rx="3"
      fill="rgba(255,196,0,.45)" stroke="#c2410c" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  }).join(""));
}
function clearOverlay() {
  S.ov.innerHTML = "";
  S.tracing = false;
  updateDim();
}

/* ---------- Hat takibi ----------
   tools/extract.py her sayfadaki hatları "ağlara" ayırdı: birbirine değen aynı renkteki çizgiler tek ağdır.
   Bir hatta dokununca o ağı, ağ bir etiket kutusuna (ör. AL3) giriyorsa aynı etiketli kutudan çıkan ağı da
   ekleyerek hattı baştan sona çizeriz. */

function nearestNet(P, pad) {
  const nets = S.pages[S.n].nets || [];
  let best = -1, bd = pad;
  nets.forEach((net, i) => {
    const s = net.s;
    for (let k = 0; k < s.length; k += 4) {
      const x1 = s[k], y1 = s[k + 1], dx = s[k + 2] - x1, dy = s[k + 3] - y1;
      const t = Math.max(0, Math.min(1, ((P.x - x1) * dx + (P.y - y1) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(P.x - x1 - t * dx, P.y - y1 - t * dy);
      if (d < bd) { bd = d; best = i; }
    }
  });
  return best;
}

function showTrace(start) {
  const nets = S.pages[S.n].nets;
  const ids = [start], seen = new Set(ids), via = [];
  for (let i = 0; i < ids.length; i++) {
    for (const tag of nets[ids[i]].t) {
      nets.forEach((o, j) => {
        if (!seen.has(j) && o.t.includes(tag)) { seen.add(j); ids.push(j); via.push(tag); }
      });
    }
  }
  const net = nets[start];
  let d = "";
  for (const i of ids) {
    const s = nets[i].s;
    for (let k = 0; k < s.length; k += 4) d += `M${s[k]} ${s[k + 1]}L${s[k + 2]} ${s[k + 3]}`;
  }
  // Hattın vardığı uçlar: etiket geçişleri hariç (onlar hattın devamı)
  const ends = [];
  for (const i of ids) for (const e of nets[i].e) {
    if (nets[i].t.includes(e[2])) continue;
    if (!ends.some((o) => Math.hypot(o[0] - e[0], o[1] - e[1]) < 4)) ends.push(e);
  }
  clearOverlay();
  S.ov.innerHTML = `<path d="${d}" fill="none" stroke="#ff6a00" stroke-opacity=".6" stroke-width="7" stroke-linecap="round"
      vector-effect="non-scaling-stroke"/>` +
    ends.map((e) => `<circle cx="${e[0]}" cy="${e[1]}" r="2.5" fill="#ff6a00" stroke="#7a2e00" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`).join("");
  S.tracing = true;
  updateDim();

  const leg = S.pages[S.n].legend.find((l) => l.color === net.c);
  const uniqVia = [...new Set(via)];
  openSheet(
    `<span class="sym"><i class="sw" style="background:${net.c}"></i>${esc(leg ? leg.label : "Hat")}</span>` +
      `<small>${ends.length} uç` + (uniqVia.length ? ` · etiketle devam ediyor: ${uniqVia.map(esc).join(", ")}` : "") + "</small>",
    ends.map((e, i) => resRow(S.n, e[2] ? `Uç ${i + 1} · ${e[2]}` : `Uç ${i + 1}`, "", [e[0] - 6, e[1] - 6, e[0] + 6, e[1] + 6])).join("")
  );
}

/* ---------- Arama ---------- */

let qTimer = 0;
q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(search, 150); });
q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); q.blur(); } });

function search() {
  const raw = q.value.trim();
  if (raw.length < 1) { closeSheet(); return; }
  const Q = raw.toLocaleUpperCase("en");
  const out = [];
  for (const p of S.doc.pages) {
    for (const l of S.pages[p.n].lines) {
      const T = l.t.toLocaleUpperCase("en");
      let score = 0;
      if (T.startsWith(`(${Q})`)) score = 100;              // "(45) VALVE GP..." bileşen numarası
      else if (T === Q) score = 90;
      else if (T.split(/\s+/).includes(Q)) score = 60;      // tam kelime
      else if (Q.length >= 2 && T.includes(Q)) score = 20;  // kelime parçası
      if (score) out.push({ score: score + (p.n === S.doc.default ? 5 : 0), n: p.n, l });
    }
  }
  out.sort((a, b) => b.score - a.score);
  openSheet(
    `Arama: <code>${esc(raw)}</code><small>${out.length ? out.length + " sonuç" : "Sonuç yok. Etiketi şemadaki gibi yazın (ör. AL3, Pi1, 45)."}</small>`,
    out.slice(0, 60).map((r) => resRow(r.n, rowText(r.n, r.l), raw, r.l.b)).join("")
  );
}

// Tablolarda numara ve açıklama ayrı satırlardır ("45" | "Valve Gp - Main Control").
// Sadece numara bulunduysa, aynı hizadaki komşu metinleri de gösteririz.
function rowText(n, l) {
  if (!/^\(?\d+\)?$/.test(l.t)) return l.t;
  const cy = (l.b[1] + l.b[3]) / 2;
  const row = S.pages[n].lines
    .filter((o) => Math.abs((o.b[1] + o.b[3]) / 2 - cy) < 3 && Math.abs(o.b[0] - l.b[0]) < 450)
    .sort((a, b) => a.b[0] - b.b[0]).map((o) => o.t);
  return row.join("  ·  ");
}

function resRow(n, text, needle, box) {
  const i = text.toLocaleUpperCase("en").indexOf(needle.toLocaleUpperCase("en"));
  const t = i < 0 ? esc(text) : esc(text.slice(0, i)) + "<b>" + esc(text.slice(i, i + needle.length)) + "</b>" + esc(text.slice(i + needle.length));
  return `<button class="res" data-n="${n}" data-b="${box.slice(0, 4).join(",")}"><span class="pg">s.${n}</span><span class="tx">${t}</span></button>`;
}

$("#sheetBody").addEventListener("click", (e) => {
  const r = e.target.closest(".res");
  if (!r) return;
  const n = Number(r.dataset.n), b = r.dataset.b.split(",").map(Number);
  const go = () => { mark([b]); zoomTo(b); };
  n === S.n ? go() : showPage(n, go);
});

/* ---------- Devre filtresi: Sistem / Fonksiyon ----------
   Sistem: pompa çıkışları, pilot, besleme, drenaj gibi bütün makineye hizmet eden hatlar.
   Fonksiyon: bir işi yöneten kontrol devreleri (bom, kova, döndürme, yürüyüş...).
   Grup başlığına dokununca o gruptaki tüm devreler birlikte seçilir. */

const GROUPS = [["sistem", "Sistem"], ["fonksiyon", "Fonksiyon"]];
function renderChips(legend) {
  chips.hidden = !legend.length;
  const chip = (l) => `<button class="chip" data-c="${l.color}" aria-pressed="false"><i style="background:${l.color}"></i>${esc(l.label)}</button>`;
  const grouped = GROUPS.map(([g, name]) => {
    const items = legend.filter((l) => l.g === g);
    return items.length ? `<button class="chip grp" data-g="${g}" aria-pressed="false">${name} ▸</button>` + items.map(chip).join("") : "";
  }).join("");
  chips.innerHTML = grouped + legend.filter((l) => !l.g).map(chip).join("");
}
chips.addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  if (b.dataset.g) {
    const cols = S.pages[S.n].legend.filter((l) => l.g === b.dataset.g).map((l) => l.color);
    const all = cols.every((c) => S.active.has(c));
    cols.forEach((c) => (all ? S.active.delete(c) : S.active.add(c)));
  } else {
    const c = b.dataset.c;
    S.active.has(c) ? S.active.delete(c) : S.active.add(c);
  }
  applyFilter();
});
function applyFilter() {
  S.svg.querySelectorAll("[data-c]").forEach((el) => el.classList.toggle("on", S.active.has(el.dataset.c)));
  chips.querySelectorAll(".chip[data-c]").forEach((b) => b.setAttribute("aria-pressed", S.active.has(b.dataset.c)));
  chips.querySelectorAll(".chip[data-g]").forEach((b) => {
    const cols = S.pages[S.n].legend.filter((l) => l.g === b.dataset.g).map((l) => l.color);
    b.setAttribute("aria-pressed", cols.length > 0 && cols.every((c) => S.active.has(c)));
  });
  updateDim();
}
function updateDim() {
  S.svg?.classList.toggle("dim", S.active.size > 0 || S.tracing);
}

/* ---------- Alt panel ve düğmeler ---------- */

function openSheet(title, body) {
  $("#sheetTitle").innerHTML = title;
  $("#sheetBody").innerHTML = body;
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; }
function showHint() {
  openSheet("Nasıl kullanılır",
    `<div class="hint">• Bir etikete dokunun (ör. <b>AL3</b>, <b>Pi1</b>): aynı etiketin geçtiği her yer işaretlenir. Kopuk hatlar böyle eşleşir.<br>
     • Bir hatta dokunun: hat baştan sona turuncu çizilir, etiketle koptuğu yerden (AL3 → AL3) devam eder, uçları listelenir.<br>
     • Arama kutusuna bileşen numarası yazın (ör. <b>45</b>) ya da bir ad (ör. <b>SWING</b>).<br>
     • Alttaki düğmeler devreleri öne çıkarır, gerisini soldurur. <b>Sistem</b> ya da <b>Fonksiyon</b> başlığına dokununca o gruptaki tüm devreler seçilir.<br>
     • İki parmakla yakınlaşın, çift dokunuşla büyütün, ⤢ ile tüm sayfaya dönün.</div>`);
}
$("#sheetClose").addEventListener("click", closeSheet);
$("#fitBtn").addEventListener("click", fit);
$("#clearBtn").addEventListener("click", () => {
  S.active.clear(); clearOverlay(); applyFilter();
  q.value = ""; closeSheet();
});
docSel.addEventListener("change", () => openDoc(S.index.docs.find((d) => d.id === docSel.value)));
pageSel.addEventListener("change", () => showPage(Number(pageSel.value)));

boot();
