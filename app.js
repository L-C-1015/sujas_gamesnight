import {FIREBASE_CONFIG} from './firebase-config.js';
import {firebaseStore, localStore, inc, LS} from './store.js';

// used until the host saves their own setup
const DEFAULT_CONFIG = {
  title: 'SUJAS Games Night',
  subtitle: 'ゲームナイト・コイン',
  startCoins: 100,
  brokePolicy: 'warn',
  games: [
    {id:'indian', name:'Indian Poker', sub:'インディアンポーカー', kind:'pot', fee:5, notes:['Same number → rock paper scissors']},
    {id:'poker', name:'Poker', sub:'ポーカー', kind:'bank'},
    {id:'mariokart', name:'Mario Kart', sub:'マリオカート', kind:'ranked', fee:15, max:8, payouts:[50,30,20,10,5,5], notes:["Harvey's Switch, one race each"]},
    {id:'smash', name:'Smash Bros', sub:'スマブラ', kind:'ranked', fee:20, max:6, payouts:[80,40], notes:["Kai's Switch, Battlefield stage"]},
  ],
};

const KINDS = {
  pot:    {label:'Winner takes the pot', help:'Everyone pays the entry fee and one winner takes the lot.'},
  ranked: {label:'Placings & prizes', help:'Everyone pays the entry fee and prizes go by finishing place. Use a fee of 0 for a free prize game.'},
  bank:   {label:'Chips (buy in / cash out)', help:'Players swap coins for chips at the table and cash out when they leave. 1 coin = 1 chip.'},
};
const BROKE = {warn:'Warn the host but allow', block:'Block them from joining', allow:'Allow silently'};
const ORD = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th'];

// ===== helpers =====
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtT = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const sgn = n => n > 0 ? `<span class="pos">+${n}</span>` : `<span class="neg">−${Math.abs(n)}</span>`;
const arr = v => Array.isArray(v) ? v.filter(x => x != null) : v ? Object.values(v) : [];
const sum = a => a.reduce((x, y) => x + y, 0);
const clone = o => JSON.parse(JSON.stringify(o));

function setPath(obj, path, val){
  const ks = path.split('.'); let o = obj;
  ks.slice(0, -1).forEach(k => { o[k] ??= {}; o = o[k]; });
  o[ks.at(-1)] = val;
}

let toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ===== state =====
let S = {players:{}, log:{}, settings:{}, config:null};
let store = null, user = null, loaded = false, lastMe = {};
const blankSt = () => ({sel:[], order:[], step:'pick', q:''});
const ui = {
  me: LS.get('gn-me', null),
  search: '',
  tab: LS.get('gn-tab', null),
  st: LS.get('gn-st', {}),
  pokerAmt: '', newName: '', bulk: '', loginErr: '',
  ev: null,
};
const saveDraft = () => { LS.set('gn-st', ui.st); LS.set('gn-tab', ui.tab); };
const stOf = id => (ui.st[id] ??= blankSt());

// config from the database, falling back to the defaults
function cfg(){
  const c = S.config;
  if (!c || !c.games) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG, ...c,
    games: arr(c.games).map(g => ({...g, payouts: arr(g.payouts), notes: arr(g.notes)})),
  };
}
const games = () => cfg().games;
const gameById = id => games().find(g => g.id === id);

// rule lines shown to players and hosts
function rulesOf(g){
  const r = [];
  if (g.kind === 'pot'){ r.push(g.fee ? `${g.fee} coins to play` : 'Free to play', 'Winner takes the whole pot'); if (g.max) r.push(`Up to ${g.max} players`); }
  if (g.kind === 'ranked'){
    r.push(g.fee ? `${g.fee} coins to play` : 'Free to play');
    if (g.max) r.push(`Up to ${g.max} players`);
    r.push('Prizes: ' + arr(g.payouts).map((p, i) => `${ORD[i]} ${p}`).join(', '));
  }
  if (g.kind === 'bank') r.push('1 coin = 1 chip', 'Buy in at the table, cash out when you leave');
  return [...r, ...arr(g.notes)];
}

function ranked(){
  const a = Object.entries(S.players).map(([id, p]) => ({id, ...p}));
  a.sort((x, y) => (y.coins - x.coins) || String(x.name).localeCompare(y.name));
  let r = 0, prev = null;
  a.forEach((p, i) => { if (p.coins !== prev){ r = i + 1; prev = p.coins; } p.rank = r; });
  return a;
}
const logList = () => Object.entries(S.log).map(([id, e]) => ({id, ...e})).sort((a, b) => b.ts - a.ts);
const pname = id => S.players[id]?.name || '(removed)';
const historyOf = pid => logList().filter(e => e.deltas && e.deltas[pid] != null);
const deltaText = d => Object.entries(d || {}).map(([pid, n]) => `${esc(pname(pid))} ${sgn(n)}`).join(', ');

