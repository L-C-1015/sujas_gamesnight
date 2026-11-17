// data layer: Firebase Realtime Database, or a local demo store with the same interface

export const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
};

// marks a value as an atomic increment
export const inc = n => ({__inc: n});

const PATHS = ['players', 'log', 'settings', 'config'];

export async function firebaseStore(cfg){
  const B = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const {initializeApp} = await import(B + 'firebase-app.js');
  const D = await import(B + 'firebase-database.js');
  const A = await import(B + 'firebase-auth.js');
  const app = initializeApp(cfg);
  const db = D.getDatabase(app), auth = A.getAuth(app);
  return {
    demo: false,
    onData(cb){
      const s = {players:{}, log:{}, settings:{}, config:null};
      for (const p of PATHS){
        const r = p === 'log' ? D.query(D.ref(db, 'log'), D.limitToLast(400)) : D.ref(db, p);
        D.onValue(r, x => { s[p] = x.val() || (p === 'config' ? null : {}); cb(s); });
      }
    },
    newId: path => D.push(D.ref(db, path)).key,
    // multi-path update, so a whole game result lands at once or not at all
    async write(upd){
      const u = {};
      for (const [k, v] of Object.entries(upd)) u[k] = v && v.__inc !== undefined ? D.increment(v.__inc) : v;
      await D.update(D.ref(db), u);
    },
    onAuth: cb => A.onAuthStateChanged(auth, u => cb(u ? {email: u.email} : null)),
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    signOut: () => A.signOut(auth),
  };
}

export function localStore(){
  // demo: data lives in this browser only, synced across tabs
  const KEY = 'gn-demo';
  let data = LS.get(KEY, {});
  const cbs = [], acbs = [];
  let bc; try{ bc = new BroadcastChannel(KEY); }catch{}
  const snap = () => ({players: data.players || {}, log: data.log || {}, settings: data.settings || {}, config: data.config || null});
  const emit = () => cbs.forEach(cb => cb(snap()));
  if (bc) bc.onmessage = () => { data = LS.get(KEY, data); emit(); };
  const setUser = u => { LS.set(KEY + '-user', u); acbs.forEach(cb => cb(u)); };
  return {
    demo: true,
    onData(cb){ cbs.push(cb); cb(snap()); },
    newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    async write(upd){
      for (const [path, v] of Object.entries(upd)){
        const ks = path.split('/'); let o = data;
        for (const k of ks.slice(0, -1)){ o[k] ??= {}; o = o[k]; }
        const last = ks.at(-1);
        if (v && v.__inc !== undefined) o[last] = (o[last] || 0) + v.__inc;
        else if (v === null) delete o[last];
        else o[last] = JSON.parse(JSON.stringify(v));
      }
      LS.set(KEY, data); bc?.postMessage(1); emit();
    },
    onAuth(cb){ acbs.push(cb); cb(LS.get(KEY + '-user', null)); },
    async signIn(e){ setUser({email: e || 'host'}); },
    async signOut(){ setUser(null); },
  };
}
