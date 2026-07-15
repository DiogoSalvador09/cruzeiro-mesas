// O Cruzeiro · Mesas — lógica principal
import { createStore, dayKey, newId } from './store.js';

/* ------------------- mesas (fiel à folha no balcão) ------------------- */
const MAIN_ROWS = [
  ['100', '101', '102', '103'],
  ['108', '107', '105', '104'],
  ['109', '110', '111', '112'],
  ['116', '115', '114', '113'],
  ['117', '118', '119', '120'],
  ['124', '123', '122', '121'],
  ['125', '126', '127', '128'],
];
const SALA = ['Sala 1', 'Sala 2', 'Sala 3', 'Sala 4', 'Sala 5', 'Sala 6'];
const WARN_MIN = 5;   // fica laranja
const CRIT_MIN = 10;  // fica vermelho a piscar

/* ------------------------------ estado ------------------------------ */
let store;
let live = {};            // id -> {id, tables[], pax, arrivedAt, attendedAt?}
let todayLog = {};        // id -> entrada fechada de hoje
let selection = [];       // mesas escolhidas na nova entrada
let selLang = null;       // 'es' | 'en' | null (null = português)
let joining = false;      // modo "juntar mesas" (mapa tocável, folha escondida)
let bigVal = 14;          // stepper de grupo grande
let reseatId = null;      // grupo a arquivar quando o novo for confirmado (sentar novo grupo)
const LANG_WORD = { es: 'Espanhol', en: 'Inglês' };
let activeId = null;      // grupo aberto na folha
let lastAction = null;    // para o Anular
let toastTimer = null;
const tiles = {};         // mesa -> elemento

const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
const nowMs = () => (store && store.nowMs ? store.nowMs() : Date.now()); // hora corrigida pelo servidor
const minsSince = (ts) => Math.floor((nowMs() - ts) / 60000);
const sortTables = (arr) => [...arr].sort((a, b) => {
  const na = parseInt(a, 10); const nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, 'pt');
});
const tablesLabel = (arr) => sortTables(arr).join(' + ');
const groupOf = (table) => Object.values(live).find((g) => (g.tables || []).includes(table));
const paxWord = (n) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

/* ---- tempo à mesa: aprende quanto tempo os grupos ficam (atendida→livre) ---- */
const DINE_KEY = 'cz_dine';
function pushDineSamples(obj) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(DINE_KEY) || '[]'); } catch { arr = []; }
  const have = new Set(arr.map((s) => s.id));
  Object.entries(obj || {}).forEach(([id, e]) => {
    if (e.attendedAt && e.freedAt && e.freedAt > e.attendedAt && !have.has(id)) {
      arr.push({ id, d: e.freedAt - e.attendedAt });
    }
  });
  try { localStorage.setItem(DINE_KEY, JSON.stringify(arr.slice(-60))); } catch { /* cheio */ }
}
function avgDineMin() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(DINE_KEY) || '[]'); } catch { arr = []; }
  const ds = arr.map((s) => s.d).filter((d) => d > 5 * 60000 && d < 4 * 3600000); // 5min–4h
  if (ds.length < 4) return null; // ainda a aprender
  ds.sort((a, b) => a - b);
  return Math.round(ds[Math.floor(ds.length / 2)] / 60000); // mediana, em minutos
}
// texto do palpite "~livre em N min" para uma mesa já atendida
function freeHint(g) {
  const dine = avgDineMin();
  if (!dine || !g.attendedAt) return '';
  const est = dine - minsSince(g.attendedAt);
  return est > 1 ? `~livre em ${est} min` : 'a terminar';
}