// ===== writes =====
async function transact(g, label, deltas, extra = {}){
  const id = store.newId('log'), upd = {};
  for (const [pid, d] of Object.entries(deltas)) if (d) upd[`players/${pid}/coins`] = inc(d);
  upd[`log/${id}`] = {ts: Date.now(), station: g.id, stationName: g.name, label, deltas, by: user?.email || '', ...extra};
  await store.write(upd);
}
async function safe(fn, okMsg){
  try{ await fn(); if (okMsg) toast(okMsg); }
  catch(err){ console.error(err); toast('Failed: ' + (err.code || err.message)); }
}
// edit a copy of the config and save the whole thing
const saveConfig = (mut, msg) => { const c = clone(cfg()); mut(c); return safe(() => store.write({config: c}), msg); };

// ===== modal =====
let modalOk = null;
function openModal(html, onOk, okLabel = 'Confirm', okDisabled = false){
  modalOk = onOk;
  $modal.innerHTML = `<div class="mbox">${html}<div class="bar">
    <button class="btn ghost" data-act="mclose">${onOk ? 'Cancel' : 'Close'}</button>
    ${onOk ? `<button class="btn go" data-act="mok" ${okDisabled ? 'disabled' : ''}>${okLabel}</button>` : ''}</div></div>`;
  $modal.classList.remove('hidden');
}
const closeModal = () => { $modal.classList.add('hidden'); $modal.innerHTML = ''; modalOk = null; };

// confirm a coin move, with warnings for players who can't afford it
function confirmDeltas(title, deltas, fee, onOk){
  const policy = cfg().brokePolicy;
  const short = fee ? Object.keys(deltas).filter(pid => (S.players[pid]?.coins ?? 0) < fee) : [];
  const rows = Object.entries(deltas).map(([pid, n]) => {
    const c = S.players[pid]?.coins ?? 0;
    return `<tr><td>${esc(pname(pid))} <small style="color:var(--muted)">(${c} → ${c + n})</small></td><td>${sgn(n)}</td></tr>`;
  }).join('');
  let warn = '';
  if (short.length && policy !== 'allow')
    warn = `<div class="warn">Not enough coins: ${short.map(p => `${esc(pname(p))} (${S.players[p].coins})`).join(', ')}${policy === 'block' ? '. They can’t join this game.' : ''}</div>`;
  openModal(`<h3>${esc(title)}</h3><table>${rows}</table>${warn}`, onOk, 'Confirm', short.length && policy === 'block');
}

// ===== views =====
function header(active){
  const c = cfg(), a = (h, l) => `<a href="#${h}" ${active === h ? 'class="on" aria-current="page"' : ''}>${l}</a>`;
  return `<header><a class="brand" href="#"><span class="b1">${esc(c.title)}</span><span class="b2" lang="ja">${esc(c.subtitle)}</span></a>
    <nav>${a('', 'Board')}${a('tv', 'TV')}${a('host', 'Host')}</nav></header>
    ${store?.demo ? '<p class="demo">Demo mode: data is only saved in this browser.</p>' : ''}`;
}
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th','st','nd','rd'][n % 10] || 'th');
const row = p => `<button class="row ${p.id === ui.me ? 'me' : ''}" data-act="player" data-arg="${p.id}">
  <span class="rk ${p.rank <= 3 ? 'top' : ''}">${p.rank}</span><span class="nm">${esc(p.name)}${p.id === ui.me ? '<i class="you">you</i>' : ''}</span><span class="cn">${p.coins}</span></button>`;

function podium(list){
  const top = list.slice(0, 3);
  if (!top.length) return '';
  return `<section class="result"><p class="result-k">Winner <span lang="ja">優勝</span></p>
    <h2 class="result-name">${esc(top[0].name)}</h2><p class="result-c"><span class="num">${top[0].coins}</span> coins</p>
    ${top.length > 1 ? `<ol class="result-rest">${top.slice(1).map(p => `<li><b>${ordinal(p.rank)}</b><span>${esc(p.name)}</span><em>${p.coins}</em></li>`).join('')}</ol>` : ''}</section>`;
}

const rulesCard = () => `<details class="rules"><summary>Game rules <span lang="ja">ルール</span></summary>
  <p>Everyone starts with ${cfg().startCoins} coins. Most coins at the end wins.</p>
  ${games().map(g => `<h4>${esc(g.name)} <small>${esc(g.sub || '')}</small></h4>${rulesOf(g).map(r => `<p>${esc(r)}</p>`).join('')}`).join('')}</details>`;

