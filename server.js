// 온라인 전투 게임 서버: 정적 파일 제공 + WebSocket 게임 로직 (서버 권위 방식)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30;
const MIN_COMBATANTS = Number(process.env.MIN_COMBATANTS ?? 4); // 사람이 부족하면 봇으로 채움
const RESPAWN_DELAY = 3;
const SPAWN_SHIELD = 2;
const MAX_NAME = 12;
const MAX_CHAT = 120;

// ---------- 정적 파일 서버 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- 유틸 ----------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function rotateToward(cur, target, maxStep) {
  const d = angleDiff(cur, target);
  return cur + clamp(d, -maxStep, maxStep);
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const BOT_NAMES = ['알파', '브라보', '찰리', '델타', '에코', '폭스트롯', '골프', '호텔', '인디아', '줄리엣', '킬로', '리마'];
let nextId = 1;

// ---------- 방 (모드 하나당 방 하나) ----------
class Room {
  constructor(mode) {
    this.mode = mode;
    this.def = S.MODES[mode];
    this.seed = Math.floor(Math.random() * 100000);
    this.grid = S.generateMap(this.def.map, this.seed);
    this.players = new Map(); // id -> player
    this.bullets = [];
    this.clients = new Set();
    this.time = 0;
  }

  humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }

  randomSpawn(vtype) {
    for (let i = 0; i < 400; i++) {
      const x = rand(80, S.MAP_W - 80), y = rand(80, S.MAP_H - 80);
      if (!S.canOccupy(this.grid, vtype, x, y)) continue;
      // 적과 너무 가깝지 않은 곳
      let ok = true;
      for (const o of this.players.values()) if (o.alive && dist2(o, { x, y }) < 350 * 350) { ok = false; break; }
      if (ok || i > 300) return { x, y };
    }
    return { x: S.MAP_W / 2, y: S.MAP_H / 2 };
  }

  addPlayer(p) {
    this.players.set(p.id, p);
    p.room = this;
    p.kills = 0; p.deaths = 0; p.alive = false; p.respawnAt = 0;
  }

  removePlayer(p) {
    this.players.delete(p.id);
    this.bullets = this.bullets.filter((b) => b.owner !== p.id);
  }

  spawn(p, vtype) {
    if (!this.def.vehicles.includes(vtype)) vtype = this.def.vehicles[0];
    const v = S.VEHICLES[vtype];
    const pos = this.randomSpawn(vtype);
    Object.assign(p, {
      vtype, x: pos.x, y: pos.y, angle: rand(-Math.PI, Math.PI), speed: vtype === 'jet' ? v.minSpeed + 40 : 0,
      hp: v.hp, alive: true, cd: [0, 0], shield: SPAWN_SHIELD,
    });
    p.aim = p.angle; p.turret = p.angle;
    if (vtype === 'jet') {
      // 지도 중앙을 향해 출발
      p.angle = Math.atan2(S.MAP_H / 2 - p.y, S.MAP_W / 2 - p.x);
      p.aim = p.turret = p.angle;
    }
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === 1) c.send(s);
  }

  // ---------- 봇 관리 ----------
  balanceBots() {
    const humans = this.humanCount();
    const bots = [...this.players.values()].filter((p) => p.bot);
    const want = humans === 0 ? 0 : Math.max(0, MIN_COMBATANTS - humans);
    while (bots.length < want) {
      const used = new Set([...this.players.values()].map((o) => o.name));
      const free = BOT_NAMES.map((n) => '[봇] ' + n).filter((n) => !used.has(n));
      const name = free.length ? free[Math.floor(Math.random() * free.length)] : '[봇] ' + nextId;
      const b = { id: nextId++, name, bot: true, input: {}, think: 0 };
      this.addPlayer(b);
      const vs = this.def.vehicles;
      this.spawn(b, vs[Math.floor(Math.random() * vs.length)]);
      bots.push(b);
    }
    while (bots.length > want) this.removePlayer(bots.pop());
  }

  botThink(p, dt) {
    const v = S.VEHICLES[p.vtype];
    const inp = p.input;
    p.think -= dt;
    // 목표 선택: 내 무기로 맞출 수 있는 가장 가까운 적
    if (p.think <= 0 || !p.target || !this.players.get(p.target)?.alive) {
      p.think = rand(0.5, 1.2);
      let best = null, bd = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const d = dist2(p, o);
        if (d < bd) { bd = d; best = o; }
      }
      p.target = best ? best.id : null;
      p.wander = p.wander ?? rand(-Math.PI, Math.PI);
      if (Math.random() < 0.3) p.wander = rand(-Math.PI, Math.PI);
    }
    const t = p.target ? this.players.get(p.target) : null;
    let goal = p.wander;
    let d = Infinity;
    if (t) {
      d = Math.sqrt(dist2(p, t));
      goal = Math.atan2(t.y - p.y, t.x - p.x);
      // 지상 유닛은 적당한 거리를 유지하며 선회
      if (p.vtype !== 'jet' && d < 260) goal += Math.PI / 2;
    }
    if (p.stuck > 0) { goal = p.angle + Math.PI * 0.8; p.stuck -= dt; }
    const diff = angleDiff(p.angle, goal);
    inp.l = diff < -0.1; inp.r = diff > 0.1;
    inp.u = p.vtype === 'jet' ? Math.abs(diff) < 1.2 : Math.abs(diff) < 1.6;
    inp.d = false;
    if (t) {
      // 간단한 리드 사격
      const w = v.weapons[0];
      const lead = d / w.speed;
      const tv = S.VEHICLES[t.vtype];
      const tx = t.x + Math.cos(t.angle) * (t.speed || 0) * lead * 0.8;
      const ty = t.y + Math.sin(t.angle) * (t.speed || 0) * lead * 0.8;
      inp.aim = Math.atan2(ty - p.y, tx - p.x) + rand(-0.06, 0.06);
      const range0 = w.speed * w.life;
      const facing = Math.abs(angleDiff(p.angle, inp.aim)) < 0.35;
      const canHit0 = w.hits.includes(tv.layer);
      const canHit1 = v.weapons[1].hits.includes(tv.layer);
      const range1 = v.weapons[1].speed * v.weapons[1].life;
      if (p.vtype === 'jet') {
        inp.f1 = facing && d < range1 + 80;
        inp.f2 = facing && d < 650 && Math.random() < 0.05;
      } else {
        inp.f1 = canHit0 && d < range0 * 0.95;
        inp.f2 = canHit1 && d < range1 && (!canHit0 || tv.layer === 'air');
      }
    } else {
      inp.f1 = inp.f2 = false;
      inp.aim = p.angle;
    }
  }

  // ---------- 시뮬레이션 ----------
  step(dt) {
    this.time += dt;
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.bot && this.time >= p.respawnAt) {
          const vs = this.def.vehicles;
          this.spawn(p, vs[Math.floor(Math.random() * vs.length)]);
        }
        continue;
      }
      if (p.bot) this.botThink(p, dt);
      this.movePlayer(p, dt);
      this.fireWeapons(p, dt);
    }
    this.updateBullets(dt);
  }

  movePlayer(p, dt) {
    const v = S.VEHICLES[p.vtype];
    const inp = p.input || {};
    p.shield = Math.max(0, p.shield - dt);
    // 전함은 속도가 있어야 잘 돈다
    let turn = v.turnRate;
    if (p.vtype === 'ship') turn *= 0.35 + 0.65 * Math.min(1, Math.abs(p.speed) / v.maxSpeed);
    if (inp.l) p.angle -= turn * dt;
    if (inp.r) p.angle += turn * dt;

    if (p.vtype === 'jet') {
      const target = inp.u ? v.maxSpeed : inp.d ? v.minSpeed : (v.maxSpeed + v.minSpeed) / 2;
      p.speed += clamp(target - p.speed, -v.accel * dt, v.accel * dt);
    } else if (inp.u) p.speed = Math.min(v.maxSpeed, p.speed + v.accel * dt);
    else if (inp.d) p.speed = Math.max(v.minSpeed, p.speed - v.accel * dt);
    else p.speed -= Math.sign(p.speed) * Math.min(Math.abs(p.speed), v.accel * 0.6 * dt);

    const nx = p.x + Math.cos(p.angle) * p.speed * dt;
    const ny = p.y + Math.sin(p.angle) * p.speed * dt;
    if (p.vtype === 'jet') {
      p.x = nx; p.y = ny;
      // 경계에 닿으면 강제로 회항
      if (p.x < 30 || p.x > S.MAP_W - 30 || p.y < 30 || p.y > S.MAP_H - 30) {
        p.x = clamp(p.x, 30, S.MAP_W - 30); p.y = clamp(p.y, 30, S.MAP_H - 30);
        p.angle = rotateToward(p.angle, Math.atan2(S.MAP_H / 2 - p.y, S.MAP_W / 2 - p.x), 6 * dt);
      }
    } else if (S.canOccupy(this.grid, p.vtype, nx, ny)) {
      p.x = nx; p.y = ny;
    } else if (S.canOccupy(this.grid, p.vtype, nx, p.y)) {
      p.x = nx; p.speed *= 0.9;
    } else if (S.canOccupy(this.grid, p.vtype, p.x, ny)) {
      p.y = ny; p.speed *= 0.9;
    } else {
      p.speed *= -0.2;
      if (p.bot) p.stuck = 0.8;
    }
    // 포탑 회전
    const tr = p.vtype === 'ship' ? 1.6 : 3.5;
    const aim = typeof inp.aim === 'number' && isFinite(inp.aim) ? inp.aim : p.angle;
    p.turret = p.vtype === 'jet' ? p.angle : rotateToward(p.turret, aim, tr * dt);
  }

  fireWeapons(p, dt) {
    const v = S.VEHICLES[p.vtype];
    const inp = p.input || {};
    for (let i = 0; i < 2; i++) {
      p.cd[i] = Math.max(0, p.cd[i] - dt);
      if (!(i === 0 ? inp.f1 : inp.f2) || p.cd[i] > 0) continue;
      const w = v.weapons[i];
      p.cd[i] = w.reload;
      const base = w.fixed ? p.angle : p.turret;
      const count = w.count || 1;
      for (let k = 0; k < count; k++) {
        const a = base + (w.spread ? rand(-w.spread, w.spread) : 0);
        // 여러 발이면 좌우로 나란히 발사
        const off = (k - (count - 1) / 2) * 10;
        const sx = p.x + Math.cos(a) * v.radius + Math.cos(a + Math.PI / 2) * off;
        const sy = p.y + Math.sin(a) * v.radius + Math.sin(a + Math.PI / 2) * off;
        const carry = p.vtype === 'jet' ? p.speed : 0;
        this.bullets.push({
          id: nextId++, owner: p.id, w: i, vt: p.vtype, x: sx, y: sy, angle: a,
          speed: w.speed + carry, life: w.life, def: w, layer: p.vtype === 'jet' ? 'air' : 'ground',
        });
      }
    }
  }

  updateBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      const w = b.def;
      if (w.homing) {
        let best = null, bd = 700 * 700;
        for (const o of this.players.values()) {
          if (!o.alive || o.id === b.owner || !w.hits.includes(S.VEHICLES[o.vtype].layer)) continue;
          const d = dist2(b, o);
          if (d < bd && Math.abs(angleDiff(b.angle, Math.atan2(o.y - b.y, o.x - b.x))) < 1.0) { bd = d; best = o; }
        }
        if (best) b.angle = rotateToward(b.angle, Math.atan2(best.y - b.y, best.x - b.x), w.homing * dt);
      }
      b.x += Math.cos(b.angle) * b.speed * dt;
      b.y += Math.sin(b.angle) * b.speed * dt;
      b.life -= dt;
      let hit = null;
      for (const o of this.players.values()) {
        if (!o.alive || o.id === b.owner) continue;
        const ov = S.VEHICLES[o.vtype];
        if (!w.hits.includes(ov.layer)) continue;
        if (dist2(b, o) < (ov.radius + w.radius) ** 2) { hit = o; break; }
      }
      const out = b.x < 0 || b.y < 0 || b.x > S.MAP_W || b.y > S.MAP_H;
      // 지상 포탄이 육지에 떨어진 경우 (전함 포탄이 섬에 막힘 등) 은 그대로 둔다: 단순화를 위해 지형 무시
      if (hit) {
        this.damage(hit, w.dmg, b.owner, b.w);
        if (w.splash) this.explode(b, hit);
        else this.broadcast({ t: 'fx', x: r1(b.x), y: r1(b.y), s: 0 });
      } else if (b.life <= 0 || out) {
        if (w.splash && !out) this.explode(b, null);
      } else keep.push(b);
    }
    this.bullets = keep;
  }

  explode(b, direct) {
    const w = b.def;
    this.broadcast({ t: 'fx', x: r1(b.x), y: r1(b.y), s: w.splash });
    for (const o of this.players.values()) {
      if (!o.alive || o === direct || o.id === b.owner) continue;
      if (!w.hits.includes(S.VEHICLES[o.vtype].layer)) continue;
      const d = Math.sqrt(dist2(b, o));
      if (d < w.splash + S.VEHICLES[o.vtype].radius) this.damage(o, w.dmg * 0.5, b.owner, b.w);
    }
  }

  damage(o, amount, ownerId, weaponIdx) {
    if (!o.alive || o.shield > 0) return;
    o.hp -= amount;
    if (o.hp > 0) return;
    o.alive = false;
    o.hp = 0;
    o.deaths++;
    o.respawnAt = this.time + RESPAWN_DELAY;
    const killer = this.players.get(ownerId);
    if (killer) killer.kills++;
    this.broadcast({ t: 'fx', x: r1(o.x), y: r1(o.y), s: 90 });
    this.broadcast({
      t: 'kill', killer: killer ? killer.name : '?', kv: killer ? killer.vtype : null,
      victim: o.name, vv: o.vtype, weapon: killer ? S.VEHICLES[killer.vtype].weapons[weaponIdx].name : '',
    });
    if (o.ws && o.ws.readyState === 1) o.ws.send(JSON.stringify({ t: 'dead', by: killer ? killer.name : '?', respawnIn: RESPAWN_DELAY }));
  }

  snapshot() {
    const p = [];
    for (const o of this.players.values()) {
      p.push({
        id: o.id, n: o.name, v: o.vtype || null, a: o.alive ? 1 : 0,
        x: r1(o.x || 0), y: r1(o.y || 0), an: r2(o.angle || 0), tu: r2(o.turret || 0), sp: Math.round(o.speed || 0),
        hp: Math.ceil(o.hp || 0), k: o.kills, d: o.deaths, sh: o.shield > 0 ? 1 : 0,
        cd: o.cd ? [r2(o.cd[0]), r2(o.cd[1])] : [0, 0],
      });
    }
    const b = this.bullets.map((x) => [x.id, r1(x.x), r1(x.y), r2(x.angle), x.vt, x.w]);
    return { t: 'state', p, b };
  }
}