/* ------------------------------- mapa ------------------------------- */
function buildMap() {
  const main = $('mapMain');
  MAIN_ROWS.forEach((row, ri) => {
    row.forEach((t, ci) => {
      const el = document.createElement('button');
      el.className = 'tile';
      el.style.gridColumn = String(ci + 1);
      el.style.gridRow = String(ri + 1);
      if (t === null) { el.classList.add('gap'); el.disabled = true; el.setAttribute('aria-hidden', 'true'); }
      else {
        el.innerHTML = `<span class="num">${t}</span><span class="sub"></span>`;
        el.setAttribute('aria-label', `Mesa ${t}`);
        el.addEventListener('click', () => onTileTap(t));
        tiles[t] = el;
      }
      main.appendChild(el);
    });
  });
  const b = document.createElement('div'); // balcão ao lado das filas 3–4, como na folha
  b.className = 'balcao'; b.textContent = 'BALCÃO';
  main.appendChild(b);
  const sala = $('mapSala');
  SALA.forEach((t) => {
    const el = document.createElement('button');
    el.className = 'tile';
    el.innerHTML = `<span class="num">${t}</span><span class="sub"></span>`;
    el.setAttribute('aria-label', `Mesa ${t}`);
    el.addEventListener('click', () => onTileTap(t));
    tiles[t] = el;
    sala.appendChild(el);
  });
}

function renderMap() {
  Object.entries(tiles).forEach(([t, el]) => {
    const g = groupOf(t);
    el.classList.toggle('selected', selection.includes(t));
    el.classList.toggle('wait', !!g && !g.attendedAt);
    el.classList.toggle('done', !!g && !!g.attendedAt);
    el.querySelector('.link-dot')?.remove();
    const sub = el.querySelector('.sub');
    if (!sub) return;
    if (selection.includes(t)) sub.textContent = 'escolhida';
    else if (!g) sub.textContent = '';
    else {
      const lang = g.lang ? `${g.lang.toUpperCase()} ` : '';
      sub.textContent = lang + (g.attendedAt ? `${g.pax}p ✓` : `${g.pax}p · ${minsSince(g.arrivedAt)}m`);
      if ((g.tables || []).length > 1) {
        const dot = document.createElement('span');
        dot.className = 'link-dot'; dot.title = `Juntas: ${tablesLabel(g.tables)}`;
        el.appendChild(dot);
      }
    }
  });
}

/* --------------------------- interações ----------------------------- */
function onTileTap(t) {
  if (joining) {
    // modo juntar: alterna mesas livres na seleção (ocupadas ignoram-se)
    if (groupOf(t)) return;
    selection = selection.includes(t) ? selection.filter((x) => x !== t) : [...selection, t];
    $('joinBarTables').textContent = selection.length ? `Mesa ${tablesLabel(selection)}` : 'toca numa mesa livre';
    renderMap();
    return;
  }
  const g = groupOf(t);
  if (g) { openGroupSheet(g.id); return; }
  selection = [t];
  openNewSheet(true);
}

function openNewSheet(resetLang) {
  if (resetLang) { selLang = null; bigVal = 14; }
  paintLangRow($('langRowNew'), selLang);
  $('bigStepper').classList.add('hidden');
  $('paxGrid').classList.remove('hidden');
  $('sheetTables').textContent = `Mesa ${tablesLabel(selection)}`;
  $('sheetSub').textContent = selection.length > 1 ? `${selection.length} mesas juntas` : 'Nova entrada';
  $('paneNew').classList.remove('hidden');
  $('paneGroup').classList.add('hidden');
  showSheet();
  renderMap();
}

function enterJoinMode() {
  joining = true;
  $('sheet').classList.add('hidden');
  $('scrim').classList.add('hidden');
  $('joinBar').classList.remove('hidden');
  $('joinBarTables').textContent = `Mesa ${tablesLabel(selection)}`;
  renderMap();
}
function finishJoinMode() {
  joining = false;
  $('joinBar').classList.add('hidden');
  if (!selection.length) { closeSheet(); return; }
  openNewSheet(false); // mantém língua já escolhida
}

function openGroupSheet(id) {
  const g = live[id]; if (!g) return;
  activeId = id; selection = [];
  $('sheetTables').textContent = `Mesa ${tablesLabel(g.tables)}`;
  $('sheetSub').textContent = '';
  $('paneNew').classList.add('hidden');
  $('paneGroup').classList.remove('hidden');
  renderGroupPane();
  showSheet();
  renderMap();
}

