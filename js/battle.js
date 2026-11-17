// ターン制バトルの計算（ホストだけが実行する。AI は関与しない）
// 1人あたり 1〜3体のチーム戦。場に出ているのは各1体。交代あり。
//
// ターンの流れ
//   1. 各プレイヤーが「技」か「交代」を選ぶ
//   2. 交代が先に行われる（交代したターンは攻撃しない）
//   3. 技は場に出ている子のすばやさ順に出る
//   4. 倒れた子のプレイヤーは、控えがいれば次の子を選ぶ（強制交代。このときは相手は待つ）
//   5. 相手のチームを全員倒したら勝ち
//
// 技には使用回数（PP）がある。全部の技を使い切ると「わるあがき」（反動あり）しか出せない。
//
// 弱点（属性で決まる）を突くと ×2 で、相手の防御を 3/4 として計算する。
// 長引くと（1体8・2体18・3体28ターン目から）「審判のいらだち」で、毎ターン全員の与ダメージが上がる。
import {
  typeMatch, skillPP, evadeChance, STRUGGLE, HEAL_RATIO, DRAIN_RATIO,
  SUPER_MULT, SUPER_DEF_FACTOR, WEAK_MULT, AI_WEAKNESS_MULT, IRRITATION, irritationMult, irritationStart,
} from './rules.js';

export const DAMAGE_SCALE = 0.4;  // 威力 → ダメージの係数
export const MAX_TURNS = 80;      // これを超えたら残りHP割合で判定
const CRIT_RATE = 1 / 16;
const SECONDARY_RATE = 0.3;       // 威力のある技の追加効果が出る確率
const STUN_COOLDOWN = 3;          // しびれた後、しばらく再度しびれない（ハメ防止）

const STAT_LABEL = { atk: 'こうげき', def: 'ぼうぎょ', spd: 'すばやさ' };
const SELF_EFFECTS = ['heal', 'buff_atk', 'buff_def'];

export const stageMult = (s) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));
const freshStages = () => ({ atk: 0, def: 0, spd: 0 });

/**
 * @param {object[][]} teams teams[side][k] = 正規化済みファイター
 * @param {number[]} leads 各サイドの先発の番号
 */
export function createBattle(teams, leads = [0, 0]) {
  return {
    turn: 1,
    teams: teams.map((t) => t.map((f) => ({
      hp: f.stats.hp,
      maxHp: f.stats.hp,
      stages: freshStages(),
      stunned: false,
      stunCooldown: 0,
      pp: f.skills.map((s) => s.pp ?? skillPP(s)),
      downed: false,
    }))),
    active: leads.map((l, i) => (l >= 0 && l < teams[i].length ? l : 0)),
    revealed: teams.map((t, i) => t.map((_, k) => k === (leads[i] ?? 0))),
    need: [false, false], // 強制交代待ち
    over: false,
    winner: null, // 0 / 1 / null(引き分け)
  };
}

export const aliveCount = (b, side) => b.teams[side].filter((s) => s.hp > 0).length;

export function canSwitchTo(b, side, to) {
  return Number.isInteger(to) && to >= 0 && to < b.teams[side].length
    && to !== b.active[side] && b.teams[side][to].hp > 0;
}

function doSwitch(b, teams, names, side, to, say, forced) {
  const from = b.active[side];
  const out = b.teams[side][from];
  out.stages = freshStages();   // 引っ込めると能力変化としびれは消える
  out.stunned = false;
  b.active[side] = to;
  b.revealed[side][to] = true;
  const nm = (k) => teams[side][k].name;
  const text = forced
    ? `${names[side]}は ${nm(to)}を くりだした！`
    : `${names[side]}は ${nm(from)}を ひっこめた！ いけっ、${nm(to)}！`;
  say(text, { kind: 'switch', side, to });
}

/**
 * 1ターン分を解決する。
 * @param {object} prev createBattle / resolveTurn の戻り値
 * @param {object[][]} teams 正規化済みファイターのチーム
 * @param {({kind:'skill',index:number}|{kind:'switch',to:number})[]} actions 各サイドの行動
 * @param {string[]} names プレイヤー名
 */
