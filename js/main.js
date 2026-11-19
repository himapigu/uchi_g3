// 画面と進行。ホストは H.st（正本）を持ち、変更のたびに全員へ配る。
// 参加者は操作をホストに送るだけで、状態は受け取ったものを描画する。
import { HostNet, GuestNet, normalizeCode } from './net.js';
import { fileToDataURL, textCard, buildCollage, downloadCanvas, requestText, slotLabel } from './media.js';
import { parseAppraisal, sampleAppraisal } from './appraisal.js';
import { createBattle, resolveTurn, resolveForced, canSwitchTo } from './battle.js';
import {
  TYPES, TYPE_COLORS, EFFECT_LABEL, LIMITS, STRUGGLE, typeMatch, weaknessesOf, irritationMult, irritationStart, IRRITATION,
} from './rules.js';
import { play, unlock, isMuted, setMuted } from './sfx.js';

const MAX_PLAYERS = 2;
const TEAM_SIZES = [1, 2, 3];
const DEFAULT_TEAM_SIZE = 2;
const TEXT_MAX = 400;
const JUDGE_LINE = '……それ、強いの？';

const $app = document.getElementById('app');

// 表示側の状態（全員共通）
const S = {
  role: null,        // 'host' | 'guest'
  myId: null,
  net: null,
  state: null,       // 最後に描画した状態
  sprites: [],       // sprites[side][k] = 画像 dataURL
  mounted: null,     // 今マウントしている画面
  animating: false,
  pending: null,     // アニメ中に届いた状態
  view: null,        // バトル画面に表示中の値
  name: '',
  code: '',
};

// ホストだけが持つ情報
const H = {
  st: null,
  subs: {},          // サイド番号 → [{ kind, image, text }, ...]
  actions: [null, null],
  parsed: null,
  assets: null,
};

// ---------- 小物 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function storage(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k) || '';
    localStorage.setItem(k, v);
  } catch { /* プライベートモード等 */ }
  return '';
}

async function copyText(text, label = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    window.prompt('コピーしてください', text);
  }
}

function inviteUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

const isHost = () => S.role === 'host';
const myIndex = () => (S.state ? S.state.players.findIndex((p) => p.id === S.myId) : -1);
const mySide = () => Math.max(0, myIndex());
const sprite = (side, k) => S.sprites[side]?.[k] || '';

function act(msg) {
  if (isHost()) hostHandle('host', msg);
  else S.net.send(msg);
}

function typeBadge(t) {
  return t ? `<span class="type" style="--tc:${TYPE_COLORS[t] || '#999'}">${esc(t)}</span>` : '';
}

async function loadInstructions() {
  const res = await fetch('prompt/appraisal-instructions.md');
  if (!res.ok) throw new Error();
  return res.text();
}

// ---------- 効果音 ----------
document.addEventListener('pointerdown', unlock, true);
document.addEventListener('keydown', unlock, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled && b.id !== 'muteBtn') play('select');
}, true);
function renderMute() {
  const b = $('#muteBtn');
  b.textContent = isMuted() ? '音：OFF' : '音：ON';
  b.setAttribute('aria-pressed', String(!isMuted()));
}
$('#muteBtn').addEventListener('click', () => {
  unlock();
  setMuted(!isMuted());
  renderMute();
  if (!isMuted()) play('ok');
});
renderMute();

// 前回描画時との差分で鳴らす音（入室・提出）
const prevCounts = { players: 0, submitted: 0 };

// ---------- タイトル ----------
function mountTitle(errorMsg) {
  S.mounted = 'title';
  const room = normalizeCode(new URLSearchParams(location.search).get('room'));
  const name = storage('uchinoko-name');
  $app.innerHTML = `
    <section class="hero">
      <div class="judge-face small"><div class="eye"></div><div class="eye"></div></div>
      <h1>うちの子が<br>いちばん強い</h1>
      <p class="judge-line">${JUDGE_LINE}</p>
    </section>
    <section class="panel">
      ${errorMsg ? `<p class="error">${esc(errorMsg)}</p>` : ''}
      <label class="field">あなたの名前
        <input id="nameIn" maxlength="12" placeholder="例：たろう" value="${esc(name)}">
      </label>
      ${room ? `
        <p>部屋 <b class="code">${esc(room)}</b> に招待されています。</p>
        <button id="joinBtn" class="primary">入室する</button>
        <p class="hint"><a href="${esc(location.pathname)}">自分で部屋を作る場合はこちら</a></p>
      ` : `
        <button id="createBtn" class="primary">部屋を作る（ホスト）</button>
        <div class="or">または</div>
        <div class="row">
          <input id="codeIn" maxlength="8" placeholder="ルームID" autocapitalize="characters">
          <button id="joinBtn">参加する</button>
        </div>
      `}
    </section>
    <section class="panel how">
      <h3>あそびかた</h3>
      <ol>
        <li>ホストが部屋を作り、URLかルームIDで1人を招待。1人あたりの「うちの子」の数（1〜3体）を決める</li>
        <li>それぞれ「うちの子」を画像か文章で提出</li>
        <li>ホストがチャットAI（Claude、ChatGPT など）で鑑定し、結果を貼り付け</li>
        <li>先発を選んで、交代ありのチームバトル！ 相手を全員倒したら勝ち</li>
      </ol>
    </section>`;

  const getName = () => {
    const n = $('#nameIn').value.trim();
    if (!n) { toast('名前を入れてください'); $('#nameIn').focus(); return null; }
    storage('uchinoko-name', n);
    return n;
  };
  $('#createBtn')?.addEventListener('click', () => { const n = getName(); if (n) createRoom(n); });
  $('#joinBtn').addEventListener('click', () => {
    const n = getName();
    if (!n) return;
    const code = room || normalizeCode($('#codeIn').value);
    if (!code) { toast('ルームIDを入れてください'); return; }
    joinRoom(code, n);
  });
}

function mountConnecting(text) {
  S.mounted = 'connecting';
  $app.innerHTML = `<section class="panel center"><div class="spinner"></div><p>${esc(text)}</p></section>`;
}

// ---------- 接続 ----------
async function createRoom(name) {
  mountConnecting('部屋を作っています…');
  S.role = 'host';
  S.myId = 'host';
  S.name = name;
  S.net = new HostNet({ onMessage: hostHandle, onLeave: hostLeave, onError: (m) => toast(m, 5000) });
  try {
    S.code = await S.net.open();
  } catch (e) {
    S.role = null;
    mountTitle(e.message);
    return;
  }
  H.st = {
    v: 0,
    code: S.code,
    phase: 'lobby',
    teamSize: DEFAULT_TEAM_SIZE,
    players: [{ id: 'host', name, connected: true, submitted: false, kinds: [] }],
    spectators: [],
    teams: null,
    leads: [0, 0],
    battle: null,
    opening: '',
  };
  history.replaceState(null, '', inviteUrl(S.code));
  window.addEventListener('beforeunload', (e) => {
    if (H.st.phase !== 'lobby' || H.st.players.length > 1) { e.preventDefault(); e.returnValue = ''; }
  });
  push();
}

