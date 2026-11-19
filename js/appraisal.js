// 鑑定結果 JSON の読み込み・検証・補正。
// AI の出力は信用しない前提で、範囲外の値は丸め、足りない項目は補う。
import { TYPES, EFFECTS, EFFECT_CODES, LIMITS, TYPE_ALIASES, skillPP } from './rules.js';

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function num(v, range, fallback) {
  const n = Number(typeof v === 'string' ? v.replace(/[^\d.\-]/g, '') : v);
  return Number.isFinite(n) ? clamp(Math.round(n), range) : fallback;
}

function str(v, max, fallback = '') {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return (s || fallback).slice(0, max);
}

function normType(v) {
  const s = str(v, 20);
  if (TYPES.includes(s)) return s;
  const alias = TYPE_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  const hit = TYPES.find((t) => s.includes(t)); // 「炎属性」など
  return hit || null;
}

// 名前の突き合わせ用：全角半角・大文字小文字・カタカナひらがな・空白の違いを無視する
const key = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[\s　・.。、,]/g, '');

// ---------- 符号化 ----------
// UCHINOKO2:<base64> … 簡略形式の JSON を deflate（raw）で圧縮して Base64 にしたもの（今の形式）
// UCHINOKO1:<base64> … JSON をそのまま Base64 にしたもの（以前の形式。読み込みだけ対応）
export const ENCODED_PREFIX = 'UCHINOKO2:';

function b64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function pipeBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** "UCHINOKO1/2:<base64>" を JSON 文字列に戻す。該当しなければ null */
async function decodeEncoded(t) {
  const m = t.match(/UCHINOKO([12])\s*[:：]\s*([A-Za-z0-9+/=_\-\s]+)/);
  if (!m) return null;
  try {
    let bytes = b64ToBytes(m[2]);
    if (m[1] === '2') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`UCHINOKO${m[1]} 形式の文字列を復元できませんでした。途中で切れていないか、コピーしそこねていないか確認してください。`);
  }
}

/** JSON 文字列を UCHINOKO2 形式にする（テスト用サンプルで使う） */
export async function encodeAppraisal(jsonText) {
  const bytes = await pipeBytes(new TextEncoder().encode(jsonText), new CompressionStream('deflate-raw'));
  return ENCODED_PREFIX + bytesToB64(bytes);
}

/** 貼り付けられた文字列から JSON を取り出す（符号化、```json ブロック、前後の文章に対応） */
export async function extractJson(text) {
  let t = String(text || '').trim();
  const decoded = await decodeEncoded(t);
  if (decoded != null) t = decoded;
  const block = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = block ? block[1] : t;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('鑑定結果が見つかりません。チャットAIの返答をそのまま貼り付けてください。');
  const slice = body.slice(start, end + 1)
    .replace(/[“”]/g, '"')                // “ ” を " に
    .replace(/,\s*([}\]])/g, '$1');       // 末尾カンマを除去
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`鑑定結果の形式が正しくありません：${e.message}`);
  }
}

// ---------- 簡略形式 → ふつうの形式 ----------
// 簡略形式：{"o":"実況","f":[{"p":"名前","no":1,"n":"ファイター名","t":"草","s":[hp,atk,def,spd],
//            "k":[["技名","属性",威力,命中,"効果略号","説明"], ...],"a":"鑑定コメント","v":"勝利台詞"}]}
function expandFighter(x) {
  if (!x || typeof x !== 'object' || !('p' in x)) return x; // すでにふつうの形式
  const st = Array.isArray(x.s) ? x.s : [];
  return {
    player: x.p,
    no: x.no,
    name: x.n,
    type: x.t,
    stats: { hp: st[0], atk: st[1], def: st[2], spd: st[3] },
    skills: (Array.isArray(x.k) ? x.k : []).map((k) => (Array.isArray(k)
      ? { name: k[0], type: k[1], power: k[2], accuracy: k[3], effect: k[4], desc: k[5] }
      : k)),
    weakness: x.w,
    appraisal: x.a,
    victory_line: x.v,
  };
}

function expandData(data) {
  if (Array.isArray(data)) return { fighters: data.map(expandFighter) };
  const list = data.f ?? data.fighters;
  return {
    opening_commentary: data.o ?? data.opening_commentary ?? data.commentary?.opening,
    fighters: Array.isArray(list) ? list.map(expandFighter) : list,
  };
}