function renderGroupPane() {
  const g = live[activeId]; if (!g) { closeSheet(); return; }
  const attended = !!g.attendedAt;
  const langWord = g.lang ? `${LANG_WORD[g.lang]} · ` : '';
  const hint = attended ? freeHint(g) : '';
  $('groupMeta').textContent = langWord + (attended
    ? `Na sala desde ${fmtTime(g.attendedAt)} · atendida há ${minsSince(g.attendedAt)} min${hint ? ` · ${hint}` : ''}`
    : `À espera há ${minsSince(g.arrivedAt)} min · entrou às ${fmtTime(g.arrivedAt)}`);
  paintLangRow($('langRowGroup'), g.lang || null);
  $('paxValue').textContent = g.pax;
  $('btnAttend').classList.toggle('hidden', attended);
  $('btnReseat').classList.toggle('hidden', !attended);
  $('btnFree').className = 'btn ghost big';
  $('btnFree').textContent = attended ? 'Mesa livre — saíram' : 'Libertar (saíram sem pedir)';
}

// tocar numa mesa já atendida → arquivar o grupo e sentar já um novo nas mesmas mesas
function reseatFrom(id) {
  const g = live[id]; if (!g) return;
  reseatId = id;
  selection = [...g.tables];
  openNewSheet(true); // pax picker limpo para as mesmas mesas; só arquiva o antigo ao confirmar
  $('sheetSub').textContent = 'Sentar novo grupo · o anterior vai para o histórico';
}

function showSheet() { $('sheet').classList.remove('hidden'); $('scrim').classList.remove('hidden'); }
function closeSheet() {
  $('sheet').classList.add('hidden'); $('scrim').classList.add('hidden');
  $('joinBar').classList.add('hidden'); joining = false;
  selection = []; activeId = null; reseatId = null;
  renderMap();
}

function paintLangRow(row, lang) {
  row.querySelectorAll('.lang-chip').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
}
function wireLangRows() {
  $('langRowNew').querySelectorAll('.lang-chip').forEach((b) => b.addEventListener('click', () => {
    selLang = selLang === b.dataset.lang ? null : b.dataset.lang;
    paintLangRow($('langRowNew'), selLang);
  }));
  $('langRowGroup').querySelectorAll('.lang-chip').forEach((b) => b.addEventListener('click', () => {
    const g = live[activeId]; if (!g) return;
    const lang = g.lang === b.dataset.lang ? null : b.dataset.lang;
    paintLangRow($('langRowGroup'), lang);
    store.updateGroup(activeId, { lang });
  }));
}

const langBadge = (g) => (g.lang ? `<span class="lang-badge" title="${LANG_WORD[g.lang]}">${g.lang.toUpperCase()}</span>` : '');

function buildPaxGrid() {
  const grid = $('paxGrid');
  for (let n = 1; n <= 12; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.setAttribute('aria-label', paxWord(n));
    b.addEventListener('click', () => confirmNew(n));
    grid.appendChild(b);
  }
}

function openBigStepper() {
  $('paxGrid').classList.add('hidden');
  $('bigStepper').classList.remove('hidden');
  paintBig();
}
function stepBig(d) { bigVal = Math.max(13, Math.min(60, bigVal + d)); paintBig(); }
function paintBig() {
  $('bigValue').textContent = bigVal;
  $('bigConfirm').textContent = `Registar ${paxWord(bigVal)}`;
}

async function confirmNew(pax) {
  const tables = sortTables(selection);
  const g = { id: newId(), tables, pax, arrivedAt: store.stamp(), ...(selLang ? { lang: selLang } : {}) };
  const oldSnap = reseatId && live[reseatId] ? { ...live[reseatId] } : null;
  closeSheet(); // limpa selection, reseatId, etc.
  if (oldSnap) await store.freeGroup(oldSnap, store.stamp()); // grupo anterior → histórico
  await store.addGroup(g);
  toast(`Mesa ${tablesLabel(tables)} · ${paxWord(pax)}${g.lang ? ` · ${LANG_WORD[g.lang]}` : ''} ✓`);
}

/* ------------------------------ ações ------------------------------- */
async function attend(id) {
  const g = live[id]; if (!g) return;
  await store.updateGroup(id, { attendedAt: store.stamp() });
  lastAction = { undo: () => store.updateGroup(id, { attendedAt: null }) };
  toast(`Mesa ${tablesLabel(g.tables)} atendida ✓`, true);
}
async function freeTable(id) {
  const g = live[id]; if (!g) return;
  const snapshot = { ...g };
  await store.freeGroup(g, store.stamp());
  lastAction = { undo: () => store.restoreGroup(snapshot) };
  toast(`Mesa ${tablesLabel(g.tables)} libertada`, true);
}
async function cancelEntry(id) {
  const g = live[id]; if (!g) return;
  const snapshot = { ...g };
  await store.removeGroup(id);
  lastAction = { undo: () => store.addGroup(snapshot) };
  toast('Entrada apagada', true);
}

