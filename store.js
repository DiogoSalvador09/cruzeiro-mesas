// Camada de dados: Firebase RTDB (sincronizado) ou localStorage (um aparelho).
// A mesma interface nos dois modos — a app não sabe a diferença.
import { firebaseConfig } from './firebase-config.js';

export const dayKey = (ts) => {
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ============================= FIREBASE ============================= */
async function firebaseStore(cfg) {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
  const {
    getDatabase, ref, onValue, set, update, remove, get, query, orderByKey, limitToLast, serverTimestamp,
  } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js');

  const db = getDatabase(initializeApp(cfg));
  const clean = (g) => { const o = { ...g }; Object.keys(o).forEach((k) => o[k] == null && delete o[k]); return o; };

  // relógio partilhado: usa a hora do servidor para todos concordarem na ordem de chegada
  let skew = 0;
  onValue(ref(db, '.info/serverTimeOffset'), (s) => { skew = s.val() || 0; });
  const MIRROR = 'cz_mirror';

  return {
    mode: 'firebase',
    stamp: () => serverTimestamp(),
    nowMs: () => Date.now() + skew,
    onLive(cb) {
      // pinta já o último quadro guardado (aguenta recarregar sem net), depois o ao-vivo
      try { const m = JSON.parse(localStorage.getItem(MIRROR) || 'null'); if (m) cb(m); } catch { /* vazio */ }
      onValue(ref(db, 'live'), (s) => {
        const v = s.val() || {};
        try { localStorage.setItem(MIRROR, JSON.stringify(v)); } catch { /* cheio */ }
        cb(v);
      });
    },
    onToday(cb) {
      let off = null;
      const attach = () => {
        if (off) off();
        const k = dayKey();
        off = onValue(ref(db, `days/${k}`), (s) => cb(k, s.val() || {}));
      };
      attach();
      setInterval(() => attach(), 10 * 60 * 1000); // atravessa a meia-noite
    },
    onConnection(cb) { onValue(ref(db, '.info/connected'), (s) => cb(!!s.val())); },
    addGroup(g) { return set(ref(db, `live/${g.id}`), clean(g)); },
    updateGroup(id, patch) { return update(ref(db, `live/${id}`), patch); },
    removeGroup(id) { return remove(ref(db, `live/${id}`)); },
    async freeGroup(g, freedAt) {
      const entry = clean({ ...g, freedAt });
      delete entry.id;
      await set(ref(db, `days/${dayKey(g.arrivedAt)}/${g.id}`), entry);
      await remove(ref(db, `live/${g.id}`));
    },
    async restoreGroup(g) {
      await remove(ref(db, `days/${dayKey(g.arrivedAt)}/${g.id}`));
      const entry = clean({ ...g }); delete entry.id; delete entry.freedAt;
      await set(ref(db, `live/${g.id}`), entry);
    },
    async fetchDays(n) {
      const s = await get(query(ref(db, 'days'), orderByKey(), limitToLast(n)));
      return s.val() || {};
    },
  };
}

/* ============================== LOCAL =============================== */
function localStore() {
  const LIVE = 'cz_live'; const DAYS = 'cz_days';
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('cz') : null;

  let liveCbs = []; let todayCbs = [];
  const emitLive = () => { const v = read(LIVE); liveCbs.forEach((cb) => cb(v)); };
  const emitToday = () => { const k = dayKey(); const v = read(DAYS)[k] || {}; todayCbs.forEach((cb) => cb(k, v)); };
  const broadcast = () => { bc && bc.postMessage('sync'); };
  if (bc) bc.onmessage = () => { emitLive(); emitToday(); };
  window.addEventListener('storage', () => { emitLive(); emitToday(); });

  return {
    mode: 'local',
    stamp: () => Date.now(),
    nowMs: () => Date.now(),
    onLive(cb) { liveCbs.push(cb); cb(read(LIVE)); },
    onToday(cb) { todayCbs.push(cb); cb(dayKey(), read(DAYS)[dayKey()] || {}); },
    onConnection(cb) { cb(true); },
    async addGroup(g) { const v = read(LIVE); v[g.id] = g; write(LIVE, v); emitLive(); broadcast(); },
    async updateGroup(id, patch) {
      const v = read(LIVE); if (!v[id]) return;
      v[id] = { ...v[id], ...patch };
      Object.keys(v[id]).forEach((k) => v[id][k] == null && delete v[id][k]);
      write(LIVE, v); emitLive(); broadcast();
    },
    async removeGroup(id) { const v = read(LIVE); delete v[id]; write(LIVE, v); emitLive(); broadcast(); },
    async freeGroup(g, freedAt) {
      const days = read(DAYS); const k = dayKey(g.arrivedAt);
      days[k] = days[k] || {};
      const entry = { ...g, freedAt }; delete entry.id;
      days[k][g.id] = entry; write(DAYS, days);
      const v = read(LIVE); delete v[g.id]; write(LIVE, v);
      emitLive(); emitToday(); broadcast();
    },
    async restoreGroup(g) {
      const days = read(DAYS); const k = dayKey(g.arrivedAt);
      if (days[k]) { delete days[k][g.id]; write(DAYS, days); }
      const v = read(LIVE); const entry = { ...g }; delete entry.freedAt;
      v[g.id] = entry; write(LIVE, v);
      emitLive(); emitToday(); broadcast();
    },
    async fetchDays(n) {
      const days = read(DAYS);
      return Object.fromEntries(Object.keys(days).sort().slice(-n).map((k) => [k, days[k]]));
    },
  };
}

export async function createStore() {
  if (firebaseConfig) {
    try { return await firebaseStore(firebaseConfig); }
    catch (e) { console.error('Firebase falhou, a usar modo local:', e); }
  }
  return localStore();
}
