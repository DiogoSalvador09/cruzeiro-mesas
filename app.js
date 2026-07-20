// O Cruzeiro · Mesas — lógica principal
import { createStore, dayKey, newId } from './store.js';

/* --- disposição por omissão (fiel à folha do balcão); depois é editável e sincronizada --- */
const DEFAULT_ROWS = [
  ['100', '101', '102', '103'],
  ['108', '107', '105', '104'],
  ['109', '110', '111', '112'],
  ['116', '115', '114', '113'],
  ['117', '118', '119', '120'],
  ['124', '123', '122', '121'],
  ['125', '126', '127', '128'],
];
const DEFAULT_SALA = ['Sala 1', 'Sala 2', 'Sala 3', 'Sala 4', 'Sala 5', 'Sala 6'];
const defaultTables = () => ({ esplanada: DEFAULT_ROWS.flat().filter(Boolean), sala: [...DEFAULT_SALA] });
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
let movingId = null;      // grupo a trocar de mesa (escolhe o destino no mapa)
let waitlist = {};        // lista de espera de mesa (id -> {id,name,pax,addedAt,lang?})
let seatingWait = null;   // a sentar alguém da lista de espera (escolhe mesas no mapa)
let waitVal = 2;          // contador de pessoas no diálogo de espera
let waitLang = null;
const LANG_WORD = { es: 'Espanhol', en: 'Inglês' };
let activeId = null;      // grupo aberto na folha
let lastAction = null;    // para o Anular
let toastTimer = null;
const tiles = {};         // mesa -> elemento
let tablesConfig = defaultTables(); // { esplanada:[], sala:[] } — sincronizado
let editMode = false;     // modo "editar mesas" (adicionar/remover)
let firstBuild = true;    // anima os tiles só no primeiro desenho
let staggerN = 0;
let addSection = 'esplanada';

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

// mesas atendidas (azul) apanhadas nestas tables, excluindo o grupo `exceptId` (se estiver a ser reusado) — para
// arquivar antes de reatribuir (sentar da espera / juntar / trocar de mesa)
function occupantsToArchive(tables, exceptId) {
  return [...new Map(
    tables.map((t) => groupOf(t)).filter((og) => og && og.id !== exceptId).map((og) => [og.id, { ...og }]),
  ).values()];
}
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
function makeTile(t, i, section) {
  const el = document.createElement('button');
  el.className = 'tile';
  if (section === 'esplanada' && i != null) { // fluxo de 4 colunas, como a folha
    el.style.gridColumn = String((i % 4) + 1);
    el.style.gridRow = String(Math.floor(i / 4) + 1);
  }
  if (firstBuild) el.style.setProperty('--i', String(staggerN++)); else el.style.animation = 'none';
  el.dataset.label = t; el.dataset.section = section;
  el.innerHTML = `<span class="num">${t}</span><span class="sub"></span>`;
  el.setAttribute('aria-label', `Mesa ${t}`);
  el.addEventListener('click', () => onTileTap(t));
  if (editMode) {
    el.classList.add('editing');
    el.addEventListener('pointerdown', (e) => onDragStart(e, t, section));
    const x = document.createElement('span');
    x.className = 'tile-x'; x.textContent = '✕';
    x.setAttribute('aria-label', `Remover mesa ${t}`);
    x.addEventListener('click', (e) => { e.stopPropagation(); removeTable(t, section); });
    el.appendChild(x);
  }
  tiles[t] = el;
  return el;
}
function makeAddTile(section, i) {
  const el = document.createElement('button');
  el.className = 'tile add-tile'; el.style.animation = 'none';
  if (section === 'esplanada' && i != null) {
    el.style.gridColumn = String((i % 4) + 1);
    el.style.gridRow = String(Math.floor(i / 4) + 1);
  }
  el.innerHTML = '<span class="num">＋</span><span class="sub">mesa</span>';
  el.setAttribute('aria-label', 'Adicionar mesa');
  el.addEventListener('click', () => openAddTable(section));
  return el;
}
function buildMap() {
  staggerN = 0;
  Object.keys(tiles).forEach((k) => delete tiles[k]);
  const main = $('mapMain'); main.innerHTML = '';
  tablesConfig.esplanada.forEach((t, i) => main.appendChild(makeTile(t, i, 'esplanada')));
  if (editMode) main.appendChild(makeAddTile('esplanada', tablesConfig.esplanada.length));
  const b = document.createElement('div'); // balcão (decorativo, não conta)
  b.className = 'balcao'; b.textContent = 'BALCÃO';
  main.appendChild(b);
  const sala = $('mapSala'); sala.innerHTML = '';
  tablesConfig.sala.forEach((t) => sala.appendChild(makeTile(t, null, 'sala')));
  if (editMode) sala.appendChild(makeAddTile('sala', null));
  firstBuild = false;
}
function applyConfig(cfg) {
  tablesConfig = cfg && cfg.esplanada
    ? { esplanada: cfg.esplanada || [], sala: cfg.sala || [] }
    : defaultTables();
  buildMap(); renderMap();
}