function viewBoard(){
  const list = ranked();
  const me = list.find(p => p.id === ui.me);
  const q = ui.search.trim().toLowerCase();
  const shown = q ? list.filter(p => String(p.name).toLowerCase().includes(q)) : list;
  let meHtml = `<p class="intro">Tap your name to follow your coins.<span lang="ja">自分の名前をタップしてね</span></p>`;
  if (me){
    const h = historyOf(me.id).filter(e => !e.undone).slice(0, 4);
    // flash the number when it changes
    const bump = lastMe.id === me.id && lastMe.coins != null && lastMe.coins !== me.coins ? (me.coins > lastMe.coins ? 'up' : 'down') : '';
    lastMe = {id: me.id, coins: me.coins};
    meHtml = `<section class="me"><h2 class="me-name">${esc(me.name)}</h2>
      <div class="me-row"><p class="me-coins ${bump}">${me.coins}<span>coins</span></p>
      <p class="me-rank"><b>${ordinal(me.rank)}</b><span>of ${list.length}</span></p></div>
      ${h.length ? `<ul class="me-hist">${h.map(e => `<li><span>${esc(e.label)}</span>${sgn(e.deltas[me.id])}</li>`).join('')}</ul>` : ''}</section>`;
  }
  return `${header('')}${S.settings.ended ? podium(list) : ''}${meHtml}
    <h2 class="sect">Leaderboard <span lang="ja">ランキング</span></h2>
    <input id="search" class="search" data-bind="search" data-live placeholder="Search names" value="${esc(ui.search)}" autocomplete="off">
    <div class="board">${shown.map(row).join('') || `<div class="empty">${loaded ? 'No players yet' : 'Loading…'}</div>`}</div>
    ${rulesCard()}`;
}

function viewTV(){
  const list = ranked();
  const feed = logList().filter(e => !e.undone && e.station !== 'adjust').slice(0, 7);
  return `<div class="tvwrap"><div>${S.settings.ended ? podium(list) : ''}
    <h1>Leaderboard <span lang="ja">ランキング</span></h1>
    <div class="tvlist">${list.slice(0, 16).map(row).join('') || '<div class="empty">Waiting for players…</div>'}</div></div>
    <aside class="tvside"><div id="qr"></div><p class="scan">Scan to check your coins<span lang="ja">スキャンしてコインを確認</span></p>
    <div class="feed"><b>Latest</b>${feed.map(e => `<div>${esc(e.label)}</div>`).join('')}</div>
    <p><a href="#">Exit TV view</a></p></aside></div>`;
}

function viewHost(){
  if (!store) return header('host') + '<div class="empty">Connecting…</div>';
  if (!user) return `${header('host')}<div class="panel"><h2>Host login</h2><div class="jp">Station hosts only</div>
    <form id="login"><div class="field"><input id="lemail" type="email" placeholder="Email" autocomplete="username"></div>
    <div class="field"><input id="lpw" type="password" placeholder="Password" autocomplete="current-password"></div>
    ${ui.loginErr ? `<div class="warn">${esc(ui.loginErr)}</div>` : ''}
    ${store.demo ? '<div class="hint">Demo: any email and password work.</div>' : ''}
    <div class="bar"><button class="btn" type="submit">Log in</button></div></form></div>`;
  const tabs = [...games().map(g => [g.id, g.name]), ['players', 'Players'], ['log', 'Log / Undo'], ['setup', 'Setup'], ['end', 'End game']];
  if (!tabs.some(([id]) => id === ui.tab)) ui.tab = tabs[0][0];
  const g = gameById(ui.tab);
  let body;
  if (g && S.settings.ended) body = `<div class="ended">The game has ended. To keep playing, reopen it in the End game tab.</div>`;
  else if (g?.kind === 'pot') body = viewPot(g);
  else if (g?.kind === 'ranked') body = viewRanked(g);
  else if (g?.kind === 'bank') body = viewBank(g);
  else if (ui.tab === 'players') body = viewPlayers();
  else if (ui.tab === 'log') body = viewLog();
  else if (ui.tab === 'setup') body = viewSetup();
  else body = viewEnd();
  return `${header('host')}<div class="tabs">${tabs.map(([id, l]) => `<button class="${ui.tab === id ? 'on' : ''}" data-act="tab" data-arg="${id}">${esc(l)}</button>`).join('')}</div>
    <div class="panel">${body}</div>
    <p class="foot">Logged in as ${esc(user.email)}. <a href="#host" data-act="logout">Log out</a></p>`;
}