async function joinRoom(code, name) {
  mountConnecting('入室しています…');
  S.role = 'guest';
  S.name = name;
  S.code = code;
  S.net = new GuestNet({
    onMessage: guestHandle,
    onClose: mountDisconnected,
    onError: (m) => toast(m, 5000),
  });
  try {
    S.myId = await S.net.join(code);
  } catch (e) {
    S.role = null;
    mountTitle(e.message);
    return;
  }
  S.net.send({ type: 'join', name });
}

function mountDisconnected() {
  S.mounted = 'disconnected';
  S.animating = false;
  $app.innerHTML = `
    <section class="panel center">
      <h2>ホストとの接続が切れました</h2>
      <p>ホストの画面が開いたままなら、同じ名前で入り直せます。</p>
      <button id="rejoinBtn" class="primary">入り直す</button>
    </section>`;
  $('#rejoinBtn').addEventListener('click', () => joinRoom(S.code, S.name));
}

function guestHandle(msg) {
  switch (msg?.type) {
    case 'welcome': S.myId = msg.id; break;
    case 'reject': mountTitle(msg.reason); break;
    case 'assets': setAssets(msg.assets); break;
    case 'state': onState(msg.state); break;
    case 'turn': onTurn(msg); break;
    case 'notice': toast(msg.text); break;
  }
}

// ---------- ホスト側の進行 ----------
// 相手の鑑定結果は決着まで秘密。プレイヤーごとに、相手チームの分を削って送る。
//   結果発表まで：名前も属性も「？？？」
//   バトル中　　：場に出た子だけ名前と属性が分かる（能力値や技は送らない）
// 観戦者には全部見せる。
function viewFor(id) {
  const st = H.st;
  const idx = st.players.findIndex((p) => p.id === id);
  const v = clone(st);
  if (idx < 0) return v;
  v.leads = v.leads.map((l, i) => (i === idx ? l : null));
  if (!st.teams || st.phase === 'result') return v;
  const opp = 1 - idx;
  v.teams[opp] = st.teams[opp].map((f, k) => (
    st.phase === 'battle' && st.battle?.revealed[opp][k]
      ? { player: f.player, no: f.no, name: f.name, type: f.type, hidden: true }
      : { player: f.player, no: f.no, name: '？？？', type: null, hidden: true, unknown: true }
  ));
  // 残り回数から技の威力が推測できてしまうので、相手の分は送らない
  if (v.battle) v.battle.teams[opp].forEach((m) => { m.pp = null; });
  return v;
}

function push() {
  H.st.v++;
  S.net.sendEach((id) => ({ type: 'state', state: viewFor(id) }));
  onState(viewFor('host'));
}

function hostLeave(id) {
  const st = H.st;
  const i = st.players.findIndex((p) => p.id === id);
  if (i >= 0) {
    toast(`${st.players[i].name} の接続が切れました`);
    if (st.phase === 'lobby') st.players.splice(i, 1);
    else st.players[i].connected = false;
  }
  st.spectators = st.spectators.filter((s) => s.id !== id);
  push();
}

function hostJoin(from, rawName) {
  const st = H.st;
  const name = String(rawName || '').trim().slice(0, 12) || 'ななし';
  const back = st.players.find((p) => !p.connected && p.name === name && p.id !== 'host');
  if (back) {
    back.id = from;
    back.connected = true;
    S.net.send(from, { type: 'welcome', id: from, role: 'player' });
    if (H.assets) S.net.send(from, { type: 'assets', assets: H.assets });
    push();
    return;
  }
  if (st.phase === 'lobby' && st.players.length < MAX_PLAYERS) {
    let n = name;
    while (st.players.some((p) => p.name === n)) n += '＋';
    st.players.push({ id: from, name: n, connected: true, submitted: false, kinds: [] });
    S.net.send(from, { type: 'welcome', id: from, role: 'player' });
  } else {
    st.spectators.push({ id: from, name });
    S.net.send(from, { type: 'welcome', id: from, role: 'spectator' });
    S.net.send(from, { type: 'notice', text: '対戦枠が埋まっているので観戦で入りました' });
    if (H.assets) S.net.send(from, { type: 'assets', assets: H.assets });
  }
  push();
}

function normEntry(e) {
  if (e?.kind === 'image') {
    if (typeof e.image !== 'string' || !e.image.startsWith('data:image/') || e.image.length > 4_000_000) return null;
    return { kind: 'image', image: e.image, text: '' };
  }
  const text = String(e?.text || '').trim().slice(0, TEXT_MAX);
  return text ? { kind: 'text', image: null, text } : null;
}

function hostHandle(from, msg) {
  const st = H.st;
  const pi = st.players.findIndex((p) => p.id === from);
  switch (msg?.type) {
    case 'join':
      if (from !== 'host') hostJoin(from, msg.name);
      break;
    case 'submit': {
      if (st.phase !== 'submit' || pi < 0) return;
      const list = Array.isArray(msg.entries) ? msg.entries.map(normEntry) : [];
      if (list.length !== st.teamSize || list.some((e) => !e)) return;
      H.subs[pi] = list;
      st.players[pi].submitted = true;
      st.players[pi].kinds = list.map((e) => e.kind);
      push();
      break;
    }
    case 'lead': {
      const k = Number(msg.index);
      if (st.phase !== 'reveal' || pi < 0 || !Number.isInteger(k) || k < 0 || k >= st.teamSize) return;
      st.leads[pi] = k;
      push();
      break;
    }
    case 'act': {
      if (st.phase !== 'battle' || pi < 0) return;
      const b = st.battle;
      if (b.over || b.ready[pi]) return;
      const forced = b.need.some(Boolean);
      const a = msg.action || {};
      let action = null;
      if (a.kind === 'switch' && canSwitchTo(b, pi, Number(a.to))) action = { kind: 'switch', to: Number(a.to) };
      else if (!forced) {
        const pp = b.teams[pi][b.active[pi]].pp;
        if (a.kind === 'skill' && Number.isInteger(a.index) && pp[a.index] > 0) action = { kind: 'skill', index: a.index };
        else if (a.kind === 'struggle' && pp.every((p) => p <= 0)) action = { kind: 'struggle' };
      }
      if (!action) return;
      H.actions[pi] = action;
      b.ready[pi] = true;
      if (b.ready.every(Boolean)) hostResolve(forced);
      else push();
      break;
    }
  }
}