export function resolveTurn(prev, teams, actions, names, rng = Math.random) {
  const b = JSON.parse(JSON.stringify(prev));
  const events = [];
  const say = (text, anim) => events.push(anim ? { text, anim } : { text });
  const F = (i) => teams[i][b.active[i]];        // 場のファイターのデータ
  const St = (i) => b.teams[i][b.active[i]];     // 場のファイターの状態
  const nm = (i) => F(i).name;
  const speed = (i) => F(i).stats.spd * stageMult(St(i).stages.spd);

  // 0. 審判のいらだち（長引くと、全員の与ダメージが毎ターン上がる）
  const teamSize = b.teams[0].length;
  const irritation = irritationMult(b.turn, teamSize);
  const sinceStart = b.turn - irritationStart(teamSize);
  if (sinceStart >= 0 && sinceStart % 3 === 0) {
    const line = IRRITATION.lines[Math.min(IRRITATION.lines.length - 1, sinceStart / 3)];
    say(`審判「${line}」`, { kind: 'judge', mult: irritation });
    say(`審判の いらだちで ダメージが ${irritation.toFixed(2).replace(/0$/, '')}ばいに なった！`);
  }

  // 1. 交代
  for (const i of [0, 1]) {
    const a = actions[i];
    if (a?.kind === 'switch' && canSwitchTo(b, i, a.to)) doSwitch(b, teams, names, i, a.to, say, false);
  }

  // 2. 技（すばやさ順）
  const s0 = speed(0), s1 = speed(1);
  const order = s1 > s0 || (s1 === s0 && rng() < 0.5) ? [1, 0] : [0, 1];

  const changeStage = (side, stat, delta) => {
    const st = St(side).stages;
    const before = st[stat];
    st[stat] = Math.max(-3, Math.min(3, before + delta));
    const d = st[stat] - before;
    if (d === 0) {
      say(`${nm(side)}の ${STAT_LABEL[stat]}は もう ${delta > 0 ? 'あがらない' : 'さがらない'}！`);
    } else {
      const deg = Math.abs(d) >= 2 ? (d > 0 ? 'ぐーんと ' : 'がくっと ') : '';
      say(`${nm(side)}の ${STAT_LABEL[stat]}が ${deg}${d > 0 ? 'あがった' : 'さがった'}！`,
        { kind: d > 0 ? 'up' : 'down', side, stat, stage: st[stat] });
    }
  };

  for (const i of order) {
    if (b.over) break;
    const a = actions[i];
    if (a?.kind !== 'skill' && a?.kind !== 'struggle') continue;
    const j = 1 - i;
    const me = St(i), foe = St(j);
    if (me.hp <= 0 || foe.hp <= 0) continue;

    if (me.stunned) {
      me.stunned = false;
      say(`${nm(i)}は しびれて うごけない！`, { kind: 'stunned', side: i });
      continue;
    }

    let skill;
    if (a.kind === 'skill' && me.pp[a.index] > 0) {
      skill = F(i).skills[a.index];
      me.pp[a.index]--;
    } else {
      skill = STRUGGLE;
      say(`${nm(i)}は だせる わざが ない！`);
    }
    say(`${nm(i)}の ${skill.name}！`, { kind: 'use', side: i });

    const selfMove = skill.power === 0 && SELF_EFFECTS.includes(skill.effect);
    if (!selfMove && rng() * 100 >= skill.accuracy) {
      say(`しかし ${nm(j)}には あたらなかった！`, { kind: 'miss', side: j });
      continue;
    }
    // 相手のほうが速ければ、その差に応じて かわされる
    if (!selfMove && rng() < evadeChance(speed(j), speed(i))) {
      say(`${nm(j)}は すばやく みをかわした！`, { kind: 'miss', side: j });
      continue;
    }

    let dealt = 0;
    if (skill.power > 0) {
      const atkType = skill.type || F(i).type;
      const match = typeMatch(atkType, F(j).type);
      let mult = match === 'super' ? SUPER_MULT : match === 'weak' ? WEAK_MULT : 1;
      if (F(j).weakness && atkType === F(j).weakness) mult *= AI_WEAKNESS_MULT;
      const stab = atkType === F(i).type ? 1.2 : 1;
      const crit = rng() < CRIT_RATE;
      // 急所はこちらの攻撃ダウン・相手の防御アップを無視する
      const aStage = crit ? Math.max(0, me.stages.atk) : me.stages.atk;
      const dStage = crit ? Math.min(0, foe.stages.def) : foe.stages.def;
      const A = F(i).stats.atk * stageMult(aStage);
      // 弱点を突くと、相手の防御を低く見て計算する（SUPER_DEF_FACTOR）
      const D = F(j).stats.def * stageMult(dStage) * (match === 'super' ? SUPER_DEF_FACTOR : 1);
      const ratio = (A + 40) / (D + 40);
      const raw = skill.power * DAMAGE_SCALE * ratio * mult * stab * irritation
        * (crit ? 1.5 : 1) * (0.85 + rng() * 0.15);
      dealt = Math.min(foe.hp, Math.max(1, Math.floor(raw)));
      foe.hp -= dealt;
      say(`${nm(j)}に ${dealt}の ダメージ！`, { kind: 'hit', side: j, hp: foe.hp, eff: match });
      if (crit) say('きゅうしょに あたった！', { kind: 'crit', side: j });
      if (match === 'super') say('じゃくてんを ついた！ こうかは ばつぐんだ！');
      else if (match === 'weak') say('こうかは いまひとつの ようだ……');
    }

    const triggers = skill.power === 0 || rng() < SECONDARY_RATE;
    switch (skill.effect) {
      case 'heal': {
        const amount = skill.power > 0 ? Math.floor(dealt * DRAIN_RATIO) : Math.floor(me.maxHp * HEAL_RATIO);
        const healed = Math.min(amount, me.maxHp - me.hp);
        if (healed > 0) {
          me.hp += healed;
          say(`${nm(i)}は HPを ${healed} かいふくした！`, { kind: 'heal', side: i, hp: me.hp });
        } else if (skill.power === 0) say(`しかし ${nm(i)}の HPは まんたんだ！`);
        break;
      }
      case 'buff_atk':
        if (triggers) changeStage(i, 'atk', skill.power === 0 ? 2 : 1);
        break;
      case 'buff_def':
        if (triggers) changeStage(i, 'def', skill.power === 0 ? 2 : 1);
        break;
      case 'debuff':
        if (triggers && foe.hp > 0) { changeStage(j, 'atk', -1); changeStage(j, 'def', -1); }
        break;
      case 'stun':
        if (triggers && foe.hp > 0) {
          if (foe.stunCooldown > 0 || foe.stunned) {
            if (skill.power === 0) say(`しかし ${nm(j)}には きかなかった！`);
          } else {
            foe.stunned = true;
            foe.stunCooldown = STUN_COOLDOWN;
            say(`${nm(j)}は しびれて しまった！`, { kind: 'stun', side: j });
          }
        }
        break;
      default:
        if (skill.power === 0) say('しかし なにも おこらなかった！');
    }

    // 反動（わるあがき）
    if (skill.recoil && me.hp > 0) {
      const r = Math.min(me.hp, Math.max(1, Math.ceil(me.maxHp * skill.recoil)));
      me.hp -= r;
      say(`${nm(i)}は はんどうで ${r}の ダメージを うけた！`, { kind: 'hit', side: i, hp: me.hp, eff: 'normal' });
    }

    // 倒れた判定（反動で自分が倒れることもある）
    for (const s of [j, i]) {
      const st = St(s);
      if (st.hp <= 0 && !st.downed) {
        st.downed = true;
        say(`${nm(s)}は たおれた！`, { kind: 'faint', side: s });
      }
    }
    const wiped = [0, 1].map((s) => aliveCount(b, s) === 0);
    if (wiped[0] || wiped[1]) {
      b.over = true;
      b.need = [false, false];
      b.winner = wiped[0] && wiped[1] ? null : wiped[0] ? 1 : 0;
      for (const s of [0, 1]) if (wiped[s]) say(`${names[s]}の うちの子は みんな たおれた！`);
    } else {
      for (const s of [0, 1]) if (St(s).hp <= 0) b.need[s] = true;
    }
  }

  if (!b.over) {
    for (const t of b.teams) for (const s of t) if (s.stunCooldown > 0) s.stunCooldown--;
    b.turn++;
    if (b.turn > MAX_TURNS) {
      const ratio = (side) => b.teams[side].reduce((a, s) => a + Math.max(0, s.hp), 0)
        / b.teams[side].reduce((a, s) => a + s.maxHp, 0);
      const r = [ratio(0), ratio(1)];
      b.over = true;
      b.need = [false, false];
      b.winner = r[0] === r[1] ? null : r[0] > r[1] ? 0 : 1;
      say(`${MAX_TURNS}ターンが けいかした！ のこりHPで はんていだ！`);
    }
  }
  return { battle: b, events };
}

/** 倒れた子の代わりを出す（強制交代） */
export function resolveForced(prev, teams, actions, names) {
  const b = JSON.parse(JSON.stringify(prev));
  const events = [];
  const say = (text, anim) => events.push(anim ? { text, anim } : { text });
  for (const i of [0, 1]) {
    if (!b.need[i]) continue;
    const to = actions[i]?.to;
    const pick = canSwitchTo(b, i, to) ? to : b.teams[i].findIndex((s, k) => canSwitchTo(b, i, k));
    if (pick >= 0) doSwitch(b, teams, names, i, pick, say, true);
    b.need[i] = false;
  }
  return { battle: b, events };
}