function picker(g, max){
  const st = stOf(g.id), q = st.q.toLowerCase();
  const ps = Object.entries(S.players).map(([id, p]) => ({id, ...p}))
    .sort((a, b) => String(a.name).localeCompare(b.name))
    .filter(p => !q || String(p.name).toLowerCase().includes(q) || st.sel.includes(p.id));
  return `<input id="q-${g.id}" class="search" data-bind="st.${g.id}.q" data-live placeholder="Search players" value="${esc(st.q)}" autocomplete="off">
    <div class="chips">${ps.map(p => `<button class="chip ${st.sel.includes(p.id) ? 'on' : ''} ${g.fee && p.coins < g.fee ? 'low' : ''}" data-act="toggle" data-arg="${g.id}|${p.id}|${max}">${esc(p.name)} <small>${p.coins}</small></button>`).join('') || '<span class="hint">No players. Add them in the Players tab.</span>'}</div>`;
}
const head = g => `<h2>${esc(g.name)}</h2><div class="jp">${esc(g.sub || KINDS[g.kind].label)}</div><ul class="grules">${rulesOf(g).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;

function viewPot(g){
  const st = stOf(g.id), n = st.sel.length, pot = n * (g.fee || 0), max = g.max || 99;
  if (st.step === 'pick') return `${head(g)}<p class="sel">1. Pick who is playing${g.max ? ` (max ${g.max})` : ''}</p>${picker(g, max)}
    <p class="tally"><span>Playing <b>${n}</b></span><span>Pot <b>${pot}</b></span></p>
    <div class="bar"><button class="btn ghost" data-act="clear" data-arg="${g.id}">Clear</button>
    <button class="btn" data-act="step" data-arg="${g.id}|result" ${n < 2 ? 'disabled' : ''}>Next: pick winner →</button></div>`;
  return `${head(g)}<p class="sel">2. Tap the winner. Pot: <b>${pot}</b> coins</p>
    <div class="entrants">${st.sel.map(pid => `<button class="ent" data-act="potwin" data-arg="${g.id}|${pid}">${esc(pname(pid))}</button>`).join('')}</div>
    <div class="bar"><button class="btn ghost" data-act="step" data-arg="${g.id}|pick">← Back</button></div>`;
}

function viewRanked(g){
  const st = stOf(g.id), n = st.sel.length, pot = n * (g.fee || 0), max = g.max || 99;
  const paid = Math.min(n, g.payouts.length);
  const out = sum(g.payouts.slice(0, paid));
  if (st.step === 'pick') return `${head(g)}<p class="sel">1. Pick players${g.max ? ` (max ${g.max})` : ''}</p>${picker(g, max)}
    <p class="tally"><span>Playing <b>${n}${g.max ? '/' + g.max : ''}</b></span><span>Entry fees <b>${pot}</b></span><span>Prizes <b>${out}</b></span></p>
    ${n >= 2 && g.fee && out !== pot ? `<div class="warn">With ${n} players the prizes (${out}) don’t match the entry fees (${pot}).</div>` : ''}
    <div class="bar"><button class="btn ghost" data-act="clear" data-arg="${g.id}">Clear</button>
    <button class="btn" data-act="step" data-arg="${g.id}|result" ${n < 2 ? 'disabled' : ''}>Game done: enter results →</button></div>`;
  return `${head(g)}<p class="sel">2. Tap players in finishing order (top ${paid} get prizes)</p>
    <div class="entrants">${st.sel.map(pid => { const i = st.order.indexOf(pid);
      return `<button class="ent ${i >= 0 ? 'on' : ''}" data-act="place" data-arg="${g.id}|${pid}">${i >= 0 ? `<span class="pl">${ORD[i]}, +${g.payouts[i]}</span>` : ''}${esc(pname(pid))}</button>`; }).join('')}</div>
    <div class="bar"><button class="btn ghost" data-act="step" data-arg="${g.id}|pick">← Back</button>
    <button class="btn ghost" data-act="resetorder" data-arg="${g.id}">Reset order</button>
    <button class="btn go" data-act="rankok" data-arg="${g.id}" ${st.order.length !== paid ? 'disabled' : ''}>Confirm results</button></div>`;
}

function viewBank(g){
  const st = stOf(g.id);
  let table = 0;
  logList().filter(e => e.station === g.id && !e.undone).forEach(e => Object.values(e.deltas || {}).forEach(d => table -= d));
  const pid = st.sel[0], amt = parseInt(ui.pokerAmt, 10), ok = pid && amt > 0;
  const recent = logList().filter(e => e.station === g.id).slice(0, 8);
  return `${head(g)}<p class="sel">Chips currently on the table: <b>${table}</b></p>
    <p class="sel">1. Pick a player</p>${picker(g, 1)}
    <p class="sel">2. Amount${pid ? ` for <b>${esc(pname(pid))}</b> (has ${S.players[pid]?.coins ?? 0} coins)` : ''}</p>
    <div class="field"><input id="pamt" type="number" inputmode="numeric" min="1" data-bind="pokerAmt" data-live value="${esc(ui.pokerAmt)}" placeholder="e.g. 30"></div>
    <div class="bar"><button class="btn" data-act="bank" data-arg="${g.id}|in" ${ok ? '' : 'disabled'}>Buy in (coins → chips)</button>
    <button class="btn dark" data-act="bank" data-arg="${g.id}|out" ${ok ? '' : 'disabled'}>Cash out (chips → coins)</button></div>
    ${recent.length ? `<h3>Recent</h3>${recent.map(logRow).join('')}` : ''}`;
}

function viewPlayers(){
  const list = ranked().sort((a, b) => String(a.name).localeCompare(b.name));
  return `<h2>Players</h2><div class="jp">${list.length} players. New players start with ${cfg().startCoins} coins.</div>
    <form id="addone"><div class="field"><input id="newname" data-bind="newName" value="${esc(ui.newName)}" placeholder="Name" autocomplete="off"><button class="btn small" type="submit">Add</button></div></form>
    <details><summary class="hint">Add many at once</summary><textarea id="bulk" data-bind="bulk" placeholder="One name per line">${esc(ui.bulk)}</textarea>
    <div class="bar"><button class="btn small" data-act="bulkadd">Add all</button></div></details>
    <div class="plist">${list.map(p => `<div class="pr"><span class="nm">${esc(p.name)}</span><b>${p.coins}</b>
      <span class="acts"><button class="btn ghost small" data-act="adjust" data-arg="${p.id}">Adjust</button>
      <button class="btn ghost small" data-act="rename" data-arg="${p.id}">Rename</button>
      <button class="btn ghost small" data-act="delete" data-arg="${p.id}">Remove</button></span></div>`).join('')}</div>`;
}

function logRow(e){
  const where = e.station === 'adjust' ? 'Adjustment' : gameById(e.station)?.name || e.stationName || e.station;
  return `<div class="loge ${e.undone ? 'undone' : ''}"><div class="t"><span>${fmtT(e.ts)}</span><span>${esc(where)}</span>${e.by ? `<span>${esc(e.by)}</span>` : ''}</div>
    <div><b>${esc(e.label)}</b></div><div class="d">${deltaText(e.deltas)}</div>
    ${!e.undone && e.deltas && Object.keys(e.deltas).length ? `<button class="btn ghost small" data-act="undo" data-arg="${e.id}">Undo</button>` : ''}</div>`;
}
const viewLog = () => `<h2>Log</h2><div class="jp">Every coin move. Undo fixes mistakes.</div>${logList().slice(0, 150).map(logRow).join('') || '<div class="empty">Nothing yet</div>'}`;

// fee vs prize balance for a full table
function balance(g){
  if (g.kind !== 'ranked' || !g.max || !g.fee) return '';
  const fees = g.max * g.fee, prizes = sum(g.payouts);
  return fees === prizes ? `<span class="ok">A full table pays in ${fees} and pays out ${prizes}, so it balances.</span>`
    : `<span class="neg">A full table pays in ${fees} but pays out ${prizes}.</span>`;
}

function viewSetup(){
  const c = cfg(), gs = c.games;
  ui.ev ??= {title: c.title, subtitle: c.subtitle, startCoins: String(c.startCoins), brokePolicy: c.brokePolicy};
  return `<h2>Setup</h2><div class="jp">Event settings and games</div>
    ${!S.config?.games ? '<div class="warn">You’re using the built-in games. Saving any change here creates your own setup.</div>' : ''}
    <h3>Event</h3>
    <form id="eventform">
      <label class="lab">Title<input id="e-title" data-bind="ev.title" value="${esc(ui.ev.title)}"></label>
      <label class="lab">Subtitle<input id="e-sub" data-bind="ev.subtitle" value="${esc(ui.ev.subtitle)}"></label>
      <label class="lab">Starting coins (for new players)<input id="e-start" type="number" min="0" inputmode="numeric" data-bind="ev.startCoins" value="${esc(ui.ev.startCoins)}"></label>
      <label class="lab">If a player can’t afford a game
        <select id="e-broke" data-bind="ev.brokePolicy">${Object.entries(BROKE).map(([k, l]) => `<option value="${k}" ${ui.ev.brokePolicy === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="bar"><button class="btn small" type="submit">Save event settings</button></div>
    </form>
    <h3>Games</h3>
    <div class="glist">${gs.map((g, i) => `<div class="gr"><div class="gi"><b>${esc(g.name)}</b>
      <small>${KINDS[g.kind].label}${g.fee ? `, fee ${g.fee}` : ''}${g.kind === 'ranked' ? `, prizes ${g.payouts.join('/')}` : ''}</small>
      ${balance(g) ? `<br><small>${balance(g)}</small>` : ''}</div>
      <span class="acts"><button class="btn ghost small" data-act="gedit" data-arg="${g.id}">Edit</button>
      <button class="btn ghost small" data-act="gmove" data-arg="${g.id}|-1" ${i === 0 ? 'disabled' : ''}>Move up</button>
      <button class="btn ghost small" data-act="gmove" data-arg="${g.id}|1" ${i === gs.length - 1 ? 'disabled' : ''}>Move down</button>
      <button class="btn ghost small" data-act="gdel" data-arg="${g.id}">Delete</button></span></div>`).join('') || '<div class="empty">No games yet</div>'}</div>
    <div class="bar"><button class="btn" data-act="gedit" data-arg="">+ Add game</button></div>`;
}

function viewEnd(){
  const list = ranked(), total = sum(list.map(p => p.coins || 0));
  return `<h2>End game</h2><div class="jp">終了・優勝発表</div>
    <p class="tally"><span>Players <b>${list.length}</b></span><span>Coins in play <b>${total}</b></span>${list[0] ? `<span>Leader <b>${esc(list[0].name)}</b></span>` : ''}</p>
    <div class="bar">${S.settings.ended
      ? '<button class="btn dark" data-act="reopen">Reopen game</button>'
      : '<button class="btn" data-act="endgame">End game and reveal winner</button>'}</div>
    <p class="hint">Ending the game freezes all stations and shows the podium to everyone.</p>
    <div class="bar wipe"><button class="btn ghost" data-act="wipe">Wipe players & history (keeps your games)</button></div>`;
}

// ===== render =====
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
function render(){
  // keep focus and cursor while live data re-renders
  const a = document.activeElement, fid = $app.contains(a) ? a.id : null;
  let ss = null, se = null; try{ ss = a.selectionStart; se = a.selectionEnd; }catch{}
  const r = location.hash.slice(1);
  document.title = cfg().title;
  document.body.classList.toggle('tv', r === 'tv');
  $app.innerHTML = r === 'tv' ? viewTV() : r === 'host' ? viewHost() : viewBoard();
  if (r === 'tv') drawQR();
  if (fid){ const el = document.getElementById(fid); if (el){ el.focus(); try{ el.setSelectionRange(ss, se); }catch{} } }
}
function drawQR(){
  const el = document.getElementById('qr');
  if (!el) return;
  if (!window.QRCode){ el.style.display = 'none'; return; }
  new window.QRCode(el, {text: location.href.split('#')[0], width: 240, height: 240});
}

// ===== game editor =====
function gameEditor(id){
  const g = id ? gameById(id) : {name:'', sub:'', kind:'ranked', fee:10, max:4, payouts:[25, 15], notes:[]};
  const v = x => esc(x ?? '');
  openModal(`<h3>${id ? 'Edit game' : 'New game'}</h3>
    <label class="lab">Name<input id="m-name" value="${v(g.name)}" placeholder="e.g. Uno"></label>
    <label class="lab">Subtitle (optional)<input id="m-sub" value="${v(g.sub)}" placeholder="e.g. ウノ"></label>
    <label class="lab">Type<select id="m-kind">${Object.entries(KINDS).map(([k, x]) => `<option value="${k}" ${g.kind === k ? 'selected' : ''}>${x.label}</option>`).join('')}</select></label>
    <p class="hint" id="m-help"></p>
    <div data-kinds="pot ranked"><label class="lab">Entry fee (coins)<input id="m-fee" type="number" min="0" inputmode="numeric" value="${v(g.fee)}"></label></div>
    <div data-kinds="pot ranked"><label class="lab">Max players (blank = no limit)<input id="m-max" type="number" min="2" inputmode="numeric" value="${v(g.max)}"></label></div>
    <div data-kinds="ranked"><label class="lab">Prizes by place, comma separated<input id="m-pay" value="${v(arr(g.payouts).join(', '))}" placeholder="50, 30, 20"></label></div>
    <label class="lab">Extra rules, one per line (optional)<textarea id="m-notes" placeholder="e.g. Kai's Switch">${v(arr(g.notes).join('\n'))}</textarea></label>`,
  async () => {
    const val = k => document.getElementById(k).value.trim();
    const kind = val('m-kind'), name = val('m-name');
    const fee = parseInt(val('m-fee') || '0', 10), max = parseInt(val('m-max'), 10);
    const payouts = val('m-pay').split(/[,\s]+/).filter(Boolean).map(Number);
    if (!name){ toast('Give the game a name'); return true; }
    if (kind !== 'bank' && !(fee >= 0)){ toast('Fee must be 0 or more'); return true; }
    if (kind === 'ranked' && (!payouts.length || payouts.some(p => !(p >= 0)))){ toast('Add prizes like 50, 30, 20'); return true; }
    if (val('m-max') && !(max >= 2)){ toast('Max players must be at least 2'); return true; }
    const out = {id: id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) + '-' + Math.random().toString(36).slice(2, 6),
      name: name.slice(0, 30), sub: val('m-sub').slice(0, 30), kind,
      notes: val('m-notes').split('\n').map(s => s.trim()).filter(Boolean)};
    if (kind !== 'bank'){ out.fee = fee; if (max >= 2) out.max = max; }
    if (kind === 'ranked') out.payouts = payouts;
    await saveConfig(c => {
      const i = c.games.findIndex(x => x.id === id);
      if (i >= 0) c.games[i] = out; else c.games.push(out);
    }, id ? 'Game updated' : 'Game added');
  }, id ? 'Save' : 'Add game');
  syncKind();
}
// show only the fields that matter for the chosen type
function syncKind(){
  const k = document.getElementById('m-kind')?.value; if (!k) return;
  document.getElementById('m-help').textContent = KINDS[k].help;
  $modal.querySelectorAll('[data-kinds]').forEach(el => el.style.display = el.dataset.kinds.split(' ').includes(k) ? '' : 'none');
}