const hostAction = {
  setTeamSize(n) {
    if (H.st.phase !== 'lobby' || !TEAM_SIZES.includes(n)) return;
    H.st.teamSize = n;
    push();
  },
  startSubmit() {
    const st = H.st;
    if (st.players.length < MAX_PLAYERS) return;
    st.phase = 'submit';
    st.players.forEach((p) => { p.submitted = false; p.kinds = []; });
    st.teams = null;
    st.battle = null;
    st.leads = [0, 0];
    H.subs = {};
    H.parsed = null;
    H.assets = null;
    push();
  },
  toLobby() {
    H.st.phase = 'lobby';
    push();
  },
  toAppraise() {
    if (!H.st.players.every((p) => p.submitted)) return;
    H.st.phase = 'appraise';
    H.parsed = null;
    push();
  },
  backToSubmit() {
    H.st.phase = 'submit';
    push();
  },
  groups() {
    return H.st.players.map((p, i) => ({ name: p.name, entries: H.subs[i] || [] }));
  },
  reveal() {
    const st = H.st;
    if (!H.parsed) return;
    st.teams = H.parsed.teams;
    st.opening = H.parsed.opening;
    st.leads = [0, 0];
    H.assets = st.players.map((_, i) => H.subs[i]);
    S.net.broadcast({ type: 'assets', assets: H.assets });
    setAssets(H.assets);
    st.phase = 'reveal';
    push();
  },
  startBattle() {
    const st = H.st;
    st.battle = { ...createBattle(st.teams, st.leads), ready: [false, false] };
    H.actions = [null, null];
    st.phase = 'battle';
    push();
  },
};

function hostResolve(forced) {
  const st = H.st;
  const names = st.players.map((p) => p.name);
  const { battle, events } = (forced ? resolveForced : resolveTurn)(st.battle, st.teams, H.actions, names);
  H.actions = [null, null];
  // 強制交代待ちのときは、交代しなくてよい側を「選択済み」にしておく
  battle.ready = battle.need.some(Boolean) ? battle.need.map((n) => !n) : [false, false];
  st.battle = battle;
  if (battle.over) st.phase = 'result';
  st.v++;
  S.net.sendEach((id) => ({ type: 'turn', events, state: viewFor(id) }));
  onTurn({ events, state: viewFor('host') });
}

// ---------- 描画 ----------
function setAssets(assets) {
  S.sprites = (assets || []).map((team) => (team || []).map((a) => (
    !a ? '' : a.kind === 'image' ? a.image : textCard(a.text)
  )));
}

function onState(state) {
  if (S.animating) { S.pending = state; return; }
  render(state);
}

function render(state) {
  S.state = state;
  renderBadge();
  if (S.mounted !== state.phase) {
    S.mounted = state.phase;
    MOUNT[state.phase]();
  }
  UPDATE[state.phase]?.();
}

function renderBadge() {
  const b = $('#roomBadge');
  const st = S.state;
  const me = st.players.find((p) => p.id === S.myId);
  const role = isHost() ? 'ホスト' : me ? '' : '観戦';
  b.hidden = false;
  b.textContent = `ROOM ${st.code}・${me?.name ?? S.name}${role ? `（${role}）` : ''}`;
}

function playersList() {
  const st = S.state;
  return st.players.map((p, i) => {
    const tags = [];
    if (p.id === 'host') tags.push('ホスト');
    if (p.id === S.myId) tags.push('あなた');
    if (!p.connected) tags.push('切断中');
    return `<li class="${p.connected ? '' : 'off'}"><span class="num">${i + 1}</span>${esc(p.name)}
      ${tags.map((t) => `<em>${t}</em>`).join('')}</li>`;
  }).join('');
}

const MOUNT = {};
const UPDATE = {};

// ----- ロビー -----
MOUNT.lobby = () => {
  const st = S.state;
  const url = inviteUrl(st.code);
  $app.innerHTML = `
    <section class="panel">
      <h2>ロビー</h2>
      <div class="invite">
        <div>ルームID <b class="code big">${esc(st.code)}</b></div>
        ${isHost() ? `
          <div class="url">${esc(url)}</div>
          <div class="row">
            <button id="copyUrl">招待URLをコピー</button>
            <button id="copyCode" class="ghost">IDだけコピー</button>
          </div>` : ''}
      </div>
      <h3>対戦者（${MAX_PLAYERS}人）</h3>
      <ul id="players" class="slots"></ul>
      <p id="specs" class="hint"></p>
      <h3>ルール</h3>
      <div id="rule"></div>
      <div id="lobbyAction"></div>
    </section>`;
  $('#copyUrl')?.addEventListener('click', () => copyText(url, '招待URLをコピーしました'));
  $('#copyCode')?.addEventListener('click', () => copyText(st.code));
};
UPDATE.lobby = () => {
  const st = S.state;
  if (st.players.length > prevCounts.players && prevCounts.players > 0) play('join');
  prevCounts.players = st.players.length;
  let html = playersList();
  for (let i = st.players.length; i < MAX_PLAYERS; i++) html += `<li class="empty"><span class="num">${i + 1}</span>募集中…</li>`;
  $('#players').innerHTML = html;
  $('#specs').textContent = st.spectators.length ? `観戦：${st.spectators.map((s) => s.name).join('、')}` : '';
  $('#rule').innerHTML = `
    <p>1人あたり <b class="big-num">${st.teamSize}</b> 体の「うちの子」で勝負${st.teamSize > 1 ? '（交代あり）' : ''}</p>
    ${isHost() ? `<div class="seg">${TEAM_SIZES.map((n) => `
      <button data-size="${n}" class="${n === st.teamSize ? 'active' : ''}">${n}体</button>`).join('')}</div>` : ''}`;
  $$('[data-size]').forEach((b) => b.addEventListener('click', () => hostAction.setTeamSize(Number(b.dataset.size))));
  const full = st.players.length >= MAX_PLAYERS;
  $('#lobbyAction').innerHTML = isHost()
    ? `<button id="startBtn" class="primary" ${full ? '' : 'disabled'}>${full ? 'うちの子の提出をはじめる' : '対戦相手を待っています…'}</button>`
    : `<p class="wait">ホストの開始を待っています<span class="dots"></span></p>`;
  $('#startBtn')?.addEventListener('click', hostAction.startSubmit);
};

// ----- 提出 -----
function slotHtml(k, n) {
  return `
    <div class="slot" data-k="${k}">
      ${n > 1 ? `<h3>${k + 1}体目</h3>` : ''}
      <div class="tabs">
        <button data-tab="image" class="tab active">画像</button>
        <button data-tab="text" class="tab">文章</button>
      </div>
      <div class="tab-image">
        <label class="drop">
          <input type="file" accept="image/*" hidden>
          <img class="preview" alt="" hidden>
          <span class="drop-hint">タップして画像を選ぶ</span>
        </label>
      </div>
      <div class="tab-text" hidden>
        <textarea maxlength="${TEXT_MAX}" rows="5" placeholder="例：うちの猫のもち。こたつから一歩も出ないが、ごはんの音には0.1秒で反応する。"></textarea>
        <div class="count"><span>0</span>/${TEXT_MAX}</div>
      </div>
    </div>`;
}