const rooms = {};
for (const m of Object.keys(S.MODES)) rooms[m] = new Room(m);
const lobby = new Set();

function lobbyInfo() {
  const modes = {};
  for (const [k, r] of Object.entries(rooms)) modes[k] = { humans: r.humanCount(), total: r.players.size };
  return { t: 'lobby', modes };
}
function sendLobbyInfo() {
  const s = JSON.stringify(lobbyInfo());
  for (const c of lobby) if (c.readyState === 1) c.send(s);
}

function sanitize(str, max) {
  return String(str || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  const player = { id: nextId++, name: '병사' + Math.floor(Math.random() * 1000), ws, input: {}, room: null, lastChat: 0 };
  ws.player = player;
  lobby.add(ws);
  ws.send(JSON.stringify({ t: 'hello', id: player.id }));
  ws.send(JSON.stringify(lobbyInfo()));

  function leaveRoom() {
    const room = player.room;
    if (!room) return;
    room.removePlayer(player);
    room.clients.delete(ws);
    player.room = null;
    room.broadcast({ t: 'chat', sys: true, text: `${player.name} 님이 전장을 떠났습니다.` });
    room.balanceBots();
    lobby.add(ws);
    sendLobbyInfo();
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'join': {
        const room = rooms[m.mode];
        if (!room) return;
        leaveRoom();
        player.name = sanitize(m.name, MAX_NAME) || player.name;
        lobby.delete(ws);
        room.addPlayer(player);
        room.clients.add(ws);
        ws.send(JSON.stringify({ t: 'joined', id: player.id, mode: room.mode, seed: room.seed, map: room.def.map }));
        room.broadcast({ t: 'chat', sys: true, text: `${player.name} 님이 ${room.def.name}에 참전했습니다!` });
        room.balanceBots();
        sendLobbyInfo();
        break;
      }
      case 'spawn': {
        const room = player.room;
        if (!room) return;
        if (player.alive) {
          // 기체 교체 요청: 퇴각 처리 후 재출격 대기
          player.alive = false;
          player.deaths++;
          player.respawnAt = room.time + RESPAWN_DELAY;
          ws.send(JSON.stringify({ t: 'dead', by: '기체 교체', respawnIn: RESPAWN_DELAY }));
          return;
        }
        if (room.time < player.respawnAt) return;
        room.spawn(player, m.vtype);
        break;
      }
      case 'input': {
        player.input = { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r, f1: !!m.f1, f2: !!m.f2, aim: Number(m.aim) || 0 };
        break;
      }
      case 'chat': {
        const text = sanitize(m.text, MAX_CHAT);
        const now = Date.now();
        if (!text || now - player.lastChat < 400) return;
        player.lastChat = now;
        if (!player.room && m.name) player.name = sanitize(m.name, MAX_NAME) || player.name;
        const msg = { t: 'chat', from: player.name, text };
        if (player.room) player.room.broadcast(msg);
        else {
          const s = JSON.stringify({ ...msg, lobby: true });
          for (const c of lobby) if (c.readyState === 1) c.send(s);
        }
        break;
      }
      case 'leave':
        leaveRoom();
        break;
    }
  });

  ws.on('close', () => {
    lobby.delete(ws);
    leaveRoom();
    lobby.delete(ws);
  });
});

// ---------- 게임 루프 ----------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.1);
  for (const room of Object.values(rooms)) {
    if (room.clients.size === 0) continue;
    room.step(dt);
    room.broadcast(room.snapshot());
  }
}, TICK * 1000);
setInterval(sendLobbyInfo, 3000);

server.listen(PORT, () => console.log(`전투 게임 서버 실행 중: http://localhost:${PORT}`));
