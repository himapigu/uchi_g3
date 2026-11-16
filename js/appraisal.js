// 鑑定結果 JSON の読み込み・検証・補正。
// AI の出力は信用しない前提で、範囲外の値は丸め、足りない項目は補う。
import { TYPES, EFFECTS, LIMITS, TYPE_ALIASES } from './rules.js';

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

/** 貼り付けられた文字列から JSON 部分を取り出す（```json ブロックや前後の文章に対応） */
export const ENCODED_PREFIX = 'UCHINOKO1:';

/** ネタバレ防止の "UCHINOKO1:<base64>" 形式を JSON 文字列に戻す */
function decodeEncoded(t) {
  const m = t.match(/UCHINOKO1\s*[:：]\s*([A-Za-z0-9+/=_\-\s]+)/);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('UCHINOKO1 形式の文字列を復元できませんでした。途中で切れていないか確認してください。');
  }
}

export function encodeAppraisal(jsonText) {
  const bytes = new TextEncoder().encode(jsonText);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return ENCODED_PREFIX + btoa(bin);
}

export function extractJson(text) {
  let t = String(text || '').trim();
  const decoded = decodeEncoded(t);
  if (decoded != null) t = decoded;
  const block = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = block ? block[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('JSON が見つかりません。claude.ai の出力をそのまま貼り付けてください。');
  const slice = body.slice(start, end + 1)
    .replace(/[“”]/g, '"')       // “ ” を " に
    .replace(/,\s*([}\]])/g, '$1');         // 末尾カンマを除去
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`JSON の形式が正しくありません：${e.message}`);
  }
}

function normSkill(raw, i, fighterType, warn, who) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let effect = str(s.effect, 20, 'none').toLowerCase();
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

function normFighter(raw, playerName, no, teamSize, warn) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const who = teamSize > 1 ? `${playerName} #${no}` : playerName;
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
  const total = stats.atk + stats.def + stats.spd;
  if (total > LIMITS.statTotal) {
    const r = LIMITS.statTotal / total;
    stats.atk = Math.max(1, Math.floor(stats.atk * r));
    stats.def = Math.max(1, Math.floor(stats.def * r));
    stats.spd = Math.max(1, Math.floor(stats.spd * r));
    warn(`${who} の atk+def+spd が ${total} で上限 ${LIMITS.statTotal} を超えたので比率を保って縮めました`);
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

  // 属性相性を活かすため、自分と違う属性の技が1〜2個あるのが望ましい（補正はせず警告だけ）
  if (!skills.some((s) => s.type !== type)) warn(`${who} の技が全部「${type}」属性です（指示文では1〜2個は別属性にするよう頼んでいます）`);

  let weakness = f.weakness == null || f.weakness === '' ? null : normType(f.weakness);
  if (weakness === type) weakness = null;

  return {
    player: playerName,
    no,
    name: str(f.name, 30, `${playerName}のうちの子${teamSize > 1 ? no : ''}`),
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
export function parseAppraisal(text, playerNames, teamSize = 1) {
  const data = extractJson(text);
  const list = Array.isArray(data) ? data : data.fighters;
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
  const opening = str(data.opening_commentary ?? data.commentary?.opening, 200);
  return { teams, warnings, opening };
}

/** テスト用：ランダムな鑑定結果を作る（UCHINOKO1 形式） */
export function sampleAppraisal(playerNames, teamSize = 1) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const types = TYPES.filter((t) => t !== '無');
  const fighters = [];
  for (const p of playerNames) {
    for (let no = 1; no <= teamSize; no++) {
      const type = pick(types);
      const other = pick(types.filter((t) => t !== type));
      const atk = rnd(20, 110), def = rnd(20, 110), spd = Math.max(1, Math.min(120, 240 - atk - def - rnd(0, 40)));
      fighters.push({
        player: p,
        no,
        name: `${pick(['ねむれる', 'さすらいの', '伝説の', 'ちいさな', '怒れる'])}${pick(['もち', 'ポチ', 'タマ', 'ぷりん', 'ごろう'])}`,
        type,
        stats: { hp: rnd(60, 200), atk, def, spd },
        skills: [
          { name: `${type}のいぶき`, type, power: rnd(60, 100), accuracy: 90, effect: 'none', desc: `${type}の ちからを はきだす。` },
          { name: `${other}まじりの一撃`, type: other, power: rnd(50, 90), accuracy: 95, effect: pick(['none', 'debuff']), desc: `なぜか ${other}属性。` },
          { name: pick(['ねこじゃらし', 'にらみつける']), type: '無', power: 0, accuracy: 85, effect: pick(['debuff', 'stun']), desc: '相手の 気を そぐ。' },
          { name: pick(['ひるね', 'きあいだめ']), type, power: 0, accuracy: 100, effect: pick(['heal', 'buff_atk', 'buff_def']), desc: '自分を ととのえる。' },
        ],
        weakness: pick(types.filter((t) => t !== type)),
        appraisal: pick(['……それ、強いの？ まあ、悪くはない。', '見た目より やる。', '油断すると 噛まれるタイプ。']),
        victory_line: 'うちの子が いちばん つよい！',
        win_commentary: `${p}のうちの子、見事な勝利です！`,
      });
    }
  }
  return encodeAppraisal(JSON.stringify({ opening_commentary: 'さあ、うちの子たちの 頂上決戦の はじまりだ！', fighters }));
}
