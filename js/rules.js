// ゲームのルール定数（属性・効果・上限値）
// 鑑定用の指示文（prompt/appraisal-instructions.md）と値を揃えること。

export const TYPES = ['炎', '水', '草', '雷', '氷', '地', '闇', '光', '無'];

export const EFFECTS = ['none', 'heal', 'buff_atk', 'buff_def', 'debuff', 'stun'];
// 簡略形式（UCHINOKO2）で使う効果の略号
export const EFFECT_CODES = { n: 'none', h: 'heal', ba: 'buff_atk', bd: 'buff_def', db: 'debuff', st: 'stun' };

// ジョーク寄りのゲームなので上限はゆるめ。極端な個性はアリ、ただし1ターンで終わりすぎない程度に。
export const LIMITS = {
  hp: [60, 250],         // 下限60：これより低いと一撃で落ちやすく、浮いた分も能力の上限120で使い切れない
  stat: [1, 120],        // atk / def / spd それぞれ
  // hp + atk + def + spd の合計上限。HP も予算に入れる（HP だけ高くすれば得、にならないように）。
  // シミュレーションでは HP と こうげき/ぼうぎょ を 1:1 で交換すると、ふつうの範囲でほぼ五分になる。
  statTotal: 400,
  power: [0, 150],
  accuracy: [30, 100],
  powerTotal: Infinity,  // 技の威力合計は制限しない
  skillCount: 4,
};

// 攻撃側 → 防御側 の相性（2 = 弱点を突く、0.5 = いまひとつ、書いていない組み合わせは ふつう）
// 実際の倍率は下の SUPER_MULT / WEAK_MULT で決まる。
export const CHART = {
  炎: { 草: 2, 氷: 2, 炎: 0.5, 水: 0.5, 地: 0.5 },
  水: { 炎: 2, 地: 2, 水: 0.5, 草: 0.5 },
  草: { 水: 2, 地: 2, 炎: 0.5, 草: 0.5 },
  雷: { 水: 2, 雷: 0.5, 草: 0.5, 地: 0.5 },
  氷: { 草: 2, 地: 2, 炎: 0.5, 水: 0.5, 氷: 0.5 },
  地: { 炎: 2, 雷: 2, 草: 0.5 },
  闇: { 光: 2, 闇: 0.5 },
  光: { 闇: 2, 光: 0.5 },
  無: {},
};

// 弱点を突いたとき：ダメージ ×2、さらに相手の防御を 3/4 として計算する（硬い子への切り札）
// 以前は ×2.5・防御半分で、弱点技を片方だけ持つと 1対1 の勝率が約88%（シミュレーション）と決定的すぎた。
export const SUPER_MULT = 2;
export const SUPER_DEF_FACTOR = 0.75;
export const WEAK_MULT = 0.5;

// 鑑定AIが決める「苦手な属性」の追加倍率。今は使っていない（1 = 無効）。
// 笑える展開のために再導入するときは 1.25 などにし、指示文に weakness を戻す。
export const AI_WEAKNESS_MULT = 1;

/** 相性：'super'（弱点）/ 'weak'（いまひとつ）/ 'normal' */
export function typeMatch(attackType, defendType) {
  const v = CHART[attackType]?.[defendType] ?? 1;
  return v > 1 ? 'super' : v < 1 ? 'weak' : 'normal';
}

/** その属性の弱点（その属性に「こうかはばつぐん」を取れる属性）の一覧 */
export function weaknessesOf(type) {
  return TYPES.filter((a) => typeMatch(a, type) === 'super');
}

// すばやさの回避：相手より速いほど、相手の技（自分にかける変化技以外）を かわしやすい。
// すばやさが「先に動けるか」にしか効かず、速さ特化の子が弱すぎたための調整。
export const SPEED_EVADE = {
  perPoint: 0.004, // すばやさの差 1 あたりの回避率（差75で上限）
  max: 0.3,        // 回避率の上限
};
export function evadeChance(defSpd, atkSpd) {
  return Math.min(SPEED_EVADE.max, Math.max(0, defSpd - atkSpd) * SPEED_EVADE.perPoint);
}