/* --------------------- sino do balcão (10 min) ---------------------- */
let audioCtx = null;
let bellOn = localStorage.getItem('cz_bell') === '1';
const alertedKey = () => `cz_alerted_${dayKey()}`;
let alerted = new Set(JSON.parse(localStorage.getItem(alertedKey()) || '[]'));

// sino de bordo: uma pancada = fundamental + parciais inarmónicos com cauda metálica
function strike(t0, f0, vol) {
  // [múltiplo da frequência, ganho relativo, decaimento em s] — perfil de sino
  const partials = [[1, 1, 1.7], [2.0, 0.6, 1.35], [2.76, 0.42, 1.05], [3.9, 0.28, 0.85], [5.4, 0.18, 0.6]];
  partials.forEach(([mult, g0, dec]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f0 * mult;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol * g0, t0 + 0.004); // ataque seco (badalada)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dec);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + dec + 0.05);
  });
}
function ding() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  strike(t, 660, 0.45);          // dois toques em par, como o sino de bordo
  strike(t + 0.33, 660, 0.38);
}

function toggleBell() {
  bellOn = !bellOn;
  localStorage.setItem('cz_bell', bellOn ? '1' : '0');
  if (bellOn) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    ding(); // toque de teste — também desbloqueia o áudio neste aparelho
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
  paintBell();
}
function paintBell() {
  const b = $('bellBtn');
  b.classList.toggle('on', bellOn);
  b.title = bellOn ? 'Sino ligado — toca aos 10 min sem atendimento' : 'Toca quando uma mesa passa dos 10 min';
}

/* --------------------------- tema claro/escuro ---------------------- */
const MOON_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const SUN_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function paintTheme() {
  const dark = effectiveTheme() === 'dark';
  const b = $('themeBtn');
  b.innerHTML = dark ? SUN_SVG : MOON_SVG;
  b.title = dark ? 'Mudar para tema claro' : 'Mudar para tema escuro';
}
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cz_theme', next);
  document.documentElement.dataset.theme = next;
  paintTheme();
}

function checkAlerts() {
  // muda de dia → esquece os alertas de ontem
  if (!localStorage.getItem(alertedKey())) alerted = new Set();
  Object.values(live).filter((g) => !g.attendedAt).forEach((g) => {
    const mins = minsSince(g.arrivedAt);
    if (mins < CRIT_MIN || alerted.has(g.id)) return;
    alerted.add(g.id);
    localStorage.setItem(alertedKey(), JSON.stringify([...alerted]));
    if (!bellOn) return;
    if (audioCtx) ding();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`Mesa ${tablesLabel(g.tables)} à espera há ${mins} min`, {
          body: `${paxWord(g.pax)} · entrou às ${fmtTime(g.arrivedAt)}`,
          icon: 'assets/icon.png', tag: g.id,
        });
      } catch { /* iOS não suporta Notification local — o som já tocou */ }
    }
  });
}

function toast(msg, undoable = false) {
  clearTimeout(toastTimer);
  $('toastMsg').textContent = msg;
  $('toastUndo').classList.toggle('hidden', !undoable);
  $('toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000);
}

/* --------------------- próxima mesa (destaque) ---------------------- */
function renderSpotlight(waiting) {
  const spot = $('spotlight');
  const next = waiting[0];
  if (!next) {
    spot.className = 'spotlight calm';
    spot.innerHTML = '<div class="spot-eyebrow">Serviço</div><div class="spot-calm">Sala tranquila</div><div class="spot-meta">Mar calmo · ninguém à espera 🌊</div>';
    return;
  }
  const mins = minsSince(next.arrivedAt);
  const sev = mins >= CRIT_MIN ? 'crit' : mins >= WARN_MIN ? 'warn' : '';
  spot.className = `spotlight active ${sev}`;
  const more = waiting.length > 1 ? ` · mais ${waiting.length - 1} à espera` : '';
  spot.innerHTML = `
    <div class="spot-eyebrow">Próxima mesa</div>
    <div class="spot-main" role="button" tabindex="0" aria-label="Abrir mesa ${tablesLabel(next.tables)}">
      <div class="spot-tables">${tablesLabel(next.tables)}${langBadge(next)}</div>
      <div class="spot-wait">${mins} min</div>
    </div>
    <div class="spot-meta">${paxWord(next.pax)} · entrou às ${fmtTime(next.arrivedAt)}${more}</div>
    <button class="btn primary big spot-attend">Atendida ✓</button>`;
  spot.querySelector('.spot-attend').addEventListener('click', () => attend(next.id));
  const main = spot.querySelector('.spot-main');
  main.addEventListener('click', () => openGroupSheet(next.id));
  main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroupSheet(next.id); } });
}

