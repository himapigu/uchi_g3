// PeerJS を使った P2P 接続。ホストが状態の正本を持ち、参加者はホストに1本だけ接続する。
// シグナリングは PeerJS の無料クラウド。自前サーバーに替える場合は PEER_OPTIONS を書き換える。
//   例: { host: 'peer.example.com', port: 443, path: '/myapp', secure: true }
export const PEER_OPTIONS = {
  debug: 1,
};

const ID_PREFIX = 'uchinoko-ichiban-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const peerIdFor = (code) => ID_PREFIX + normalizeCode(code);

function errorText(err) {
  switch (err?.type) {
    case 'peer-unavailable': return '部屋が見つかりません。ルームIDを確認してください。';
    case 'browser-incompatible': return 'このブラウザは WebRTC に対応していません。';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'シグナリングサーバーに接続できません。通信環境を確認してください。';
    default: return `接続エラー（${err?.type || err?.message || err}）`;
  }
}

export class HostNet {
  constructor({ onMessage, onLeave, onError }) {
    this.onMessage = onMessage;
    this.onLeave = onLeave;
    this.onError = onError;
    this.conns = new Map();
    this.peer = null;
    this.code = null;
  }

  open(retries = 4) {
    return new Promise((resolve, reject) => {
      const code = makeRoomCode();
      const peer = new Peer(peerIdFor(code), PEER_OPTIONS);
      let opened = false;
      peer.on('open', () => {
        opened = true;
        this.peer = peer;
        this.code = code;
        resolve(code);
      });
      peer.on('error', (err) => {
        if (!opened) {
          peer.destroy();
          if (err.type === 'unavailable-id' && retries > 0) this.open(retries - 1).then(resolve, reject);
          else reject(new Error(errorText(err)));
        } else if (err.type !== 'peer-unavailable') {
          this.onError?.(errorText(err));
        }
      });
      peer.on('disconnected', () => {
        // シグナリングから切れても既存の P2P 接続は生きている。新規参加用に再接続だけ試みる。
        if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* noop */ } }, 1000);
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => this.conns.set(conn.peer, conn));
        conn.on('data', (data) => this.onMessage(conn.peer, data));
        const leave = () => {
          if (this.conns.get(conn.peer) === conn) {
            this.conns.delete(conn.peer);
            this.onLeave(conn.peer);
          }
        };
        conn.on('close', leave);
        conn.on('error', leave);
      });
    });
  }

  send(id, msg) {
    const c = this.conns.get(id);
    if (c?.open) c.send(msg);
  }

  broadcast(msg) {
    for (const c of this.conns.values()) if (c.open) c.send(msg);
  }

  /** 相手ごとに中身を変えて送る（makeMsg(id) → メッセージ） */
  sendEach(makeMsg) {
    for (const [id, c] of this.conns) if (c.open) c.send(makeMsg(id));
  }

  drop(id) {
    const c = this.conns.get(id);
    if (c) setTimeout(() => c.close(), 500);
  }
}

export class GuestNet {
  constructor({ onMessage, onClose, onError }) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.peer = null;
    this.conn = null;
  }

  join(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_OPTIONS);
      this.peer = peer;
      let done = false;
      const fail = (msg) => {
        if (done) return;
        done = true;
        peer.destroy();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('接続がタイムアウトしました。ルームIDを確認してください。'), 15000);
      peer.on('open', () => {
        const conn = peer.connect(peerIdFor(code), { reliable: true });
        conn.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.conn = conn;
          resolve(peer.id);
        });
        conn.on('data', (data) => this.onMessage(data));
        conn.on('close', () => { if (this.conn === conn) this.onClose(); });
        conn.on('error', () => { if (this.conn === conn) this.onClose(); });
      });
      peer.on('error', (err) => {
        if (!done) { clearTimeout(timer); fail(errorText(err)); }
        else this.onError?.(errorText(err));
      });
    });
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }
}