// 審判のいらだち：長引くと審判が気をもみ、全員の与ダメージが毎ターン上がっていく
// 始まるターンは体数で変える（体数が多いほど試合が長いので）。
// シミュレーションで、いらだちが無い場合に 4試合に1試合くらいが届く長さにしている。
export const IRRITATION = {
  startTurnBySize: { 1: 8, 2: 18, 3: 28 }, // このターンから
  step: 0.15,      // 1ターンごとに +15%
  lines: ['……まだやるの？', '……ねえ、まだ？', '……おなか すいてきた。', '……はやく きめて。', '……もう どっちでも いいよ。'],
};
export function irritationStart(teamSize = 1) {
  return IRRITATION.startTurnBySize[teamSize] ?? 10 * teamSize - 2;
}
export function irritationMult(turn, teamSize = 1) {
  const start = irritationStart(teamSize);
  return turn >= start ? 1 + IRRITATION.step * (turn - start + 1) : 1;
}

export const TYPE_COLORS = {
  炎: '#e8553e', 水: '#3e8de8', 草: '#4cae4f', 雷: '#e8c22e', 氷: '#62c7d6',
  地: '#b0844a', 闇: '#5b4a8a', 光: '#f0d878', 無: '#9a9a9a',
};

// 英語や別表記で返ってきたときの読み替え
export const TYPE_ALIASES = {
  fire: '炎', 火: '炎', ほのお: '炎',
  water: '水', みず: '水',
  grass: '草', plant: '草', くさ: '草', 木: '草',
  electric: '雷', thunder: '雷', 電気: '雷', でんき: '雷',
  ice: '氷', こおり: '氷',
  ground: '地', earth: '地', 土: '地', じめん: '地', 地面: '地',
  dark: '闇', あく: '闇', 悪: '闇', やみ: '闇',
  light: '光', holy: '光', ひかり: '光', 聖: '光',
  normal: '無', none: '無', ノーマル: '無', 無属性: '無',
};

// 回復量（最大HPに対する割合 / 与えたダメージに対する割合）
export const HEAL_RATIO = 0.25;   // 威力0の回復技
export const DRAIN_RATIO = 0.3;   // 威力ありの回復技（吸収）

/**
 * 技の使用回数（PP）。AI ではなくゲーム側で決める。強い技ほど少ない。
 *   攻撃技：威力 〜40:15 / 〜60:10 / 〜80:8 / 〜100:5 / 〜120:3 / それ以上:2
 *           追加効果つきは 1 回少なく、吸収（回復つき）は最大 4 回、命中60以下は 1 回多く
 *   変化技：回復 3 / しびれ 5 / 能力アップ 6 / 弱体 8
 */
export function skillPP(s) {
  if (s.power === 0) {
    return { heal: 3, stun: 5, buff_atk: 6, buff_def: 6, debuff: 8 }[s.effect] ?? 10;
  }
  let pp = s.power <= 40 ? 15 : s.power <= 60 ? 10 : s.power <= 80 ? 8 : s.power <= 100 ? 5 : s.power <= 120 ? 3 : 2;
  if (s.effect !== 'none') pp -= 1;
  if (s.effect === 'heal') pp = Math.min(pp, 4);
  if (s.accuracy <= 60) pp += 1;
  return Math.max(1, pp);
}

// すべての技を使い切ったときの技。反動があるので、使い切ったら長くは粘れない。
export const STRUGGLE = {
  // recoil：使うたびに自分の最大HPのこの割合を失う（6回で力尽きる）
  name: 'わるあがき', type: '無', power: 35, accuracy: 100, effect: 'none', recoil: 1 / 6,
  desc: 'だせる わざが ないときの さいごの ていこう。じぶんも ダメージを うける。',
};

export const EFFECT_LABEL = {
  none: '',
  heal: '回復',
  buff_atk: '攻撃UP',
  buff_def: '防御UP',
  debuff: '弱体',
  stun: 'しびれ',
};