/* ------------------------------- fila ------------------------------- */
function renderQueue() {
  const groups = Object.values(live);
  const waiting = groups.filter((g) => !g.attendedAt).sort((a, b) => a.arrivedAt - b.arrivedAt);
  const seated = groups.filter((g) => g.attendedAt).sort((a, b) => a.attendedAt - b.attendedAt);
  renderSpotlight(waiting);

  const badge = $('queueBadge');
  badge.textContent = waiting.length;
  badge.classList.toggle('hidden', !waiting.length);
  $('waitCount').textContent = waiting.length ? `· ${waiting.length}` : '';
  $('seatedCount').textContent = seated.length ? `· ${seated.length}` : '';

  const ql = $('queueList'); ql.innerHTML = '';
  waiting.forEach((g, i) => {
    const mins = minsSince(g.arrivedAt);
    const chipCls = mins >= CRIT_MIN ? 'chip crit' : mins >= WARN_MIN ? 'chip warn' : 'chip';
    const card = document.createElement('div');
    card.className = 'qcard';
    card.innerHTML = `
      <span class="pos">${i + 1}º</span>
      <div class="who">
        <div class="tables">${tablesLabel(g.tables)}${langBadge(g)}</div>
        <div class="meta">${paxWord(g.pax)} · entrou às ${fmtTime(g.arrivedAt)}</div>
      </div>
      <span class="${chipCls}">${mins} min</span>
      <button class="attend">Atendida ✓</button>`;
    card.querySelector('.attend').addEventListener('click', () => attend(g.id));
    card.querySelector('.who').addEventListener('click', () => openGroupSheet(g.id));
    ql.appendChild(card);
  });
  $('queueEmpty').classList.toggle('hidden', !!waiting.length);

  const sl = $('seatedList'); sl.innerHTML = '';
  seated.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'qcard seated-row';
    const hint = freeHint(g);
    const hintHtml = hint ? `<span class="chip soft">${hint}</span>` : '';
    row.innerHTML = `
      <div class="who">
        <div class="tables">${tablesLabel(g.tables)}${langBadge(g)}</div>
        <div class="meta">${paxWord(g.pax)} · atendida há ${minsSince(g.attendedAt)} min</div>
      </div>
      ${hintHtml}
      <button class="free-btn">Libertar</button>`;
    row.querySelector('.free-btn').addEventListener('click', () => freeTable(g.id));
    row.querySelector('.who').addEventListener('click', () => openGroupSheet(g.id));
    sl.appendChild(row);
  });
  $('seatedEmpty').classList.toggle('hidden', !!seated.length);
}

/* ------------------------------- dia -------------------------------- */
function dayEntries() {
  // fechadas hoje + ainda na sala (grupos vivos contam para o dia)
  return [...Object.values(todayLog), ...Object.values(live)];
}

function renderDay() {
  const entries = dayEntries();
  const waits = entries.filter((e) => e.attendedAt).map((e) => e.attendedAt - e.arrivedAt);
  const ongoing = Object.values(live).filter((g) => !g.attendedAt).map((g) => Date.now() - g.arrivedAt);
  const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000) : null;
  const max = Math.max(0, ...waits, ...ongoing);

  const stats = [
    { v: entries.length, l: 'Grupos' },
    { v: entries.reduce((a, e) => a + (e.pax || 0), 0), l: 'Pessoas' },
    { v: avg == null ? '—' : `${avg} min`, l: 'Espera média' },
    { v: entries.length ? `${Math.round(max / 60000)} min` : '—', l: 'Maior espera' },
  ];
  $('statRow').innerHTML = stats.map((s) => `<div class="stat"><div class="v">${s.v}</div><div class="l">${s.l}</div></div>`).join('');

  renderHourChart(entries);
  renderDaysTable();
}