// ===== actions =====
const ACT = {
  mclose: closeModal,
  async mok(){ const fn = modalOk; if (!fn) return; const keep = await fn(); if (keep !== true) closeModal(); },
  player(id){
    const p = S.players[id]; if (!p) return;
    const h = historyOf(id), isMe = ui.me === id;
    openModal(`<h3>${esc(p.name)}</h3><p class="m-coins">${p.coins} coins</p>
      ${h.length ? `<table>${h.slice(0, 30).map(e => `<tr style="${e.undone ? 'opacity:.4;text-decoration:line-through' : ''}"><td>${esc(e.label)}<br><small style="color:var(--muted)">${fmtT(e.ts)}</small></td><td>${sgn(e.deltas[id])}</td></tr>`).join('')}</table>` : '<p class="hint">No games yet</p>'}`,
      () => { ui.me = isMe ? null : id; LS.set('gn-me', ui.me); schedule(); }, isMe ? 'Not me' : 'This is me');
  },
  tab(id){ ui.tab = id; if (id === 'setup') ui.ev = null; saveDraft(); render(); },
  async logout(){ await store.signOut(); },
  toggle(arg){
    const [gid, pid, max] = arg.split('|'), st = stOf(gid), m = +max;
    if (st.sel.includes(pid)) st.sel = st.sel.filter(x => x !== pid);
    else if (m === 1) st.sel = [pid];
    else if (st.sel.length < m) st.sel.push(pid);
    else toast(`Max ${m} players`);
    st.order = st.order.filter(x => st.sel.includes(x));
    saveDraft(); render();
  },
  clear(gid){ ui.st[gid] = blankSt(); saveDraft(); render(); },
  step(arg){ const [gid, step] = arg.split('|'), st = stOf(gid); st.step = step; st.sel = st.sel.filter(p => S.players[p]); saveDraft(); render(); },
  resetorder(gid){ stOf(gid).order = []; saveDraft(); render(); },
  potwin(arg){
    const [gid, win] = arg.split('|'), g = gameById(gid), st = stOf(gid), fee = g.fee || 0;
    const pot = st.sel.length * fee, deltas = {};
    st.sel.forEach(pid => deltas[pid] = -fee);
    deltas[win] += pot;
    confirmDeltas(`${pname(win)} wins the pot of ${pot}`, deltas, fee, () => safe(async () => {
      await transact(g, `${g.name}: ${pname(win)} won the pot (${pot})`, deltas);
      ui.st[gid] = blankSt(); saveDraft(); schedule();
    }, 'Saved'));
  },
  place(arg){
    const [gid, pid] = arg.split('|'), g = gameById(gid), st = stOf(gid);
    const paid = Math.min(st.sel.length, g.payouts.length);
    if (st.order.includes(pid)) st.order = st.order.filter(x => x !== pid);
    else if (st.order.length < paid) st.order.push(pid);
    saveDraft(); render();
  },
  rankok(gid){
    const g = gameById(gid), st = stOf(gid), fee = g.fee || 0, deltas = {};
    st.sel.forEach(pid => deltas[pid] = -fee);
    st.order.forEach((pid, i) => deltas[pid] += g.payouts[i]);
    confirmDeltas(`${g.name} results`, deltas, fee, () => safe(async () => {
      await transact(g, `${g.name}: 1st ${pname(st.order[0])}`, deltas, {order: st.order});
      ui.st[gid] = blankSt(); saveDraft(); schedule();
    }, 'Results saved'));
  },
  bank(arg){
    const [gid, dir] = arg.split('|'), g = gameById(gid), pid = stOf(gid).sel[0];
    const amt = parseInt(ui.pokerAmt, 10); if (!pid || !(amt > 0)) return;
    const d = dir === 'in' ? -amt : amt;
    confirmDeltas(`${g.name}: ${dir === 'in' ? 'buy in' : 'cash out'} ${amt}`, {[pid]: d}, dir === 'in' ? amt : 0, () => safe(async () => {
      await transact(g, `${g.name}: ${pname(pid)} ${dir === 'in' ? 'bought in' : 'cashed out'} ${amt}`, {[pid]: d});
      ui.pokerAmt = ''; ui.st[gid] = blankSt(); saveDraft(); schedule();
    }, 'Saved'));
  },
  bulkadd(){ addPlayers(ui.bulk.split('\n')); ui.bulk = ''; },
  adjust(pid){
    openModal(`<h3>Adjust ${esc(pname(pid))}</h3><p class="hint">Use a minus sign to take coins away.</p>
      <input class="minput" id="m-amt" type="number" inputmode="numeric" placeholder="e.g. 10 or -10" style="margin-bottom:8px">
      <input class="minput" id="m-why" placeholder="Reason (optional)">`, async () => {
      const n = parseInt(document.getElementById('m-amt').value, 10);
      const why = document.getElementById('m-why').value.trim();
      if (!n){ toast('Enter an amount'); return true; }
      await safe(() => transact({id: 'adjust', name: 'Adjustment'}, `Adjustment${why ? ': ' + why : ''}`, {[pid]: n}), 'Adjusted');
    });
  },
  rename(pid){
    openModal(`<h3>Rename</h3><input class="minput" id="m-name" value="${esc(pname(pid))}">`, async () => {
      const n = document.getElementById('m-name').value.trim(); if (!n) return true;
      await safe(() => store.write({[`players/${pid}/name`]: n.slice(0, 39)}), 'Renamed');
    });
  },
  delete(pid){
    openModal(`<h3>Remove ${esc(pname(pid))}?</h3><p class="hint">Their coins go with them. Use this for duplicates or typos.</p>`,
      () => safe(() => store.write({[`players/${pid}`]: null}), 'Removed'), 'Remove');
  },
  undo(id){
    const e = S.log[id]; if (!e) return;
    const back = Object.fromEntries(Object.entries(e.deltas || {}).filter(([pid]) => S.players[pid]).map(([pid, d]) => [pid, -d]));
    confirmDeltas(`Undo: ${e.label}`, back, 0, () => safe(async () => {
      const upd = {[`log/${id}/undone`]: true};
      for (const [pid, d] of Object.entries(back)) upd[`players/${pid}/coins`] = inc(d);
      await store.write(upd);
    }, 'Undone'));
  },
  gedit(id){ gameEditor(id || null); },
  gmove(arg){
    const [id, dir] = arg.split('|');
    saveConfig(c => {
      const i = c.games.findIndex(g => g.id === id), j = i + +dir;
      if (i < 0 || j < 0 || j >= c.games.length) return;
      [c.games[i], c.games[j]] = [c.games[j], c.games[i]];
    });
  },
  gdel(id){
    const g = gameById(id);
    openModal(`<h3>Delete ${esc(g.name)}?</h3><p class="hint">Past results stay in the log and players keep their coins.</p>`,
      () => saveConfig(c => { c.games = c.games.filter(x => x.id !== id); }, 'Game deleted'), 'Delete');
  },
  endgame(){ openModal('<h3>End the game?</h3><p>All stations freeze and everyone sees the podium.</p>', () => safe(() => store.write({'settings/ended': true}), 'Winner revealed'), 'End game'); },
  reopen(){ safe(() => store.write({'settings/ended': false}), 'Game reopened'); },
  wipe(){
    openModal('<h3>Wipe players & history?</h3><p>Deletes all players and the log. Your games and settings stay. Type <b>RESET</b> to confirm.</p><input class="minput" id="m-reset">', async () => {
      if (document.getElementById('m-reset').value.trim() !== 'RESET'){ toast('Type RESET'); return true; }
      await safe(() => store.write({players: null, log: null, settings: null}), 'Wiped');
      ui.st = {}; saveDraft();
    }, 'Wipe');
  },
};

