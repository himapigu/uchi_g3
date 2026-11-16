// ゲームのルール定数（属性・効果・上限値）
// 鑑定用の指示文（prompt/appraisal-instructions.md）と値を揃えること。

export const TYPES = ['炎', '水', '草', '雷', '氷', '地', '闇', '光', '無'];

export const EFFECTS = ['none', 'heal', 'buff_atk', 'buff_def', 'debuff', 'stun'];

// ジョーク寄りのゲームなので上限はゆるめ。極端な個性はアリ、ただし1ターンで終わりすぎない程度に。
export const LIMITS = {
  hp: [30, 250],
  stat: [1, 120],        // atk / def / spd それぞれ
  statTotal: 260,        // atk + def + spd の合計上限（ゆるい安全柵）
  power: [0, 150],
  accuracy: [30, 100],
  powerTotal: Infinity,  // 技の威力合計は制限しない
  skillCount: 4,
};

// 攻撃側 → 防御側 の倍率（書いていない組み合わせは 1 倍）
const CHART = {
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

export function typeEffect(attackType, defendType) {
  return CHART[attackType]?.[defendType] ?? 1;
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

export const EFFECT_LABEL = {
  none: '',
  heal: '回復',
  buff_atk: '攻撃UP',
  buff_def: '防御UP',
  debuff: '弱体',
  stun: 'しびれ',
};