function renderHourChart(entries) {
  const byHour = {};
  entries.forEach((e) => { const h = new Date(e.arrivedAt).getHours(); byHour[h] = (byHour[h] || 0) + 1; });
  const hours = Object.keys(byHour).map(Number);
  const chart = $('hourChart'); const tip = $('chartTip');
  chart.innerHTML = '';
  const labels = document.createElement('div'); labels.className = 'hour-labels';
  chart.insertAdjacentElement('afterend', labels);
  document.querySelectorAll('.hour-labels + .hour-labels').forEach((n) => n.remove()); // evita duplicar em re-render

  if (!hours.length) { chart.innerHTML = '<div class="empty-sub" style="align-self:center;width:100%;text-align:center">Sem entradas hoje.</div>'; return; }
  const h0 = Math.min(...hours); const h1 = Math.max(...hours);
  const maxV = Math.max(...Object.values(byHour));
  const span = h1 - h0 + 1;
  for (let h = h0; h <= h1; h++) {
    const v = byHour[h] || 0;
    const slot = document.createElement('div');
    slot.className = 'bar-slot'; slot.tabIndex = 0;
    slot.setAttribute('role', 'img');
    slot.setAttribute('aria-label', `${h} horas: ${v} grupos`);
    const bar = document.createElement('div');
    bar.className = 'bar'; bar.style.height = `${v ? Math.max(4, (v / maxV) * 100) : 0}%`;
    if (v === maxV) { const tl = document.createElement('span'); tl.className = 'top-label'; tl.textContent = v; slot.appendChild(tl); }
    slot.appendChild(bar);
    const show = () => {
      tip.textContent = `${h}h · ${v} ${v === 1 ? 'grupo' : 'grupos'}`;
      tip.classList.remove('hidden');
      const c = $('hourChart').parentElement.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      tip.style.left = `${r.left - c.left + r.width / 2}px`;
      tip.style.top = `${r.top - c.top}px`;
    };
    slot.addEventListener('mouseenter', show);
    slot.addEventListener('focus', show);
    slot.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    slot.addEventListener('blur', () => tip.classList.add('hidden'));
    chart.appendChild(slot);
    const lb = document.createElement('span');
    lb.textContent = (span <= 10 || (h - h0) % 2 === 0) ? `${h}h` : '';
    labels.appendChild(lb);
  }
}