/* ----------------------- editar mesas (add/remove) ------------------ */
function toggleEdit() {
  editMode = !editMode;
  document.body.classList.toggle('editing', editMode);
  $('editBtn').textContent = editMode ? '✓ Concluir' : '✎ Editar';
  $('editHint').classList.toggle('hidden', !editMode);
  buildMap(); renderMap();
}
function saveConfig(cfg) { applyConfig(cfg); store.setTables(cfg); }
function cloneConfig() { return { esplanada: [...tablesConfig.esplanada], sala: [...tablesConfig.sala] }; }
function removeTable(t, section) {
  if (groupOf(t)) { toast('Mesa ocupada — liberta primeiro'); return; }
  const prev = cloneConfig();
  const idx = tablesConfig[section].indexOf(t);
  const cfg = cloneConfig();
  cfg[section] = cfg[section].filter((x) => x !== t);
  saveConfig(cfg);
  lastAction = { undo: () => saveConfig(prev) };
  toast(`Mesa ${t} removida`, true);
}
function resetTables() {
  const prev = cloneConfig();
  saveConfig(defaultTables());
  lastAction = { undo: () => saveConfig(prev) };
  toast('Mesas repostas ao original', true);
}
function addTable(label, section) {
  const l = (label || '').trim();
  if (!l) return;
  if (tablesConfig.esplanada.includes(l) || tablesConfig.sala.includes(l)) { toast('Essa mesa já existe'); return; }
  const cfg = { esplanada: [...tablesConfig.esplanada], sala: [...tablesConfig.sala] };
  cfg[section].push(l);
  applyConfig(cfg); store.setTables(cfg);
  toast(`Mesa ${l} adicionada`);
}
function openAddTable(section) {
  addSection = section;
  const nums = tablesConfig[section].map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  $('addInput').value = section === 'esplanada' && nums.length ? String(Math.max(...nums) + 1) : '';
  $('addScrim').classList.remove('hidden'); $('addBox').classList.remove('hidden');
  setTimeout(() => $('addInput').focus(), 60);
}
function closeAdd() { $('addScrim').classList.add('hidden'); $('addBox').classList.add('hidden'); }