MOUNT.submit = () => {
  const st = S.state;
  prevCounts.submitted = 0;
  const n = st.teamSize;
  const playing = myIndex() >= 0;
  $app.innerHTML = `
    ${playing ? `
    <section class="panel">
      <h2>うちの子を提出（${n}体）</h2>
      <p class="hint">1体ごとに画像か文章のどちらか1つ。審判AIが同じ基準で鑑定します。${n > 1 ? '先発はあとで選べます。' : ''}</p>
      <div class="slot-grid">${Array.from({ length: n }, (_, k) => slotHtml(k, n)).join('')}</div>
      <button id="submitBtn" class="primary">このチームで勝負！</button>
      <p id="mySubmit" class="hint"></p>
    </section>` : '<section class="panel center"><p>対戦者が「うちの子」を提出しています…</p></section>'}
    <section class="panel">
      <h3>提出状況</h3>
      <ul id="subList" class="slots"></ul>
      <div id="subAction"></div>
    </section>`;
  if (!playing) return;

  const slots = Array.from({ length: n }, () => ({ tab: 'image', image: null }));
  $$('.slot').forEach((el) => {
    const s = slots[Number(el.dataset.k)];
    $$('.tab', el).forEach((b) => b.addEventListener('click', () => {
      s.tab = b.dataset.tab;
      $$('.tab', el).forEach((x) => x.classList.toggle('active', x === b));
      $('.tab-image', el).hidden = s.tab !== 'image';
      $('.tab-text', el).hidden = s.tab !== 'text';
    }));
    $('input[type=file]', el).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        s.image = await fileToDataURL(f);
        $('.preview', el).src = s.image;
        $('.preview', el).hidden = false;
        $('.drop-hint', el).textContent = 'タップして変更';
      } catch (err) { toast(err.message, 5000); }
    });
    $('textarea', el).addEventListener('input', (e) => { $('.count span', el).textContent = e.target.value.length; });
  });
  $('#submitBtn').addEventListener('click', () => {
    const entries = [];
    for (const el of $$('.slot')) {
      const k = Number(el.dataset.k);
      const s = slots[k];
      const label = n > 1 ? `${k + 1}体目` : '';
      if (s.tab === 'image') {
        if (!s.image) { toast(`${label}の画像を選んでください`); return; }
        entries.push({ kind: 'image', image: s.image });
      } else {
        const text = $('textarea', el).value.trim();
        if (!text) { toast(`${label}の文章を入れてください`); return; }
        entries.push({ kind: 'text', text });
      }
    }
    act({ type: 'submit', entries });
    toast('送信しました');
  });
};
UPDATE.submit = () => {
  const st = S.state;
  const nSub = st.players.filter((p) => p.submitted).length;
  if (nSub > prevCounts.submitted) play('ok');
  prevCounts.submitted = nSub;
  const summary = (kinds) => {
    const img = kinds.filter((k) => k === 'image').length;
    return [img && `画像${img}`, kinds.length - img && `文章${kinds.length - img}`].filter(Boolean).join('・');
  };
  $('#subList').innerHTML = st.players.map((p) => `
    <li class="${p.connected ? '' : 'off'}">${esc(p.name)}${p.id === S.myId ? '<em>あなた</em>' : ''}${p.connected ? '' : '<em>切断中</em>'}
      <span class="status ${p.submitted ? 'ok' : ''}">${p.submitted ? `提出済み（${summary(p.kinds)}）` : '準備中…'}</span></li>`).join('');
  const me = st.players[myIndex()];
  if (me && $('#mySubmit')) {
    $('#mySubmit').textContent = me.submitted ? '提出済み。鑑定が始まるまでは送り直して変更できます。' : '';
  }
  const all = st.players.every((p) => p.submitted);
  $('#subAction').innerHTML = isHost()
    ? `<button id="toAppraise" class="primary" ${all ? '' : 'disabled'}>${all ? '鑑定へ進む' : '全員の提出を待っています…'}</button>
       <button id="toLobby" class="ghost">ロビーに戻る（体数を変える）</button>`
    : '';
  $('#toAppraise')?.addEventListener('click', hostAction.toAppraise);
  $('#toLobby')?.addEventListener('click', hostAction.toLobby);
};