async function renderDaysTable() {
  const days = await store.fetchDays(10);
  Object.values(days).forEach(pushDineSamples); // dias anteriores alimentam o palpite logo de manhã
  const tbody = $('daysTable').querySelector('tbody');
  const today = dayKey();
  const keys = Object.keys(days).filter((k) => k !== today).sort().reverse().slice(0, 7);
  tbody.innerHTML = '';
  keys.forEach((k) => {
    const entries = Object.values(days[k] || {});
    const waits = entries.filter((e) => e.attendedAt).map((e) => e.attendedAt - e.arrivedAt);
    const avg = waits.length ? `${Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000)} min` : '—';
    const d = new Date(`${k}T12:00:00`);
    const label = d.toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${entries.length}</td><td>${entries.reduce((a, e) => a + (e.pax || 0), 0)}</td><td>${avg}</td>`;
    tbody.appendChild(tr);
  });
  $('daysTable').classList.toggle('hidden', !keys.length);
  $('daysEmpty').classList.toggle('hidden', !!keys.length);
}

/* ------------------------------ vistas ------------------------------ */
function setView(v) {
  if (window.innerWidth >= 1020 && v === 'queue') v = 'map';
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === v;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelector('.views').classList.toggle('day-active', v === 'day');
  localStorage.setItem('cz_view', v);
  if (v === 'day') renderDay();
}

/* ---------------------------- demo (preview) ------------------------ */
async function seedPreview() {
  if (Object.keys(live).length || Object.keys(todayLog).length) return;
  const now = Date.now(); const M = 60000;
  const mk = (tables, pax, aMin, tMin, fMin, lang) => ({
    id: newId(), tables, pax,
    arrivedAt: now - aMin * M,
    ...(tMin != null ? { attendedAt: now - tMin * M } : {}),
    ...(fMin != null ? { freedAt: now - fMin * M } : {}),
    ...(lang ? { lang } : {}),
  });
  await store.addGroup(mk(['105'], 2, 11, null, null));
  await store.addGroup(mk(['114', '115'], 9, 6, null, null, 'en'));
  await store.addGroup(mk(['101'], 4, 2, null, null, 'es'));
  await store.addGroup(mk(['120'], 3, 38, 31, null));
  await store.addGroup(mk(['Sala 2'], 6, 55, 49, null));
  for (const [t, p, a] of [[['109'], 2, 190], [['110'], 4, 175], [['117'], 5, 160], [['Sala 1'], 3, 150], [['126'], 2, 140], [['122'], 4, 95], [['100'], 6, 80]]) {
    const g = mk(t, p, a, a - 6, a - 60);
    await store.freeGroup({ ...g }, now - (a - 60) * M);
  }
}

/* ------------------------------ arranque ---------------------------- */
async function main() {
  buildMap();
  buildPaxGrid();
  wireLangRows();
  store = await createStore();

  const conn = $('connDot'); const connLabel = $('connLabel');
  if (store.mode === 'firebase') {
    store.onConnection((ok) => {
      conn.className = `conn ${ok ? 'online' : 'offline'}`;
      connLabel.textContent = ok ? 'em linha' : 'sem net';
    });
  } else {
    connLabel.textContent = window.__PREVIEW__ ? 'demo' : 'só neste aparelho';
  }
  store.onLive((v) => { live = v || {}; renderMap(); renderQueue(); checkAlerts(); if (currentView() === 'day') renderDay(); });
  store.onToday((k, v) => {
    todayLog = v || {};
    pushDineSamples(todayLog); // aprende tempos à mesa à medida que as mesas libertam
    renderQueue(); // repinta os palpites "~livre em N min"
    if (currentView() === 'day') renderDay();
  });

  if (window.__PREVIEW__) {
    $('previewPill').classList.remove('hidden');
    await seedPreview(); // só semeia se estiver vazio — live já está carregado aqui
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('scrim').addEventListener('click', closeSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  $('btnAttend').addEventListener('click', () => { const id = activeId; closeSheet(); attend(id); });
  $('btnReseat').addEventListener('click', () => reseatFrom(activeId));
  $('btnFree').addEventListener('click', () => { const id = activeId; closeSheet(); freeTable(id); });
  $('btnCancel').addEventListener('click', () => { const id = activeId; closeSheet(); cancelEntry(id); });
  $('joinBtn').addEventListener('click', enterJoinMode);
  $('joinDone').addEventListener('click', finishJoinMode);
  $('moreBtn').addEventListener('click', openBigStepper);
  $('bigMinus').addEventListener('click', () => stepBig(-1));
  $('bigPlus').addEventListener('click', () => stepBig(1));
  $('bigConfirm').addEventListener('click', () => confirmNew(bigVal));
  $('bellBtn').addEventListener('click', toggleBell);
  paintBell();
  $('themeBtn').addEventListener('click', toggleTheme);
  paintTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!localStorage.getItem('cz_theme')) paintTheme(); });
  $('paxMinus').addEventListener('click', () => stepPax(-1));
  $('paxPlus').addEventListener('click', () => stepPax(1));
  $('toastUndo').addEventListener('click', async () => {
    $('toast').classList.add('hidden');
    if (lastAction) { await lastAction.undo(); lastAction = null; }
  });

  const clock = $('clock');
  const tickClock = () => { clock.textContent = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }); };
  tickClock(); setInterval(tickClock, 15000);

  setInterval(() => { renderMap(); renderQueue(); checkAlerts(); if (activeId) renderGroupPane(); }, 20000);

  setView(localStorage.getItem('cz_view') || 'map');

  if ('serviceWorker' in navigator && !window.__PREVIEW__ && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function currentView() { return document.querySelector('.tab.active')?.dataset.view || 'map'; }
function stepPax(d) {
  const g = live[activeId]; if (!g) return;
  const pax = Math.max(1, Math.min(60, (g.pax || 1) + d));
  $('paxValue').textContent = pax;
  store.updateGroup(activeId, { pax });
}

main();
