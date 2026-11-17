// 画像の縮小、文章カードの生成、鑑定用コラージュの書き出し

const FONT = '"DotGothic16", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif';

/** 画像ファイルを長辺 max px の JPEG dataURL に縮小する（P2P で送るサイズに抑える） */
export function fileToDataURL(file, max = 640) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('画像ファイルを選んでください。'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像は読み込めませんでした（HEIC などは JPEG/PNG に変換してください）。'));
    };
    img.src = url;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 日本語向けに1文字ずつ折り返す */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

/** 枠内に収まるようにフォントを縮めながら文章を描く */
function drawTextBlock(ctx, text, x, y, w, h, { maxSize = 30, minSize = 14, color = '#222' } = {}) {
  let size = maxSize, lines;
  for (; size >= minSize; size -= 2) {
    ctx.font = `${size}px ${FONT}`;
    lines = wrapLines(ctx, text, w);
    if (lines.length * size * 1.5 <= h) break;
  }
  size = Math.max(size, minSize);
  ctx.font = `${size}px ${FONT}`;
  const lh = size * 1.5;
  const maxLines = Math.floor(h / lh);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 文章で提出されたうちの子を、バトル画面用のカード画像にする */
export function textCard(text) {
  const c = document.createElement('canvas');
  c.width = 360; c.height = 360;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fffbe8';
  roundRect(ctx, 6, 6, 348, 348, 24);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#3a3a3a';
  ctx.stroke();
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillStyle = '#b05a00';
  ctx.textBaseline = 'top';
  ctx.fillText('うちの子', 26, 22);
  drawTextBlock(ctx, text, 26, 58, 308, 276, { maxSize: 26, minSize: 12 });
  return c.toDataURL('image/png');
}

/** コラージュと JSON の突き合わせに使うラベル（1体だけなら名前のみ） */
export function slotLabel(name, k, teamSize) {
  return teamSize > 1 ? `${name} #${k + 1}` : name;
}

/**
 * 鑑定用コラージュ。groups: [{ name, entries: [{ kind: 'image'|'text', image, text }] }]
 * プレイヤーごとに1行。ラベルは鑑定結果 JSON の "player" / "no" と突き合わせに使う。
 */
export async function buildCollage(groups) {
  if (document.fonts?.ready) await document.fonts.ready;
  const teamSize = Math.max(...groups.map((g) => g.entries.length));
  const PW = 480, PH = 600, GAP = 26, TOP = 80;
  const W = teamSize * PW + (teamSize + 1) * GAP;
  const H = TOP + groups.length * (PH + GAP);
  const c = document.createElement('canvas');
  c.width = Math.max(W, 720); c.height = H;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#f3efe2';
  ctx.fillRect(0, 0, c.width, H);
  ctx.fillStyle = '#222';
  ctx.font = `bold 36px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(`うちの子 鑑定依頼（${groups.length}名 × ${teamSize}体）`, GAP, TOP / 2);

  for (let r = 0; r < groups.length; r++) {
    const g = groups[r];
    for (let k = 0; k < g.entries.length; k++) {
      const e = g.entries[k] || {};
      const x = GAP + k * (PW + GAP), y = TOP + r * (PH + GAP);
      ctx.fillStyle = '#fff';
      roundRect(ctx, x, y, PW, PH, 16);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#222';
      ctx.stroke();

      // 名前ラベル
      ctx.fillStyle = r % 2 ? '#9fd8ff' : '#ffd23f';
      roundRect(ctx, x + 14, y + 14, PW - 28, 66, 10);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `bold 36px ${FONT}`;
      ctx.textBaseline = 'middle';
      let label = slotLabel(g.name, k, teamSize);
      while (ctx.measureText(label).width > PW - 56 && label.length > 3) label = label.slice(0, -1);
      ctx.fillText(label, x + 28, y + 48);

      const bx = x + 18, by = y + 96, bw = PW - 36, bh = PH - 150;
      if (e.kind === 'image' && e.image) {
        const img = await loadImage(e.image);
        const s = Math.min(bw / img.width, bh / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
      } else {
        ctx.fillStyle = '#fffbe8';
        ctx.fillRect(bx, by, bw, bh);
        drawTextBlock(ctx, e.text || '', bx + 16, by + 16, bw - 32, bh - 32, { maxSize: 28, minSize: 12 });
      }
      ctx.fillStyle = '#666';
      ctx.font = `22px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(e.kind === 'image' ? '〔画像で提出〕' : '〔文章で提出〕', x + 22, y + PH - 28);
    }
  }
  return c;
}

export function downloadCanvas(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      resolve();
    }, 'image/png');
  });
}

/** チャットAIにコラージュと一緒に貼る依頼文。instructions を渡すと先頭に指示文も入れる */
export function requestText(groups, instructions = '') {
  const teamSize = Math.max(...groups.map((g) => g.entries.length));
  const lines = [];
  if (instructions) lines.push(instructions.trim(), '', '-----', '');
  lines.push(
    '【うちの子 鑑定依頼】',
    `参加者：${groups.map((g) => g.name).join('、')}（1人 ${teamSize}体）`,
    teamSize > 1
      ? 'コラージュ画像のラベル「名前 #番号」に対応させて、JSONの "player" には名前を、"no" には番号を入れてください。'
      : 'コラージュ画像のラベルと同じ名前を、JSONの "player" にそのまま入れてください（"no" は 1）。',
    '',
  );
  for (const g of groups) {
    g.entries.forEach((e, k) => {
      const label = slotLabel(g.name, k, teamSize);
      if (e.kind === 'image') lines.push(`・${label}：画像で提出（添付のコラージュ画像を参照）`);
      else lines.push(`・${label}：文章で提出`, '「', e.text, '」');
    });
    lines.push('');
  }
  lines.push(
    `全員（計${groups.length * teamSize}体）を同じ基準で鑑定し、技は画像・文章から読み取った特徴をもとに考えてください。`,
    '各ファイターの技4つのうち1〜2個は、そのファイター自身とは違う属性にしてください。',
    '結果は指示どおり簡略形式で作り、圧縮して UCHINOKO2: 形式に変換し、その文字列だけを返してください（鑑定内容は本文に書かないこと）。',
  );
  return lines.join('\n');
}