// ----- 鑑定待ち -----
MOUNT.appraise = () => {
  $app.innerHTML = `
    <section class="judge-stage">
      <div class="judge-face"><div class="eye"></div><div class="eye"></div><div class="scan"></div></div>
      <p class="judge-line big" id="judgeLine"></p>
      <p class="hint">審判AIが鑑定しています<span class="dots"></span></p>
    </section>
    ${isHost() ? `
    <section class="panel host-panel">
      <h3>ホスト作業：鑑定</h3>
      <p class="hint">画像を読めるチャットAIなら、どれでも使えます（Claude、ChatGPT、Gemini など）。</p>
      <div class="row">
        <button id="copyPack" class="primary">鑑定室用にまとめてコピー</button>
      </div>
      <div class="hint">「うちの子 鑑定室」を使うときはこちら。画像と依頼文を読めない文字列にしてコピーするので、コピー時のプレビューにも中身が出ません。鑑定室で1回貼るだけで済みます。</div>
      <p class="hint">チャットAIに直接貼るときは、下の手順でどうぞ（画像のコピーでは、端末によってプレビューが出ます）。</p>
      <ol class="steps">
        <li>
          <button id="copyImg" class="primary">画像をコピー</button>
          → チャットAIの入力欄で <b>Ctrl+V</b>（スマホは長押しで貼り付け）
          <div class="hint">うまく貼れないときは <button id="saveImg" class="link">画像を保存</button> して添付してください。</div>
        </li>
        <li>
          <button id="copyReq" class="primary">依頼文をコピー</button>
          → 同じ入力欄に貼って送信
          <label class="check"><input type="checkbox" id="withInst"> 指示文も含める（AIのプロジェクト／カスタム指示に指示文を入れていない場合）</label>
          <div class="hint">指示文だけ欲しいときは <button id="copyPrompt" class="link">鑑定用の指示文をコピー</button></div>
        </li>
        <li>返ってきた <code>UCHINOKO2:…</code> の文字列をコピーして
          <div class="row">
            <button id="readClip" class="primary">クリップボードから読み込む</button>
          </div>
          <div class="hint">または下の欄に貼り付け（貼った時点で自動で読み込みます）</div>
          <textarea id="jsonIn" rows="3" spellcheck="false" placeholder="UCHINOKO2:..."></textarea>
          <div class="row">
            <button id="parseBtn">読み込む</button>
            <button id="sampleBtn" class="link">（テスト用）サンプルを入れる</button>
          </div>
        </li>
      </ol>
      <div id="parseResult"></div>
      <div class="row">
        <button id="revealBtn" class="primary big" disabled>結果発表へ</button>
        <button id="backSubmit" class="ghost">提出からやり直す</button>
      </div>
    </section>` : ''}`;

  typeInto($('#judgeLine'), JUDGE_LINE, 140, 'judge');
  if (!isHost()) return;

  const names = () => H.st.players.map((p) => p.name);
  let collage = null;
  const getCollage = async () => {
    if (!collage) {
      collage = await buildCollage(hostAction.groups());
    }
    return collage;
  };
  $('#copyImg').addEventListener('click', async () => {
    try {
      // ClipboardItem に Promise を渡すと、クリック直後の扱いのまま非同期で画像を作れる（Safari 対策）
      const blob = getCollage().then((c) => new Promise((r) => c.toBlob(r, 'image/png')));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('画像をコピーしました。チャットAIの入力欄に貼り付けてください');
    } catch {
      toast('このブラウザでは画像をコピーできませんでした。保存して添付してください', 5000);
      await downloadCanvas(await getCollage(), `uchinoko_${H.st.code}.png`);
    }
  });
  // 画像＋依頼文を base64 の文字列1本にまとめる（OS のクリップボードプレビューで中身が見えないように）
  const buildPack = async () => {
    const c = await getCollage();
    const dataUrl = c.toDataURL('image/png');
    const json = JSON.stringify({ v: 1, r: requestText(hostAction.groups()), i: dataUrl });
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return 'UCHINOKO-PACK1:' + btoa(bin);
  };
  $('#copyPack').addEventListener('click', async () => {
    const done = () => toast('コピーしました。鑑定室の枠に貼り付けてください');
    try {
      // Promise を渡すと、クリック直後の扱いのまま非同期で作れる（Safari 対策）
      const blob = buildPack().then((t) => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      done();
    } catch {
      try { await navigator.clipboard.writeText(await buildPack()); done(); }
      catch { toast('コピーできませんでした。画像を保存して鑑定室で選んでください', 5000); }
    }
  });
  $('#saveImg').addEventListener('click', async () => {
    await downloadCanvas(await getCollage(), `uchinoko_${H.st.code}.png`);
  });
  $('#copyReq').addEventListener('click', async () => {
    let inst = '';
    if ($('#withInst').checked) {
      try { inst = await loadInstructions(); } catch { toast('指示文を読み込めませんでした'); return; }
    }
    copyText(requestText(hostAction.groups(), inst), '依頼文をコピーしました');
  });
  $('#copyPrompt').addEventListener('click', async () => {
    try { copyText(await loadInstructions(), '指示文をコピーしました'); } catch { toast('指示文を読み込めませんでした（prompt/appraisal-instructions.md）'); }
  });

  const load = async (text) => {
    const out = $('#parseResult');
    try {
      H.parsed = await parseAppraisal(text, names(), H.st.teamSize);
      // ホストもプレイヤーなので、ここでは中身を見せない
      const w = H.parsed.warnings;
      out.innerHTML = `
        <p class="ok">${names().map(esc).join('・')} の ${H.parsed.teams.flat().length}体分の鑑定結果を読み込みました。</p>
        ${w.length ? `<details class="warn"><summary>補正・注意が ${w.length} 件あります（ネタバレ注意）</summary>
          <ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}`;
      $('#revealBtn').disabled = false;
      play('ok');
    } catch (e) {
      H.parsed = null;
      out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      $('#revealBtn').disabled = true;
    }
  };
  $('#readClip').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('#jsonIn').value = text;
      load(text);
    } catch {
      toast('クリップボードを読めませんでした。下の欄に貼り付けてください', 5000);
      $('#jsonIn').focus();
    }
  });
  $('#jsonIn').addEventListener('paste', () => setTimeout(() => load($('#jsonIn').value), 0));
  $('#parseBtn').addEventListener('click', () => load($('#jsonIn').value));
  $('#sampleBtn').addEventListener('click', async () => {
    $('#jsonIn').value = await sampleAppraisal(names(), H.st.teamSize);
    load($('#jsonIn').value);
  });
  $('#revealBtn').addEventListener('click', hostAction.reveal);
  $('#backSubmit').addEventListener('click', hostAction.backToSubmit);
};

async function typeInto(el, text, ms = 40, sound = null) {
  el.textContent = '';
  for (const ch of text) {
    if (!el.isConnected) return;
    el.textContent += ch;
    if (sound && ch !== '…') play(sound);
    await sleep(ms);
  }
}

// ----- 鑑定カード -----
function statBar(label, v, max) {
  return `<div class="stat"><span>${label}</span><div class="bar"><i style="--w:${Math.round((v / max) * 100)}%"></i></div><b>${v}</b></div>`;
}

function cardLabel(side, k) {
  const p = S.state.players[side];
  return esc(slotLabel(p?.name ?? '', k, S.state.teamSize));
}

function mysteryCard(side, k, delay) {
  return `
    <article class="card mystery" style="--delay:${delay}s" data-side="${side}" data-k="${k}">
      <div class="card-head"><span class="owner">${cardLabel(side, k)}</span></div>
      <img class="sprite-img silhouette" src="${sprite(side, k)}" alt="">
      <h3 class="fname">？？？</h3>
      <p class="hint center">鑑定結果はバトルで明らかに……</p>
    </article>`;
}

function fighterCard(f, side, k, delay = 0, { leadPick = false } = {}) {
  if (f.hidden) return mysteryCard(side, k, delay);
  return `
    <article class="card" style="--delay:${delay}s" data-side="${side}" data-k="${k}">
      <div class="card-head">
        <span class="owner">${cardLabel(side, k)}</span>
        <span class="lead-badge">先発</span>
        ${typeBadge(f.type)}
      </div>
      <img class="sprite-img" src="${sprite(side, k)}" alt="">
      <h3 class="fname">${esc(f.name)}</h3>
      <div class="stats">
        ${statBar('HP', f.stats.hp, LIMITS.hp[1])}
        ${statBar('こうげき', f.stats.atk, LIMITS.stat[1])}
        ${statBar('ぼうぎょ', f.stats.def, LIMITS.stat[1])}
        ${statBar('すばやさ', f.stats.spd, LIMITS.stat[1])}
      </div>
      <ul class="skills">
        ${f.skills.map((s) => `
          <li>${typeBadge(s.type)}<b>${esc(s.name)}</b>
            <small>威力${s.power || '—'} 命中${s.accuracy} 回数${s.pp}${EFFECT_LABEL[s.effect] ? `・${EFFECT_LABEL[s.effect]}` : ''}</small>
            ${s.desc ? `<div class="desc">${esc(s.desc)}</div>` : ''}</li>`).join('')}
      </ul>
      <p class="weak">じゃくてん：${weaknessesOf(f.type).map(typeBadge).join('') || 'なし'}</p>
      <p class="appraisal"><span>審判</span>「${esc(f.appraisal)}」</p>
      ${leadPick ? `<button class="lead-btn" data-lead="${k}">この子を先発にする</button>` : ''}
    </article>`;
}

function teamSection(side, { delayBase = 0, leadPick = false } = {}) {
  const st = S.state;
  const p = st.players[side];
  return `
    <div class="team" data-team="${side}">
      <h3 class="team-title">${esc(p?.name)} のチーム${side === myIndex() ? '（あなた）' : ''}</h3>
      <div class="cards">${st.teams[side].map((f, k) => fighterCard(f, side, k, delayBase + k * 0.5, { leadPick })).join('')}</div>
    </div>`;
}

// ----- 結果発表 -----
MOUNT.reveal = () => {
  const st = S.state;
  const mi = myIndex();
  const order = mi >= 0 ? [mi, 1 - mi] : [0, 1];
  $app.innerHTML = `
    <section class="reveal">
      <h2 class="reveal-title">鑑定結果 発表！</h2>
      ${st.opening ? `<p class="opening">実況「${esc(st.opening)}」</p>` : ''}
      ${mi >= 0 ? `<p class="hint center">見られるのは自分のうちの子だけ。相手の手の内は、決着のあとで公開されます。${st.teamSize > 1 ? '<br>先発を選んでください。' : ''}</p>` : ''}
      ${order.map((side, n) => teamSection(side, { delayBase: n * 1.2, leadPick: side === mi && st.teamSize > 1 })).join('')}
      <div id="revealAction" class="center"></div>
    </section>`;
  $$('[data-lead]').forEach((b) => b.addEventListener('click', () => act({ type: 'lead', index: Number(b.dataset.lead) })));
  play('fanfare');
  scheduleCardSounds();
};

// カードの登場アニメ（--delay）に合わせて音を鳴らす
function scheduleCardSounds() {
  const phase = S.state.phase;
  $$('.card').forEach((c) => {
    const d = parseFloat(c.style.getPropertyValue('--delay')) || 0;
    setTimeout(() => { if (S.state.phase === phase) play('reveal'); }, d * 1000 + 150);
  });
}
UPDATE.reveal = () => {
  const st = S.state;
  $$('.card').forEach((c) => {
    const side = Number(c.dataset.side);
    c.classList.toggle('is-lead', st.teamSize > 1 && st.leads[side] === Number(c.dataset.k));
  });
  $('#revealAction').innerHTML = isHost()
    ? '<button id="battleBtn" class="primary big">バトル開始！</button>'
    : '<p class="wait">ホストがバトルを開始するのを待っています<span class="dots"></span></p>';
  $('#battleBtn')?.addEventListener('click', hostAction.startBattle);
};

// ----- バトル -----
function infoBox(side, isMe) {
  return `
    <div class="info ${isMe ? 'me' : 'foe'}" data-side="${side}">
      <div class="info-top"><b class="iname"></b><span class="itype"></span></div>
      <div class="hp-row"><span class="hp-label">HP</span><div class="hpbar"><i></i></div></div>
      ${isMe ? '<div class="hpnum"></div>' : ''}
      <div class="status-row"></div>
      <div class="party"></div>
    </div>`;
}

const activeData = (side) => S.state.teams[side][S.view.active[side]];

/** 属性相性表（行：攻撃する技の属性、列：受ける側の属性） */
function typeChartHtml() {
  const cell = (a, d) => {
    const m = typeMatch(a, d);
    return m === 'super' ? '<td class="c-super">◎</td>' : m === 'weak' ? '<td class="c-weak">△</td>' : '<td></td>';
  };
  return `
    <div class="chart-box">
      <div class="chart-head"><b>属性相性表</b><span>タップで閉じる</span></div>
      <table class="type-chart">
        <tr><th class="corner">技＼受け</th>${TYPES.map((t) => `<th>${typeBadge(t)}</th>`).join('')}</tr>
        ${TYPES.map((a) => `<tr><th>${typeBadge(a)}</th>${TYPES.map((d) => cell(a, d)).join('')}</tr>`).join('')}
      </table>
      <p class="chart-note">◎ じゃくてん：ダメージ2倍、しかも相手の防御を3/4として計算<br>
        △ いまひとつ：ダメージ半分<br>
        技の属性と自分の属性が同じなら さらに1.2倍<br>
        ${irritationStart(S.state.teamSize)}ターン目から「審判のいらだち」で、毎ターン与ダメージが +${Math.round(IRRITATION.step * 100)}%</p>
    </div>`;
}

function renderIrritation(turn) {
  const el = $('#irritation');
  if (!el) return;
  // battle.turn は「次のターン」の番号。いらだちは次のターンの最初に告げるので、表示は直前のターンの倍率
  const m = irritationMult(turn - 1, S.state.teamSize);
  el.hidden = m <= 1;
  el.textContent = `審判のいらだち ダメージ×${m.toFixed(2).replace(/0$/, '')}`;
}

MOUNT.battle = () => {
  const st = S.state;
  const me = mySide(), foe = 1 - me;
  S.view = clone(st.battle);
  $app.innerHTML = `
    <section class="battle">
      <div class="arena">
        ${infoBox(foe, false)}
        <div class="spot foe"><div class="plate"></div><img class="sprite" data-side="${foe}" alt=""></div>
        <div class="spot me"><div class="plate"></div><img class="sprite" data-side="${me}" alt=""></div>
        ${infoBox(me, true)}
        <div id="irritation" class="irritation" hidden></div>
      </div>
      <div class="console">
        <div class="msgbox"><p id="msg"></p></div>
        <div id="menu" class="menu" hidden></div>
        <div id="skillDesc" class="skill-desc" hidden></div>
        <div class="console-foot"><button id="chartBtn" class="chart-btn">相性表</button></div>
      </div>
      <div id="chart" class="chart-pop" hidden>${typeChartHtml()}</div>
    </section>`;
  for (const i of [0, 1]) syncSide(i, false);
  renderIrritation(st.battle.turn);
  $('#chartBtn').addEventListener('click', () => { $('#chart').hidden = !$('#chart').hidden; });
  $('#chart').addEventListener('click', () => { $('#chart').hidden = true; });

  const b = st.battle;
  if (b.turn === 1 && !b.ready.some(Boolean) && !b.need.some(Boolean)) {
    // 開始演出：くりだすまでは、うちの子の画像と体力表示を隠しておく
    const parts = (side) => [$(`.sprite[data-side="${side}"]`), $(`.info[data-side="${side}"]`)];
    for (const side of [0, 1]) parts(side).forEach((el) => el?.classList.add('unsent'));
    const sendOut = (side) => {
      parts(side).forEach((el) => el?.classList.remove('unsent'));
      play('switchIn');
      fx(side, 'enter');
    };
    runAnimation(async () => {
      const pn = (i) => st.players[i].name;
      play('start');
      setMsg(`${pn(foe)}が しょうぶを しかけてきた！`);
      await sleep(1200);
      sendOut(foe);
      await say(`${pn(foe)}は ${activeData(foe).name}を くりだした！`);
      sendOut(me);
      await say(myIndex() >= 0 ? `いけっ！ ${activeData(me).name}！` : `${pn(me)}は ${activeData(me).name}を くりだした！`);
    });
  }
};

UPDATE.battle = () => {
  if (S.animating) return;
  const st = S.state;
  const b = st.battle;
  const mi = myIndex();
  const menu = $('#menu');
  if (b.over) { menu.hidden = true; return; }
  if (mi < 0) {
    menu.hidden = true;
    setMsg(b.need.some(Boolean) ? 'つぎの うちの子を えらんでいる…' : `ターン${b.turn}：たがいに こうどうを えらんでいる…`);
  } else if (!b.ready[mi]) {
    if (b.need[mi]) showSwitch(mi, true);
    else showMenu(mi);
  } else {
    hideMenu();
    setMsg(b.need.some(Boolean) ? 'あいてが つぎの うちの子を えらんでいます…' : 'あいての こうどうを まっています…');
  }
};

function hideMenu() {
  $('#menu').hidden = true;
  $('#skillDesc').hidden = true;
}

function choose(action) {
  hideMenu();
  setMsg('あいての こうどうを まっています…');
  act({ type: 'act', action });
}

// 同じ選択待ちの間は作り直さない（相手の選択で状態が届いても、開いている交代リストを閉じないため）
function menuKey() {
  const b = S.state.battle;
  return `${b.turn}-${b.need.join()}`;
}

function showMenu(mi) {
  const menu = $('#menu');
  if (!menu.hidden && menu.dataset.key === menuKey()) return;
  menu.dataset.key = menuKey();
  play('yourTurn');
  const f = activeData(mi);
  const canSwitch = S.view.teams[mi].some((_, k) => canSwitchTo(S.view, mi, k));
  setMsg(`${f.name}は どうする？`);
  menu.className = 'menu';
  const pp = S.view.teams[mi][S.view.active[mi]].pp;
  const allOut = pp.every((p) => p <= 0);
  menu.innerHTML = f.skills.map((s, k) => `
    <button class="move" data-k="${k}" style="--tc:${TYPE_COLORS[s.type] || '#999'}" ${pp[k] > 0 ? '' : 'disabled'}>
      <b>${esc(s.name)}</b>
      <small>${esc(s.type)}・威力${s.power || '—'}・命中${s.accuracy}${EFFECT_LABEL[s.effect] ? `・${EFFECT_LABEL[s.effect]}` : ''}</small>
      <span class="pp ${pp[k] <= 0 ? 'out' : pp[k] <= Math.ceil(s.pp / 4) ? 'low' : ''}">のこり ${pp[k]}/${s.pp}</span>
    </button>`).join('')
    + (allOut ? `<button class="struggle-btn">${esc(STRUGGLE.name)}（だせる わざが ない！）</button>` : '')
    + (S.state.teamSize > 1 ? `<button class="switch-btn" ${canSwitch ? '' : 'disabled'}>こうたい</button>` : '');
  menu.hidden = false;
  const desc = $('#skillDesc');
  $$('.move', menu).forEach((btn) => {
    const s = f.skills[btn.dataset.k];
    const show = () => { desc.textContent = s.desc || ''; desc.hidden = !s.desc; };
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('click', () => choose({ kind: 'skill', index: Number(btn.dataset.k) }));
  });
  $('.switch-btn', menu)?.addEventListener('click', () => showSwitch(mi, false, true));
  const sb = $('.struggle-btn', menu);
  if (sb) {
    sb.addEventListener('mouseenter', () => { desc.textContent = STRUGGLE.desc; desc.hidden = false; });
    sb.addEventListener('click', () => choose({ kind: 'struggle' }));
  }
}

function showSwitch(mi, forced, fromMenu = false) {
  const menu = $('#menu');
  if (!fromMenu && !menu.hidden && menu.dataset.key === menuKey()) return;
  if (!fromMenu) play('yourTurn');
  menu.dataset.key = menuKey();
  setMsg(forced ? 'つぎに だす うちの子を えらんでください' : 'だれと こうたいする？');
  $('#skillDesc').hidden = true;
  menu.className = 'menu switch-list';
  menu.innerHTML = S.state.teams[mi].map((f, k) => {
    const s = S.view.teams[mi][k];
    const ok = canSwitchTo(S.view, mi, k);
    const why = s.hp <= 0 ? 'ひんし' : k === S.view.active[mi] ? 'たたかっている' : '';
    return `
      <button class="member" data-to="${k}" ${ok ? '' : 'disabled'}>
        <img src="${sprite(mi, k)}" alt="">
        <span><b>${esc(f.name)}</b> ${typeBadge(f.type)}<br>
        <small>HP ${Math.max(0, s.hp)} / ${s.maxHp}${why ? `・${why}` : ''}</small></span>
      </button>`;
  }).join('') + (forced ? '' : '<button class="back-btn">もどる</button>');
  menu.hidden = false;
  $$('.member', menu).forEach((btn) => btn.addEventListener('click', () => choose({ kind: 'switch', to: Number(btn.dataset.to) })));
  $('.back-btn', menu)?.addEventListener('click', () => { menu.hidden = true; showMenu(mi); });
}

function setMsg(text) {
  const el = $('#msg');
  if (el) el.textContent = text;
}

async function say(text) {
  const el = $('#msg');
  if (!el) return;
  el.textContent = '';
  let n = 0;
  for (const ch of text) {
    el.textContent += ch;
    if (ch.trim() && n++ % 2 === 0) play('blip');
    await sleep(28);
  }
  await sleep(750);
}

function syncSide(i, animate = true) {
  const v = S.view;
  const k = v.active[i];
  const s = v.teams[i][k];
  const f = S.state.teams[i][k];
  const info = $(`.info[data-side="${i}"]`);
  if (!info) return;
  info.querySelector('.iname').textContent = f.name;
  info.querySelector('.itype').innerHTML = typeBadge(f.type);
  const pct = Math.max(0, s.hp / s.maxHp) * 100;
  const bar = info.querySelector('.hpbar i');
  bar.style.transition = animate ? '' : 'none';
  bar.style.width = `${pct}%`;
  bar.className = pct > 50 ? 'g' : pct > 20 ? 'y' : 'r';
  const num = info.querySelector('.hpnum');
  if (num) num.textContent = `${Math.max(0, s.hp)} / ${s.maxHp}`;
  const tags = [];
  const lab = { atk: '攻', def: '防', spd: '速' };
  for (const key of ['atk', 'def', 'spd']) {
    const st = s.stages[key];
    if (st) tags.push(`<span class="${st > 0 ? 'up' : 'down'}">${lab[key]}${st > 0 ? '↑' : '↓'}${Math.abs(st)}</span>`);
  }
  if (s.stunned) tags.push('<span class="stun">しびれ</span>');
  info.querySelector('.status-row').innerHTML = tags.join('');
  info.querySelector('.party').innerHTML = v.teams[i].length > 1
    ? v.teams[i].map((m, n) => `<i class="${m.hp <= 0 ? 'down' : ''} ${n === k ? 'cur' : ''}"></i>`).join('')
    : '';

  const img = $(`.sprite[data-side="${i}"]`);
  if (img && img.dataset.k !== String(k)) {
    img.dataset.k = k;
    img.src = sprite(i, k);
  }
  if (img && s.hp > 0) img.classList.remove('faint');
}

function fx(side, cls) {
  const el = $(`.sprite[data-side="${side}"]`);
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (cls !== 'faint') setTimeout(() => el.classList.remove(cls), 700);
}

async function playEvent(ev) {
  const a = ev.anim;
  const v = S.view;
  const cur = (side) => v.teams[side][v.active[side]];
  if (a?.kind === 'use') {
    await say(ev.text);
    play('use');
    fx(a.side, 'lunge');
    await sleep(350);
    return;
  }
  if (a?.kind === 'switch') {
    const out = cur(a.side);
    if (out.hp > 0) { play('switchOut'); fx(a.side, 'withdraw'); await sleep(400); }
    out.stages = { atk: 0, def: 0, spd: 0 };
    out.stunned = false;
    v.active[a.side] = a.to;
    syncSide(a.side, false);
    play('switchIn');
    fx(a.side, 'enter');
    await say(ev.text);
    return;
  }
  if (a) {
    switch (a.kind) {
      case 'hit':
        play(a.eff === 'super' ? 'hitBig' : a.eff === 'weak' ? 'hitWeak' : 'hit');
        fx(a.side, a.eff === 'super' ? 'hit-big' : 'hit');
        cur(a.side).hp = a.hp;
        syncSide(a.side);
        break;
      case 'heal':
        play('heal');
        fx(a.side, 'heal');
        cur(a.side).hp = a.hp;
        syncSide(a.side);
        break;
      case 'miss': play('miss'); fx(a.side, 'dodge'); break;
      case 'crit': play('crit'); break;
      case 'up': case 'down':
        play(a.kind);
        fx(a.side, a.kind);
        cur(a.side).stages[a.stat] = a.stage;
        syncSide(a.side);
        break;
      case 'stun':
        play('stun');
        fx(a.side, 'shock');
        cur(a.side).stunned = true;
        syncSide(a.side);
        break;
      case 'stunned':
        play('stun');
        fx(a.side, 'shock');
        cur(a.side).stunned = false;
        syncSide(a.side);
        break;
      case 'faint':
        play('faint');
        fx(a.side, 'faint');
        syncSide(a.side);
        break;
      case 'judge': {
        // 審判のいらだち：画面をゆらして倍率表示を更新
        play('judge');
        const arena = $('.arena');
        arena?.classList.remove('rumble');
        void arena?.offsetWidth;
        arena?.classList.add('rumble');
        const el = $('#irritation');
        if (el) {
          el.hidden = false;
          el.textContent = `審判のいらだち ダメージ×${a.mult.toFixed(2).replace(/0$/, '')}`;
        }
        break;
      }
    }
  }
  await say(ev.text);
}

async function runAnimation(fn) {
  S.animating = true;
  try { await fn(); } finally { S.animating = false; }
  const next = S.pending;
  S.pending = null;
  render(next && next.v >= S.state.v ? next : S.state);
}

function onTurn(msg) {
  if (S.mounted !== 'battle' || S.animating) {
    // 途中参加・再接続・アニメ中などで画面が追いついていないときは結果だけ反映
    if (S.animating) { S.pending = msg.state; return; }
    render(msg.state);
    return;
  }
  // 名前などは新しい状態から引く（このターンに初登場した相手の子の名前もここに入っている）
  S.state = msg.state;
  hideMenu();
  runAnimation(async () => {
    for (const ev of msg.events) await playEvent(ev);
    S.view = clone(msg.state.battle);
    for (const i of [0, 1]) syncSide(i);
    renderIrritation(msg.state.battle.turn);
    if (msg.state.phase === 'result') await sleep(1200);
  });
}

// ----- 決着 -----
MOUNT.result = () => {
  const st = S.state;
  const b = st.battle;
  const w = b.winner;
  if (w == null) {
    $app.innerHTML = `
      <section class="result">
        <h2 class="win-title">引き分け！</h2>
        <div class="duo">${[0, 1].map((i) => `<img class="sprite-img" src="${sprite(i, b.active[i])}" alt="">`).join('')}</div>
        <p class="judge-final">審判「……どっちも、強いね。」</p>
        <div id="resultAction" class="row center"></div>
      </section>`;
  } else {
    const f = st.teams[w][b.active[w]];
    const p = st.players[w];
    const left = b.teams[w].filter((s) => s.hp > 0).length;
    $app.innerHTML = `
      <section class="result">
        <p class="win-label">WINNER</p>
        <img class="sprite-img winner" src="${sprite(w, b.active[w])}" alt="">
        <h2 class="win-title">${esc(p.name)} のチーム</h2>
        <p class="owner">決めたのは ${esc(f.name)}${st.teamSize > 1 ? `（のこり ${left}/${st.teamSize}体）` : ''}</p>
        <blockquote class="victory">「${esc(f.victory_line)}」</blockquote>
        <p class="judge-final">審判「……うん、強かった。」</p>
        <div id="resultAction" class="row center"></div>
      </section>`;
  }
  // 決着後は両者の鑑定結果を公開
  $app.insertAdjacentHTML('beforeend', `
    <section class="reveal">
      <h2 class="reveal-title small">両者の鑑定結果</h2>
      ${[0, 1].map((side) => teamSection(side, { delayBase: 0.3 + side * 0.4 })).join('')}
    </section>`);
  $('#resultAction').innerHTML = isHost()
    ? `<button id="rematch" class="primary">同じうちの子でもう一戦</button>
       <button id="newRound">新しいうちの子で遊ぶ</button>`
    : '<p class="wait">ホストの操作を待っています<span class="dots"></span></p>';
  const mi = myIndex();
  play(w == null ? 'draw' : mi < 0 || mi === w ? 'win' : 'lose');
  scheduleCardSounds();
  $('#rematch')?.addEventListener('click', hostAction.startBattle);
  $('#newRound')?.addEventListener('click', hostAction.startSubmit);
};

// ---------- 起動 ----------
if (typeof Peer === 'undefined') {
  mountTitle('PeerJS を読み込めませんでした。ネットワーク接続を確認してください。');
} else {
  mountTitle();
}