/* ---- arrastar para trocar de sítio (rato e toque, imediato) ---- */
let drag = null;
function onDragStart(e, label, section) {
  if (!editMode || (e.target.closest && e.target.closest('.tile-x'))) return;
  drag = { label, section, x0: e.clientX, y0: e.clientY, el: e.currentTarget, started: false, target: null };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* iOS antigo */ }
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd, { once: true });
  window.addEventListener('pointercancel', onDragCancel, { once: true });
}
function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0; const dy = e.clientY - drag.y0;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 6) return; // ainda é um toque, não um arrasto
    const r = drag.el.getBoundingClientRect();
    const c = drag.el.cloneNode(true);
    c.classList.remove('editing'); c.classList.add('drag-clone'); // mantém cor de estado
    c.style.cssText = `width:${r.width}px;height:${r.height}px;left:${r.left}px;top:${r.top}px`;
    c.dx = e.clientX - r.left; c.dy = e.clientY - r.top;
    document.body.appendChild(c);
    drag.clone = c; drag.el.classList.add('drag-src'); drag.started = true;
  }
  drag.clone.style.left = `${e.clientX - drag.clone.dx}px`;
  drag.clone.style.top = `${e.clientY - drag.clone.dy}px`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const tt = under && under.closest ? under.closest('.tile') : null;
  document.querySelectorAll('.tile.drop-target').forEach((t) => t.classList.remove('drop-target'));
  drag.target = null;
  if (tt && !tt.classList.contains('add-tile') && !tt.classList.contains('drag-src') && tt.dataset.section === drag.section) {
    tt.classList.add('drop-target'); drag.target = tt.dataset.label;
  }
  e.preventDefault();
}
function onDragEnd() { endDrag(true); }
function onDragCancel() { endDrag(false); }
function endDrag(commit) {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  if (!drag) return;
  drag.clone && drag.clone.remove();
  document.querySelectorAll('.tile.drag-src,.tile.drop-target').forEach((t) => t.classList.remove('drag-src', 'drop-target'));
  if (commit && drag.started && drag.target && drag.target !== drag.label) {
    const arr = [...tablesConfig[drag.section]];
    const from = arr.indexOf(drag.label); const to = arr.indexOf(drag.target);
    if (from > -1 && to > -1) {
      arr.splice(from, 1); arr.splice(to, 0, drag.label);
      const cfg = cloneConfig(); cfg[drag.section] = arr; saveConfig(cfg);
    }
  }
  drag = null;
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
  if (editMode) return; // em edição, o tile só remove (pelo ✕); toque no corpo não faz nada
  if (seatingWait) { // a sentar alguém da lista de espera
    const og = groupOf(t);
    if (og && !og.attendedAt) return; // ocupada por grupo ainda à espera — não mexe
    // mesa azul (grupo já atendido) pode: ao confirmar, o grupo antigo vai para o histórico
    selection = selection.includes(t) ? selection.filter((x) => x !== t) : [...selection, t];
    updateSeatBar(); renderMap();
    return;
  }
  if (movingId) {
    // a trocar de mesa: destino = mesa livre, mesa do próprio grupo, ou mesa já atendida (azul) doutro grupo
    const og = groupOf(t);
    if (og && og.id !== movingId && !og.attendedAt) return; // à espera doutro grupo — não mexe
    selection = selection.includes(t) ? selection.filter((x) => x !== t) : [...selection, t];
    updateMoveBar(); renderMap();
    return;
  }
  if (joining) {
    // modo juntar: alterna mesas livres OU já atendidas (azul) na seleção; à espera (garnet) ignora-se
    const og = groupOf(t);
    if (og && !og.attendedAt) return;
    selection = selection.includes(t) ? selection.filter((x) => x !== t) : [...selection, t];
    const swap = selection.some((x) => groupOf(x));
    $('joinBarTables').textContent = selection.length
      ? `Mesa ${tablesLabel(selection)}${swap ? ' · mesa azul vai para o histórico' : ''}`
      : 'toca numa mesa livre';
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

/* trocar um grupo de mesa (mudaram-se de lugar; mantém ordem de chegada) */
function enterMoveMode() {
  const g = live[activeId]; if (!g) return;
  movingId = activeId;
  activeId = null; selection = [];
  $('sheet').classList.add('hidden');
  $('scrim').classList.add('hidden');
  $('moveBar').classList.remove('hidden');
  updateMoveBar();
  renderMap();
}
function updateMoveBar() {
  const g = live[movingId]; if (!g) { cancelMove(); return; }
  const swap = selection.some((x) => { const og = groupOf(x); return og && og.id !== movingId; });
  $('moveBarTxt').innerHTML = selection.length
    ? `Mesa ${tablesLabel(g.tables)} → <b>${tablesLabel(selection)}</b>${swap ? ' · mesa azul vai para o histórico' : ''}`
    : `Mesa ${tablesLabel(g.tables)} → <b>toca na mesa nova</b>`;
}
async function finishMove() {
  const g = live[movingId];
  if (!g || !selection.length) { cancelMove(); return; }
  const from = sortTables(g.tables || []);
  const to = sortTables(selection);
  const id = movingId;
  const displaced = occupantsToArchive(to, id); // mesas de destino já atendidas (azul) doutro grupo → histórico
  movingId = null; selection = [];
  $('moveBar').classList.add('hidden');
  if (from.join('|') === to.join('|')) { renderMap(); return; } // ficou igual
  for (const og of displaced) await store.freeGroup(og, store.stamp());
  await store.updateGroup(id, { tables: to });
  lastAction = { undo: () => store.updateGroup(id, { tables: from }) };
  toast(`Mesa ${tablesLabel(from)} → ${tablesLabel(to)} ✓`, true);
  renderMap();
}
function cancelMove() {
  movingId = null; selection = [];
  $('moveBar').classList.add('hidden');
  renderMap();
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
  const nameWord = g.name ? `${g.name} · ` : '';
  $('groupMeta').textContent = nameWord + langWord + (attended
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
  $('moveBar').classList.add('hidden'); movingId = null;
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
  const otherOld = occupantsToArchive(tables, reseatId); // outras mesas atendidas (azuis) apanhadas ao juntar
  closeSheet(); // limpa selection, reseatId, etc.
  if (oldSnap) await store.freeGroup(oldSnap, store.stamp()); // grupo anterior → histórico
  for (const og of otherOld) await store.freeGroup(og, store.stamp());
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
  const freed = [...(g.tables || [])];
  await store.freeGroup(g, store.stamp());
  lastAction = { undo: () => store.restoreGroup(snapshot) };
  toast(`Mesa ${tablesLabel(g.tables)} libertada`, true);
  maybePromptSeat(freed); // há gente à espera? sugere sentar já
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
    <div class="spot-meta">${next.name ? `<b>${next.name}</b> · ` : ''}${paxWord(next.pax)} · entrou às ${fmtTime(next.arrivedAt)}${more}</div>
    <button class="btn primary big spot-attend">Atendida ✓</button>`;
  spot.querySelector('.spot-attend').addEventListener('click', () => attend(next.id));
  const main = spot.querySelector('.spot-main');
  main.addEventListener('click', () => openGroupSheet(next.id));
  main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroupSheet(next.id); } });
}

/* -------------------- lista de espera de mesa ----------------------- */
// estimativa de espera: usa o tempo médio à mesa aprendido + quantas mesas estão ocupadas
function waitEstimate(index) {
  const dine = avgDineMin();
  if (!dine) return null; // ainda a aprender
  const all = [...tablesConfig.esplanada, ...tablesConfig.sala];
  const occ = {}; Object.values(live).forEach((g) => (g.tables || []).forEach((t) => { occ[t] = g; }));
  const openings = all.map((t) => {
    const g = occ[t];
    if (!g) return 0; // livre agora
    return g.attendedAt ? Math.max(0, dine - minsSince(g.attendedAt)) : dine; // a comer / acabou de sentar
  }).sort((a, b) => a - b);
  const raw = index < openings.length ? openings[index] : (openings[openings.length - 1] || 0) + dine;
  return raw <= 2 ? 0 : Math.max(5, Math.round(raw / 5) * 5); // 0 = já livre; senão arredonda a 5 min
}
function estChipHtml(est) {
  if (est === null) return '';
  return est === 0 ? '<span class="chip ready">mesa livre</span>' : `<span class="chip soft">~${est} min</span>`;
}
function renderWait() {
  const parties = Object.values(waitlist).sort((a, b) => a.addedAt - b.addedAt);
  const badge = $('waitBadge');
  badge.textContent = parties.length; badge.classList.toggle('hidden', !parties.length);
  $('waitListCount').textContent = parties.length ? `· ${parties.length}` : '';
  const list = $('waitList'); list.innerHTML = '';
  parties.forEach((w, i) => {
    const card = document.createElement('div');
    card.className = 'qcard waiting';
    card.innerHTML = `
      <span class="pos">${i + 1}º</span>
      <div class="who">
        <div class="tables">${w.name || 'Sem nome'}${w.lang ? `<span class="lang-badge">${w.lang.toUpperCase()}</span>` : ''}</div>
        <div class="meta">${paxWord(w.pax)} · há ${minsSince(w.addedAt)} min</div>
      </div>
      ${estChipHtml(waitEstimate(i))}
      <button class="attend seat-btn">Sentar</button>
      <button class="t-del wait-del" aria-label="Remover da espera">✕</button>`;
    card.querySelector('.seat-btn').addEventListener('click', () => startSeating(w.id));
    card.querySelector('.wait-del').addEventListener('click', () => removeWaitParty(w.id));
    list.appendChild(card);
  });
  $('waitList').classList.toggle('hidden', !parties.length);
  $('waitEmpty').classList.toggle('hidden', !!parties.length);
}
function removeWaitParty(id) {
  const w = waitlist[id]; if (!w) return;
  store.removeWait(id);
  lastAction = { undo: () => store.addWait(w) };
  toast(`${w.name || 'Grupo'} saiu da espera`, true);
}
function openWaitAdd() {
  waitVal = 2; waitLang = null;
  $('waitName').value = ''; paintLangRow($('waitLang'), null); $('waitValue').textContent = waitVal;
  const est = waitEstimate(Object.keys(waitlist).length); // estimativa para o próximo da fila
  $('waitEstHint').textContent = est === null ? '' : est === 0 ? 'Há mesa livre agora — dá para sentar já.' : `Espera estimada: ~${est} min`;
  $('waitScrim').classList.remove('hidden'); $('waitBox').classList.remove('hidden');
  setTimeout(() => $('waitName').focus(), 60);
}
function closeWaitAdd() { $('waitScrim').classList.add('hidden'); $('waitBox').classList.add('hidden'); }
function stepWait(d) { waitVal = Math.max(1, Math.min(60, waitVal + d)); $('waitValue').textContent = waitVal; }
async function confirmWaitAdd() {
  const name = $('waitName').value.trim();
  const w = { id: newId(), name, pax: waitVal, addedAt: store.stamp(), ...(waitLang ? { lang: waitLang } : {}) };
  closeWaitAdd();
  await store.addWait(w);
  toast(`${name || 'Grupo'} · ${paxWord(waitVal)} à espera`);
}

// sentar alguém da espera: escolhe a(s) mesa(s) no mapa e confirma
function startSeating(id, presetTable) {
  const w = waitlist[id]; if (!w) return;
  hideReady();
  seatingWait = { ...w }; selection = presetTable && !groupOf(presetTable) ? [presetTable] : [];
  setView('map');
  $('seatBar').classList.remove('hidden');
  updateSeatBar(); renderMap();
}

/* alerta "mesa livre" — quando libertas e há gente à espera, sugere sentar já */
let readyTimer = null; let pendingReady = null;
function maybePromptSeat(freedTables) {
  const parties = Object.values(waitlist).sort((a, b) => a.addedAt - b.addedAt);
  if (!parties.length) return;
  const next = parties[0];
  const table = sortTables(freedTables)[0];
  pendingReady = { waitId: next.id, table };
  $('readyTxt').innerHTML = `Mesa <b>${table}</b> livre · sentar <b>${next.name || 'próximo'}</b> (${next.pax}p)?`;
  $('readyBar').classList.remove('hidden');
  clearTimeout(readyTimer); readyTimer = setTimeout(hideReady, 20000);
}
function hideReady() { $('readyBar').classList.add('hidden'); clearTimeout(readyTimer); }
function updateSeatBar() {
  if (!seatingWait) return;
  const who = `${seatingWait.name || 'Grupo'} (${seatingWait.pax}p)`;
  const swap = selection.some((t) => groupOf(t));
  $('seatBarTxt').innerHTML = selection.length
    ? `Sentar <b>${who}</b> · Mesa ${tablesLabel(selection)}${swap ? ' · anterior vai para o histórico' : ''}`
    : `Escolhe a mesa para <b>${who}</b>`;
}
async function confirmSeat() {
  if (!seatingWait || !selection.length) { cancelSeating(); return; }
  const w = seatingWait;
  const g = { id: newId(), tables: sortTables(selection), pax: w.pax, arrivedAt: store.stamp(), ...(w.name ? { name: w.name } : {}), ...(w.lang ? { lang: w.lang } : {}) };
  const leaving = occupantsToArchive(selection);
  seatingWait = null; selection = []; $('seatBar').classList.add('hidden');
  for (const og of leaving) await store.freeGroup({ ...og }, store.stamp()); // mesa azul → grupo anterior para o histórico
  await store.addGroup(g);
  await store.removeWait(w.id);
  toast(`${w.name || 'Grupo'} sentado na Mesa ${tablesLabel(g.tables)} ✓`);
  renderMap();
}
function cancelSeating() { seatingWait = null; selection = []; $('seatBar').classList.add('hidden'); renderMap(); }

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
        ${g.name ? `<div class="who-name">${g.name}</div>` : ''}
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
        ${g.name ? `<div class="who-name">${g.name}</div>` : ''}
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
  renderTodayList();
  renderDaysTable();
}

// lista de todos os grupos de hoje (ativos + já saíram) com eliminar — corrigir enganos
function renderTodayList() {
  const rows = [
    ...Object.entries(live).map(([id, e]) => ({ id, e, src: 'live' })),
    ...Object.entries(todayLog).map(([id, e]) => ({ id, e, src: 'day' })),
  ].sort((a, b) => b.e.arrivedAt - a.e.arrivedAt);
  const list = $('todayList'); list.innerHTML = '';
  rows.forEach(({ id, e, src }) => {
    const state = src === 'day' ? { cls: 'gone', txt: 'saiu' }
      : e.attendedAt ? { cls: 'seated', txt: 'na sala' } : { cls: 'waiting', txt: 'à espera' };
    const lang = e.lang ? ` · ${e.lang.toUpperCase()}` : '';
    const row = document.createElement('div');
    row.className = 'today-row';
    row.innerHTML = `
      <span class="t-tables">${tablesLabel(e.tables)}</span>
      <span class="t-meta">${paxWord(e.pax)}${lang} · ${fmtTime(e.arrivedAt)}</span>
      <span class="t-status ${state.cls}">${state.txt}</span>
      <button class="t-del" aria-label="Eliminar grupo">✕</button>`;
    row.querySelector('.t-del').addEventListener('click', () => deleteEntry(id, e, src));
    list.appendChild(row);
  });
  $('todayList').classList.toggle('hidden', !rows.length);
  $('todayEmpty').classList.toggle('hidden', !!rows.length);
}

// limpar dados de teste (com confirmação) — repor tudo a zero antes de abrir
function askWipe() { $('confirmScrim').classList.remove('hidden'); $('confirmBox').classList.remove('hidden'); }
function closeConfirm() { $('confirmScrim').classList.add('hidden'); $('confirmBox').classList.add('hidden'); }
async function doWipe() {
  closeConfirm();
  await store.clearAll();
  try {
    localStorage.removeItem('cz_dine'); // esquece os tempos aprendidos nos testes
    Object.keys(localStorage).filter((k) => k.startsWith('cz_alerted_')).forEach((k) => localStorage.removeItem(k));
  } catch { /* nada */ }
  lastAction = null;
  toast('Dados de teste apagados — tudo a zero ✓');
}

async function deleteEntry(id, e, src) {
  const snap = { ...e };
  if (src === 'live') {
    await store.removeGroup(id);
    lastAction = { undo: () => store.addGroup({ id, ...snap }) };
  } else {
    const dk = dayKey(e.arrivedAt);
    await store.removeDayEntry(dk, id);
    lastAction = { undo: () => store.addDayEntry(dk, id, snap) };
  }
  toast(`Mesa ${tablesLabel(e.tables)} eliminada`, true);
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
  document.querySelector('.views').classList.toggle('wait-active', v === 'wait');
  localStorage.setItem('cz_view', v);
  if (v === 'day') renderDay();
  if (v === 'wait') renderWait();
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
  await store.addWait({ id: newId(), name: 'Silva', pax: 4, addedAt: now - 9 * M });
  await store.addWait({ id: newId(), name: 'García', pax: 2, addedAt: now - 4 * M, lang: 'es' });
  for (const [t, p, a] of [[['109'], 2, 190], [['110'], 4, 175], [['117'], 5, 160], [['Sala 1'], 3, 150], [['126'], 2, 140], [['122'], 4, 95], [['100'], 6, 80]]) {
    const g = mk(t, p, a, a - 6, a - 60);
    await store.freeGroup({ ...g }, now - (a - 60) * M);
  }
}

/* ---------------------- atualização automática ---------------------- */
let loadedVer = null;
async function checkVersion() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (loadedVer === null) { loadedVer = data.v; return; } // 1ª vez: guarda a versão atual
    if (data.v && data.v !== loadedVer) $('updateBar').classList.remove('hidden'); // mudou → avisa
  } catch { /* offline — ignora */ }
}

/* ------------------------------ ajuda ------------------------------- */
function openHelp() { $('help').classList.remove('hidden'); }
function closeHelp() { $('help').classList.add('hidden'); }

/* ------------------------------ Modo TV ----------------------------- */
let tvActive = false;
function renderTV() {
  if (!tvActive) return;
  const waiting = Object.values(live).filter((g) => !g.attendedAt).sort((a, b) => a.arrivedAt - b.arrivedAt);
  const next = waiting[0];
  const nx = $('tvNext');
  if (next) {
    const mins = minsSince(next.arrivedAt);
    const sev = mins >= CRIT_MIN ? 'crit' : mins >= WARN_MIN ? 'warn' : '';
    nx.className = `tv-next ${sev}`;
    nx.innerHTML = `<div class="tv-eyebrow">Próxima mesa</div>
      <div class="tv-num">${tablesLabel(next.tables)}</div>
      <div class="tv-meta">${next.name ? `${next.name} · ` : ''}${paxWord(next.pax)}${next.lang ? ` · ${LANG_WORD[next.lang]}` : ''} · entrou às ${fmtTime(next.arrivedAt)}</div>
      <div class="tv-wait">${mins} min de espera</div>`;
  } else {
    nx.className = 'tv-next calm';
    nx.innerHTML = '<div class="tv-eyebrow">Serviço</div><div class="tv-calm">Sala tranquila</div><div class="tv-meta">Mar calmo · ninguém à espera 🌊</div>';
  }
  const rest = waiting.slice(1);
  $('tvQueue').innerHTML = rest.length
    ? `<div class="tv-qtitle">A seguir</div>${rest.map((g, i) => `<div class="tv-qrow"><span class="tv-qpos">${i + 2}º</span><span class="tv-qtables">${tablesLabel(g.tables)}</span><span class="tv-qmeta">${paxWord(g.pax)}</span><span class="tv-qwait">${minsSince(g.arrivedAt)} min</span></div>`).join('')}`
    : '';
}
function enterTV() {
  tvActive = true;
  $('tv').classList.remove('hidden'); $('tv').setAttribute('aria-hidden', 'false');
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  renderTV();
}
function exitTV() {
  tvActive = false;
  $('tv').classList.add('hidden'); $('tv').setAttribute('aria-hidden', 'true');
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

/* --------------------------- código de acesso ----------------------- */
// Porta leve: mantém curiosos e enganos fora e é lembrada por aparelho.
// NÃO é segurança a sério da base de dados (a config é pública) — para trancar
// mesmo os dados era preciso Firebase Auth. Ver nota ao Diogo.
const PIN = atob('ODkwMA=='); // 8900
const PIN_KEY = 'cz_unlocked';
let pinBuf = '';
const locked = () => localStorage.getItem(PIN_KEY) !== '1';
function showLock(onOk) {
  const dotsEl = $('lockDots');
  const paint = () => [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  const fail = () => { const l = $('lock'); l.classList.add('shake'); setTimeout(() => { l.classList.remove('shake'); pinBuf = ''; paint(); }, 430); };
  const press = (d) => {
    if (pinBuf.length >= 4) return;
    pinBuf += d; paint();
    if (pinBuf.length < 4) return;
    if (pinBuf === PIN) { localStorage.setItem(PIN_KEY, '1'); document.documentElement.dataset.unlocked = '1'; onOk(); }
    else fail();
  };
  $('lockPad').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.hasAttribute('data-back')) { pinBuf = pinBuf.slice(0, -1); paint(); } else press(b.textContent.trim());
  }));
  window.addEventListener('keydown', (e) => {
    if (document.documentElement.dataset.unlocked === '1') return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') { pinBuf = pinBuf.slice(0, -1); paint(); }
  });
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
  store.onConfig(applyConfig); // disposição de mesas sincronizada
  store.onWaitlist((v) => { waitlist = v || {}; renderWait(); });
  store.onLive((v) => { live = v || {}; renderMap(); renderQueue(); checkAlerts(); renderTV(); if (currentView() === 'day') renderDay(); });
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
  $('btnMove').addEventListener('click', enterMoveMode);
  $('moveDone').addEventListener('click', finishMove);
  $('moveCancel').addEventListener('click', cancelMove);
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
  $('wipeBtn').addEventListener('click', askWipe);
  $('confirmCancel').addEventListener('click', closeConfirm);
  $('confirmScrim').addEventListener('click', closeConfirm);
  $('confirmWipe').addEventListener('click', doWipe);
  $('editBtn').addEventListener('click', toggleEdit);
  $('resetBtn').addEventListener('click', resetTables);
  $('tvBtn').addEventListener('click', enterTV);
  $('tvExit').addEventListener('click', exitTV);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (tvActive) exitTV();
    else if (movingId) cancelMove();
    else if (!$('help').classList.contains('hidden')) closeHelp();
  });
  // lista de espera
  $('waitAddBtn').addEventListener('click', openWaitAdd);
  $('waitCancel').addEventListener('click', closeWaitAdd);
  $('waitScrim').addEventListener('click', closeWaitAdd);
  $('waitConfirm').addEventListener('click', confirmWaitAdd);
  $('waitName').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmWaitAdd(); });
  $('waitMinus').addEventListener('click', () => stepWait(-1));
  $('waitPlus').addEventListener('click', () => stepWait(1));
  $('waitLang').querySelectorAll('.lang-chip').forEach((b) => b.addEventListener('click', () => {
    waitLang = waitLang === b.dataset.lang ? null : b.dataset.lang;
    paintLangRow($('waitLang'), waitLang);
  }));
  $('seatDone').addEventListener('click', confirmSeat);
  $('readySeat').addEventListener('click', () => { if (pendingReady) startSeating(pendingReady.waitId, pendingReady.table); });
  $('readyDismiss').addEventListener('click', hideReady);
  $('helpBtn').addEventListener('click', openHelp);
  $('helpClose').addEventListener('click', closeHelp);
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) closeHelp(); });
  $('updateReload').addEventListener('click', () => location.reload());
  $('addCancel').addEventListener('click', closeAdd);
  $('addScrim').addEventListener('click', closeAdd);
  $('addConfirm').addEventListener('click', () => { addTable($('addInput').value, addSection); closeAdd(); });
  $('addInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { addTable($('addInput').value, addSection); closeAdd(); } });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!localStorage.getItem('cz_theme')) paintTheme(); });
  $('paxMinus').addEventListener('click', () => stepPax(-1));
  $('paxPlus').addEventListener('click', () => stepPax(1));
  $('toastUndo').addEventListener('click', async () => {
    $('toast').classList.add('hidden');
    if (lastAction) { await lastAction.undo(); lastAction = null; }
  });

  const clock = $('clock');
  const tickClock = () => {
    const t = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    clock.textContent = t; $('tvClock').textContent = t;
  };
  tickClock(); setInterval(tickClock, 15000);

  setInterval(() => { renderMap(); renderQueue(); checkAlerts(); renderTV(); if (activeId) renderGroupPane(); }, 20000);

  setView(localStorage.getItem('cz_view') || 'map');

  if ('serviceWorker' in navigator && !window.__PREVIEW__ && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (!window.__PREVIEW__ && location.protocol.startsWith('http')) {
    checkVersion();
    setInterval(checkVersion, 150000); // verifica nova versão a cada ~2,5 min
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  }
}

function currentView() { return document.querySelector('.tab.active')?.dataset.view || 'map'; }
function stepPax(d) {
  const g = live[activeId]; if (!g) return;
  const pax = Math.max(1, Math.min(60, (g.pax || 1) + d));
  $('paxValue').textContent = pax;
  store.updateGroup(activeId, { pax });
}

// arranca já se em demo ou aparelho desbloqueado; senão pede o código primeiro
if (window.__PREVIEW__ || !locked()) { document.documentElement.dataset.unlocked = '1'; main(); }
else showLock(main);