async function addPlayers(names){
  const existing = new Set(Object.values(S.players).map(p => String(p.name).toLowerCase()));
  const upd = {}, skipped = [], start = Number(cfg().startCoins) || 0;
  let added = 0;
  for (const raw of names){
    const n = raw.trim().slice(0, 39); if (!n) continue;
    if (existing.has(n.toLowerCase())){ skipped.push(n); continue; }
    existing.add(n.toLowerCase());
    upd[`players/${store.newId('players')}`] = {name: n, coins: start, created: Date.now()};
    added++;
  }
  if (added) await safe(() => store.write(upd));
  toast(`Added ${added}${skipped.length ? `. Already added: ${skipped.join(', ')}` : ''}`);
  schedule();
}

const SUBMIT = {
  async login(){
    const e = document.getElementById('lemail').value.trim(), p = document.getElementById('lpw').value;
    try{ ui.loginErr = ''; await store.signIn(e, p); }
    catch{ ui.loginErr = 'Login failed: wrong email or password'; render(); }
  },
  addone(){ const n = ui.newName; ui.newName = ''; addPlayers([n]); document.getElementById('newname')?.focus(); },
  eventform(){
    const e = ui.ev, start = parseInt(e.startCoins, 10);
    if (!e.title.trim()){ toast('Title can’t be empty'); return; }
    if (!(start >= 0)){ toast('Starting coins must be 0 or more'); return; }
    saveConfig(c => Object.assign(c, {title: e.title.trim().slice(0, 40), subtitle: e.subtitle.trim().slice(0, 40), startCoins: start, brokePolicy: e.brokePolicy}), 'Settings saved');
  },
};

document.addEventListener('click', e => {
  if (e.target === $modal){ closeModal(); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn){ e.preventDefault(); fn(el.dataset.arg, el); }
});
document.addEventListener('input', e => {
  const k = e.target.dataset?.bind; if (!k) return;
  setPath(ui, k, e.target.value);
  if (k.startsWith('st.')) saveDraft();
  if ('live' in e.target.dataset) render();
});
document.addEventListener('change', e => { if (e.target.id === 'm-kind') syncKind(); });
document.addEventListener('submit', e => { e.preventDefault(); SUBMIT[e.target.id]?.(); });
window.addEventListener('hashchange', render);

// ===== start =====
render();
(async () => {
  try{ store = FIREBASE_CONFIG ? await firebaseStore(FIREBASE_CONFIG) : localStore(); }
  catch(err){ $app.innerHTML = `<div class="warn">Couldn’t connect to Firebase: ${esc(err.message)}</div>`; return; }
  store.onAuth(u => { user = u; schedule(); });
  store.onData(s => { S = s; loaded = true; schedule(); });
})();