function normSkill(raw, i, fighterType, warn, who) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let effect = str(s.effect, 20, 'none').toLowerCase();
  effect = EFFECT_CODES[effect] ?? effect;
  if (!EFFECTS.includes(effect)) {
    warn(`${who} の技${i + 1}「${s.name ?? '?'}」の effect "${s.effect}" は不明なので none にしました`);
    effect = 'none';
  }
  const power = num(s.power, LIMITS.power, 40);
  const accuracy = num(s.accuracy, LIMITS.accuracy, 90);
  if (Number(s.power) !== power && s.power !== undefined) warn(`${who} の技「${s.name}」の威力を ${power} に補正しました`);
  if (Number(s.accuracy) !== accuracy && s.accuracy !== undefined) warn(`${who} の技「${s.name}」の命中を ${accuracy} に補正しました`);
  return {
    name: str(s.name, 16, `わざ${i + 1}`),
    type: normType(s.type) || fighterType,
    power,
    accuracy,
    effect,
    desc: str(s.desc, 60),
  };
}

/** ファイター名からプレイヤー名（と「たろうの」「（たろう）」などのつなぎ）を取り除く */
function stripPlayer(name, playerName) {
  if (typeof name !== 'string' || !playerName || !name.includes(playerName)) return name;
  const out = name.split(playerName).join(' ')
    .replace(/^[\s　]*(の|ん?ち?の|家の)/, '')
    .replace(/[（(【\[「][\s　]*[）)】\]」]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
  return out || name.replace(playerName, '').trim();
}

function normFighter(raw, playerName, no, teamSize, warn) {
  const f = raw && typeof raw === 'object' ? raw : {};
  if (typeof f.name === 'string' && playerName && f.name.includes(playerName)) {
    warn(`${playerName} のファイター名にプレイヤー名が入っていたので外しました`);
  }
  const who =teamSize > 1 ? `${playerName} #${no}` : playerName;
  let type = normType(f.type);
  if (!type) { warn(`${who} の属性 "${f.type}" は一覧にないので「無」にしました`); type = '無'; }

  const st = f.stats && typeof f.stats === 'object' ? f.stats : {};
  const stats = {
    hp: num(st.hp, LIMITS.hp, 100),
    atk: num(st.atk, LIMITS.stat, 50),
    def: num(st.def, LIMITS.stat, 50),
    spd: num(st.spd, LIMITS.stat, 50),
  };
  for (const k of ['hp', 'atk', 'def', 'spd']) {
    if (st[k] !== undefined && Number(st[k]) !== stats[k]) warn(`${who} の ${k} を範囲内（${stats[k]}）に補正しました`);
  }
  const total = stats.hp + stats.atk + stats.def + stats.spd;
  if (total > LIMITS.statTotal) {
    const r = LIMITS.statTotal / total;
    stats.hp = Math.max(LIMITS.hp[0], Math.floor(stats.hp * r));
    stats.atk = Math.max(LIMITS.stat[0], Math.floor(stats.atk * r));
    stats.def = Math.max(LIMITS.stat[0], Math.floor(stats.def * r));
    stats.spd = Math.max(LIMITS.stat[0], Math.floor(stats.spd * r));
    warn(`${who} の hp+atk+def+spd が ${total} で上限 ${LIMITS.statTotal} を超えたので比率を保って縮めました`);
  }

  let skillsRaw = Array.isArray(f.skills) ? f.skills : [];
  if (skillsRaw.length !== LIMITS.skillCount) warn(`${who} の技が ${skillsRaw.length} 個だったので ${LIMITS.skillCount} 個にそろえました`);
  skillsRaw = skillsRaw.slice(0, LIMITS.skillCount);
  const skills = skillsRaw.map((s, i) => normSkill(s, i, type, warn, who));
  while (skills.length < LIMITS.skillCount) {
    skills.push({ name: 'たいあたり', type: '無', power: 40, accuracy: 100, effect: 'none', desc: 'からだごと ぶつかる。' });
  }
  const powerSum = skills.reduce((a, s) => a + s.power, 0);
  if (powerSum > LIMITS.powerTotal) {
    const r = LIMITS.powerTotal / powerSum;
    skills.forEach((s) => { s.power = Math.floor(s.power * r); });
    warn(`${who} の技の威力合計が ${powerSum} で上限 ${LIMITS.powerTotal} を超えたので縮めました`);
  }
  // 使用回数はゲーム側のルールで決める（AI が pp を書いてきても使わない）
  skills.forEach((s) => { s.pp = skillPP(s); });

  // 属性相性を活かすため、自分と違う属性の技が1〜2個あるのが望ましい（補正はせず警告だけ）
  if (!skills.some((s) => s.type !== type)) warn(`${who} の技が全部「${type}」属性です（指示文では1〜2個は別属性にするよう頼んでいます）`);

  let weakness = f.weakness == null || f.weakness === '' ? null : normType(f.weakness);
  if (weakness === type) weakness = null;

  return {
    player: playerName,
    no,
    name: str(stripPlayer(f.name, playerName), 30, `うちの子${teamSize > 1 ? no : ''}`),
    type,
    stats,
    skills,
    weakness,
    appraisal: str(f.appraisal, 140, '……まあ、強いんじゃない？'),
    victory_line: str(f.victory_line, 100, 'うちの子が いちばん つよい！'),
    win_commentary: str(f.win_commentary, 140),
  };
}

/**
 * @param {string} text 貼り付けられた文字列
 * @param {string[]} playerNames ルームのプレイヤー名（並び順＝サイド番号）
 * @param {number} teamSize 1人あたりの うちの子の数
 * @returns {{ teams: object[][], warnings: string[], opening: string }}
 */
export async function parseAppraisal(text, playerNames, teamSize = 1) {
  const data = expandData(await extractJson(text));
  const list = data.fighters;
  if (!Array.isArray(list) || list.length === 0) throw new Error('"fighters" 配列がありません。');

  const warnings = [];
  const warn = (m) => warnings.push(m);
  const used = new Set();
  const take = (pred) => {
    const idx = list.findIndex((f, i) => !used.has(i) && pred(f || {}));
    if (idx < 0) return undefined;
    used.add(idx);
    return list[idx];
  };
  const slots = [];
  playerNames.forEach((name, pi) => {
    for (let k = 0; k < teamSize; k++) slots.push({ pi, k, name });
  });
  // 1回目：名前と番号が両方一致 → 2回目：名前だけ一致（並び順） → 3回目：残りを順番に
  for (const s of slots) s.raw = take((f) => key(f.player) === key(s.name) && Number(f.no ?? 1) === s.k + 1);
  for (const s of slots) if (!s.raw) s.raw = take((f) => key(f.player) === key(s.name));
  for (const s of slots) {
    if (s.raw) continue;
    s.raw = take(() => true);
    if (!s.raw) throw new Error(`「${s.name}」${teamSize > 1 ? `の${s.k + 1}体目` : ''}の鑑定結果がありません。`);
    warn(`「${s.name}」${teamSize > 1 ? ` #${s.k + 1}` : ''} と一致するものがなかったので、"${s.raw?.player ?? '?'}" の結果を割り当てました`);
  }
  if (list.length > slots.length) warn(`余分な鑑定結果 ${list.length - slots.length} 件は無視しました`);

  const teams = playerNames.map(() => []);
  for (const s of slots) teams[s.pi][s.k] = normFighter(s.raw, s.name, s.k + 1, teamSize, warn);
  const opening = str(data.opening_commentary, 120);
  return { teams, warnings, opening };
}

/** テスト用：ランダムな鑑定結果を作る（UCHINOKO2 形式） */
export async function sampleAppraisal(playerNames, teamSize = 1) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const types = TYPES.filter((t) => t !== '無');
  const f = [];
  for (const p of playerNames) {
    for (let no = 1; no <= teamSize; no++) {
      const t = pick(types);
      const other = pick(types.filter((x) => x !== t));
      // HP も含めて合計 LIMITS.statTotal 以内に収める
      const hp = rnd(60, 200);
      const left = LIMITS.statTotal - hp - rnd(0, 30);
      const atk = rnd(20, Math.min(110, left - 40)), def = rnd(20, Math.min(110, left - atk - 20));
      const spd = Math.max(1, Math.min(120, left - atk - def));
      f.push({
        p, no,
        n: `${pick(['ねむれる', 'さすらいの', '伝説の', 'ちいさな', '怒れる'])}${pick(['もち', 'ポチ', 'タマ', 'ぷりん', 'ごろう'])}`,
        t,
        s: [hp, atk, def, spd],
        k: [
          [`${t}のいぶき`, t, rnd(60, 100), 90, 'n', `${t}の ちからを はく`],
          [`${other}まじりの一撃`, other, rnd(50, 90), 95, pick(['n', 'db']), `なぜか ${other}属性`],
          [pick(['ねこじゃらし', 'にらみつける']), '無', 0, 85, pick(['db', 'st']), '気を そぐ'],
          [pick(['ひるね', 'きあいだめ']), t, 0, 100, pick(['h', 'ba', 'bd']), '自分を ととのえる'],
        ],
        a: pick(['……それ、強いの？ まあ悪くない。', '見た目より やる。', '油断すると噛まれる。']),
        v: 'うちの子が いちばん！',
      });
    }
  }
  return encodeAppraisal(JSON.stringify({ o: 'さあ、頂上決戦の はじまりだ！', f }));
}
