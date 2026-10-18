// 클라이언트: 입력 전송, 서버 상태 보간, 3D 렌더링 호출, HUD / 채팅
import { World } from './world3d.js';

{
  const S = window.Shared;
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const world = new World(canvas, $('labels'));
  const mini = $('minimap');
  const mctx = mini.getContext('2d');

  let ws = null;
  let myId = null;
  let mode = null;
  let grid = null;
  let miniTerrain = null;
  let lobbyModes = {};

  // 보간용 스냅샷: 이전/현재
  let prevSnap = null, curSnap = null, snapTime = 0, snapInterval = 33;
  let deadInfo = null;
  let pendingSwitch = null;
  let inGame = false;

  const keys = {};

  // ---------- 연결 ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { $('connStatus').textContent = '서버 연결됨 · 모드를 선택하세요'; };
    ws.onclose = () => {
      $('connStatus').textContent = '연결이 끊겼습니다. 재연결 중…';
      showLobby();
      setTimeout(connect, 1500);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  }
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function onMessage(m) {
    switch (m.t) {
      case 'hello': myId = m.id; break;
      case 'lobby': lobbyModes = m.modes; renderModes(); break;
      case 'joined':
        myId = m.id; mode = m.mode;
        grid = S.generateMap(m.map, m.seed);
        world.load(grid);
        buildMinimap();
        prevSnap = curSnap = null;
        $('chatLog').innerHTML = '';
        $('killfeed').innerHTML = '';
        inGame = true;
        $('lobby').classList.add('hidden');
        $('hud').classList.remove('hidden');
        $('modeLabel').textContent = `⚔ ${S.MODES[mode].name}`;
        deadInfo = null;
        showSpawn('전투 기계 선택', S.MODES[mode].desc);
        break;
      case 'state': {
        const now = performance.now();
        if (curSnap) snapInterval = snapInterval * 0.9 + (now - snapTime) * 0.1;
        prevSnap = curSnap; curSnap = m; snapTime = now;
        break;
      }
      case 'fx': if (inGame) world.effect(m.x, m.y, m.s, curSnap ? curSnap.p : []); break;
      case 'kill': addKill(m); break;
      case 'chat': addChat(m); break;
      case 'dead':
        if (pendingSwitch) {
          const vt = pendingSwitch;
          pendingSwitch = null;
          setTimeout(() => send({ t: 'spawn', vtype: vt }), m.respawnIn * 1000 + 50);
          break;
        }
        deadInfo = { by: m.by, until: performance.now() + m.respawnIn * 1000 };
        showSpawn('격추당했습니다!', `${m.by} 에게 당했습니다.`);
        break;
    }
  }

  // ---------- 로비 ----------
  const nameInput = $('nameInput');
  try { nameInput.value = localStorage.getItem('bf_name') || ''; } catch {}
  const MODE_ICON = { combined: '🌐', tank: '🛡', ship: '⚓', air: '✈' };
  function renderModes() {
    const list = $('modeList');
    list.innerHTML = '';
    for (const [key, def] of Object.entries(S.MODES)) {
      const info = lobbyModes[key] || { humans: 0 };
      const b = document.createElement('button');
      b.className = 'card';
      const num = Object.keys(S.MODES).indexOf(key) + 1;
      b.innerHTML = `<div class="title"><kbd>${num}</kbd> ${MODE_ICON[key]} ${def.name}</div><div class="desc">${def.desc}</div><div class="count">접속자 ${info.humans}명</div>`;
      b.onclick = () => joinMode(key);
      list.appendChild(b);
    }
  }
  function joinMode(key) {
    const name = nameInput.value.trim();
    try { localStorage.setItem('bf_name', name); } catch {}
    send({ t: 'join', mode: key, name });
  }
  function leaveToLobby() { send({ t: 'leave' }); showLobby(); }
  function showLobby() {
    inGame = false;
    $('lobby').classList.remove('hidden');
    $('spawnPanel').classList.add('hidden');
    $('hud').classList.add('hidden');
    world.clearLabels();
  }
  $('backToLobby').onclick = leaveToLobby;

  // ---------- 기체 선택 ----------
  function showSpawn(title, sub) {
    $('spawnTitle').textContent = title;
    $('spawnSub').textContent = sub;
    const list = $('vehicleList');
    list.innerHTML = '';
    for (const vt of S.MODES[mode].vehicles) {
      const v = S.VEHICLES[vt];
      const b = document.createElement('button');
      b.className = 'card';
      const pc = document.createElement('canvas');
      pc.width = 120; pc.height = 70;
      const c = pc.getContext('2d');
      c.fillStyle = vt === 'ship' ? '#1d4f7a' : vt === 'tank' ? '#3c5a32' : '#2b3f5a';
      c.fillRect(0, 0, 120, 70);
      c.translate(60, 35);
      drawVehicle(c, vt, 0, 0, '#ffcf5a', 1.2);
      b.appendChild(pc);
      const info = document.createElement('div');
      const num = S.MODES[mode].vehicles.indexOf(vt) + 1;
      info.innerHTML = `<div class="title"><kbd>${num}</kbd> ${v.name}</div>
        <div class="stat">체력 ${v.hp} · 속도 ${v.maxSpeed}</div>
        <div class="stat">주무기: ${v.weapons[0].name}</div>
        <div class="stat">보조: ${v.weapons[1].name}</div>
        <div class="desc">${vt === 'tank' ? '육지 전용 · 회전 포탑' : vt === 'ship' ? '바다 전용 · 강력한 함포' : '어디든 비행 · 멈출 수 없음'}</div>`;
      b.appendChild(info);
      b.onclick = () => pickVehicle(vt);
      list.appendChild(b);
    }
    $('spawnPanel').classList.remove('hidden');
  }
  function pickVehicle(vt) {
    if (deadInfo && performance.now() < deadInfo.until) return;
    const me = curSnap && curSnap.p.find((p) => p.id === myId);
    if (me && me.a) pendingSwitch = vt;
    deadInfo = null;
    send({ t: 'spawn', vtype: vt });
    hideSpawn();
  }
  function hideSpawn() { $('spawnPanel').classList.add('hidden'); }

  // ---------- 미니맵 지형 ----------
  function buildMinimap() {
    miniTerrain = document.createElement('canvas');
    miniTerrain.width = mini.width; miniTerrain.height = mini.height;
    const t = miniTerrain.getContext('2d');
    const img = t.createImageData(mini.width, mini.height);
    for (let y = 0; y < mini.height; y++) for (let x = 0; x < mini.width; x++) {
      const land = S.isLand(grid, (x + 0.5) / mini.width * S.MAP_W, (y + 0.5) / mini.height * S.MAP_H);
      const i = (y * mini.width + x) * 4;
      img.data.set(land ? [86, 124, 62, 255] : [31, 92, 132, 255], i);
    }
    t.putImageData(img, 0, 0);
  }

  // ---------- 아이콘 (기체 선택 카드) ----------
  // ---------- 그리기 ----------
  function drawVehicle(c, vt, angle, turret, color, scale = 1) {
    c.save();
    c.scale(scale, scale);
    if (vt === 'tank') {
      c.rotate(angle);
      c.fillStyle = '#222'; c.fillRect(-20, -17, 40, 7); c.fillRect(-20, 10, 40, 7); // 궤도
      c.fillStyle = color; c.fillRect(-17, -12, 34, 24);
      c.strokeStyle = 'rgba(0,0,0,.4)'; c.strokeRect(-17, -12, 34, 24);
      c.rotate(turret - angle);
      c.fillStyle = '#333'; c.fillRect(0, -3, 28, 6); // 포신
      c.fillStyle = shade(color, -25); c.beginPath(); c.arc(0, 0, 9, 0, Math.PI * 2); c.fill();
    } else if (vt === 'ship') {
      c.rotate(angle);
      c.fillStyle = shade(color, -30);
      c.beginPath(); c.moveTo(42, 0); c.lineTo(22, -13); c.lineTo(-36, -12); c.lineTo(-40, 0); c.lineTo(-36, 12); c.lineTo(22, 13); c.closePath(); c.fill();
      c.fillStyle = '#8a929c'; c.fillRect(-26, -8, 44, 16);
      c.fillStyle = '#5d646d'; c.fillRect(-10, -6, 14, 12); // 함교
      for (const tx of [20, -22]) {
        c.save(); c.translate(tx, 0); c.rotate(turret - angle);
        c.fillStyle = '#2b2f35'; c.fillRect(0, -4, 20, 3); c.fillRect(0, 1, 20, 3);
        c.fillStyle = color; c.beginPath(); c.arc(0, 0, 6, 0, Math.PI * 2); c.fill();
        c.restore();
      }
    } else {
      c.rotate(angle);
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(22, 0); c.lineTo(4, -4); c.lineTo(-2, -20); c.lineTo(-8, -20); c.lineTo(-6, -4);
      c.lineTo(-16, -3); c.lineTo(-20, -10); c.lineTo(-23, -10); c.lineTo(-21, 0);
      c.lineTo(-23, 10); c.lineTo(-20, 10); c.lineTo(-16, 3); c.lineTo(-6, 4); c.lineTo(-8, 20); c.lineTo(-2, 20); c.lineTo(4, 4);
      c.closePath(); c.fill();
      c.fillStyle = '#9cd6ff'; c.beginPath(); c.ellipse(9, 0, 5, 2.2, 0, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp((n >> 16) + amt), g = clamp(((n >> 8) & 255) + amt), b = clamp((n & 255) + amt);
    return `rgb(${r},${g},${b})`;
    function clamp(v) { return Math.max(0, Math.min(255, v)); }
  }
  function colorFor(id) {
    if (id === myId) return '#ffcf5a';
    const pal = ['#e05a4f', '#c86bd6', '#4fb0e0', '#e08a3c', '#d6d6d6', '#5fd3a8', '#e05a9a', '#a3e05a'];
    return pal[id % pal.length];
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function interpolated() {
    if (!curSnap) return { players: [], bullets: [] };
    const t = prevSnap ? Math.min(1.5, (performance.now() - snapTime) / snapInterval) : 1;
    const prevP = new Map(prevSnap ? prevSnap.p.map((p) => [p.id, p]) : []);
    const players = curSnap.p.map((p) => {
      const q = prevP.get(p.id);
      if (!q || !q.a || !p.a || q.v !== p.v || Math.abs(q.x - p.x) > 200) return p;
      const k = Math.min(1, t);
      return { ...p, x: lerp(q.x, p.x, k), y: lerp(q.y, p.y, k), an: lerpAngle(q.an, p.an, k), tu: lerpAngle(q.tu, p.tu, k) };
    });
    const prevB = new Map(prevSnap ? prevSnap.b.map((b) => [b[0], b]) : []);
    const bullets = curSnap.b.map((b) => {
      const q = prevB.get(b[0]);
      if (!q) return b;
      const k = Math.min(1, t);
      return [b[0], lerp(q[1], b[1], k), lerp(q[2], b[2], k), b[3], b[4], b[5]];
    });
    return { players, bullets };
  }

  let lastFrame = performance.now();
  function frame() {
    const now = performance.now();
    // 느린 PC 에서도 카메라가 기체를 놓치지 않도록 실제 경과 시간을 쓴다 (최대 0.25초)
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    if (inGame && grid) {
      const { players, bullets } = interpolated();
      world.render(players, bullets, dt, myId, colorFor);
      const me = players.find((p) => p.id === myId);
      updateHud(me, players);
      drawMinimap(players, me);
    } else world.renderIdle(dt);
    requestAnimationFrame(frame);
  }

  // ---------- HUD ----------
  const wFills = [$('w1Fill'), $('w2Fill')];
  let lastHud = '';
  function updateHud(me, players) {
    if (me && me.a && me.v) {
      const v = S.VEHICLES[me.v];
      $('stats').classList.remove('hidden');
      $('hpFill').style.width = `${(me.hp / v.hp) * 100}%`;
      $('hpText').textContent = `${v.name} · ${me.hp} / ${v.hp}`;
      $('w1Name').textContent = v.weapons[0].name;
      $('w2Name').textContent = v.weapons[1].name;
      for (let i = 0; i < 2; i++) wFills[i].style.width = `${(1 - me.cd[i] / v.weapons[i].reload) * 100}%`;
      $('speedText').textContent = `속도 ${Math.abs(me.sp)} · 격추 ${me.k} · 피격 ${me.d}`;
    } else $('stats').classList.add('hidden');

    if (deadInfo) {
      const left = Math.max(0, (deadInfo.until - performance.now()) / 1000);
      $('spawnSub').textContent = left > 0 ? `${deadInfo.by} 에게 당했습니다. ${left.toFixed(1)}초 후 재출격 가능` : '재출격할 전투 기계를 선택하세요';
    }

    const sb = $('scoreboard');
    if (keys['Tab']) {
      const rows = [...players].sort((a, b) => b.k - a.k || a.d - b.d)
        .map((p) => `<tr class="${p.id === myId ? 'me' : ''}"><td>${escapeHtml(p.n)}</td><td>${p.v ? S.VEHICLES[p.v].name : '-'}</td><td>${p.k}</td><td>${p.d}</td></tr>`).join('');
      const html = `<table><tr><th>이름</th><th>기체</th><th>격추</th><th>피격</th></tr>${rows}</table>`;
      if (html !== lastHud) { sb.innerHTML = html; lastHud = html; }
      sb.classList.remove('hidden');
    } else sb.classList.add('hidden');
  }

  function drawMinimap(players, me) {
    const sx = mini.width / S.MAP_W, sy = mini.height / S.MAP_H;
    mctx.clearRect(0, 0, mini.width, mini.height);
    mctx.globalAlpha = 0.85;
    mctx.drawImage(miniTerrain, 0, 0);
    mctx.globalAlpha = 1;
    for (const p of players) {
      if (!p.a || !p.v) continue;
      mctx.fillStyle = p.id === myId ? '#ffcf5a' : '#ff5a4f';
      const s = p.id === myId ? 5 : 3.5;
      if (p.v === 'jet') {
        mctx.beginPath(); mctx.moveTo(p.x * sx, p.y * sy - s); mctx.lineTo(p.x * sx + s, p.y * sy + s); mctx.lineTo(p.x * sx - s, p.y * sy + s); mctx.fill();
      } else mctx.fillRect(p.x * sx - s / 2, p.y * sy - s / 2, s, s);
    }
    if (me && me.a) {
      // 내 진행 방향
      mctx.strokeStyle = 'rgba(255,207,90,.8)';
      mctx.beginPath(); mctx.moveTo(me.x * sx, me.y * sy); mctx.lineTo((me.x + Math.cos(me.an) * 400) * sx, (me.y + Math.sin(me.an) * 400) * sy); mctx.stroke();
    }
  }

  // ---------- 킬피드 / 채팅 ----------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function addKill(m) {
    const el = document.createElement('div');
    el.innerHTML = `${escapeHtml(m.killer)}<span class="w">[${escapeHtml(m.weapon)}]</span>${escapeHtml(m.victim)}`;
    $('killfeed').prepend(el);
    while ($('killfeed').children.length > 5) $('killfeed').lastChild.remove();
    setTimeout(() => el.remove(), 6000);
  }
  function addChat(m) {
    const log = m.lobby || !inGame ? $('lobbyChatLog') : $('chatLog');
    const el = document.createElement('div');
    if (m.sys) { el.className = 'sys'; el.textContent = m.text; }
    else el.innerHTML = `<span class="name">${escapeHtml(m.from)}</span>: ${escapeHtml(m.text)}`;
    log.appendChild(el);
    while (log.children.length > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  const chatInput = $('chatInput');
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      if (chatInput.value.trim()) send({ t: 'chat', text: chatInput.value });
      chatInput.value = '';
      chatInput.blur();
    } else if (e.key === 'Escape') chatInput.blur();
  });
  $('lobbyChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      const name = nameInput.value.trim();
      send({ t: 'chat', text: e.target.value, name });
      e.target.value = '';
    }
  });

  // ---------- 입력 (키보드 전용) ----------
  // 이동 WASD/방향키 · 포탑 Q/E (R 정면 복귀) · 주무기 Space/J · 보조무기 F/K
  const KEYMAP = {
    KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
    KeyQ: 'tl', KeyE: 'tr', KeyR: 'c', Space: 'f1', KeyJ: 'f1', KeyF: 'f2', KeyK: 'f2',
  };
  const DIGITS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3 };
  const lobbyChatInput = $('lobbyChatInput');
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { nameInput.blur(); e.preventDefault(); e.stopPropagation(); } });
  lobbyChatInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { lobbyChatInput.blur(); e.stopPropagation(); } });

  window.addEventListener('keydown', (e) => {
    const typing = document.activeElement === nameInput || document.activeElement === lobbyChatInput;
    if (typing) return;
    // 로비: 숫자키로 모드 선택, Enter 로비 채팅, N 닉네임 입력
    if (!inGame) {
      if (e.code in DIGITS) { const key = Object.keys(S.MODES)[DIGITS[e.code]]; if (key) joinMode(key); }
      else if (e.key === 'Enter') { lobbyChatInput.focus(); e.preventDefault(); }
      else if (e.code === 'KeyN') { nameInput.focus(); e.preventDefault(); }
      return;
    }
    // 기체 선택 창: 숫자키로 선택, L 로비로, Esc 닫기
    if (!$('spawnPanel').classList.contains('hidden')) {
      if (e.code in DIGITS) { const vt = S.MODES[mode].vehicles[DIGITS[e.code]]; if (vt) pickVehicle(vt); }
      else if (e.code === 'KeyL') leaveToLobby();
      else if (e.code === 'Escape' && !deadInfo) hideSpawn();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') { chatInput.focus(); e.preventDefault(); return; }
    if (e.code === 'Escape') { showSpawn('전투 기계 변경', 'Esc로 닫기 — 새 기체를 고르면 현재 기체는 퇴각(피격 1회 처리) 후 3초 뒤 재출격합니다'); return; }
    if (e.code === 'KeyV') { world.camMode = world.camMode === 'chase' ? 'top' : 'chase'; return; }
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // 터치 (키보드 없는 기기용): 왼쪽 절반 = 이동 스틱, 오른쪽 절반 = 주무기 사격
  const touch = { move: null, fire: null };
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth / 2) touch.move = { id: t.identifier, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY };
      else touch.fire = t.identifier;
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (touch.move && t.identifier === touch.move.id) { touch.move.x = t.clientX; touch.move.y = t.clientY; }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (touch.move && t.identifier === touch.move.id) touch.move = null;
      if (t.identifier === touch.fire) touch.fire = null;
    }
  });

  let lastInput = '';
  setInterval(() => {
    if (!inGame || !curSnap) return;
    const me = curSnap.p.find((p) => p.id === myId);
    const inp = { t: 'input', u: false, d: false, l: false, r: false, tl: false, tr: false, c: false, f1: touch.fire !== null, f2: false };
    for (const [code, k] of Object.entries(KEYMAP)) if (keys[code]) inp[k] = true;
    if (touch.move) {
      const dx = touch.move.x - touch.move.sx, dy = touch.move.y - touch.move.sy;
      if (Math.hypot(dx, dy) > 20 && me) {
        // 스틱 방향으로 회전하며 전진
        const d = Math.atan2(dy, dx) - me.an;
        const diff = Math.atan2(Math.sin(d), Math.cos(d));
        inp.l = diff < -0.15; inp.r = diff > 0.15; inp.u = true;
      }
    }
    const s = JSON.stringify(inp);
    if (s !== lastInput) { send(inp); lastInput = s; }
  }, 33);

  // 핑 표시 (상태 수신 간격)
  setInterval(() => { if (inGame) $('pingLabel').textContent = `${Math.round(1000 / snapInterval)} 틱/초`; }, 1000);

  renderModes();
  world.load(S.generateMap('mixed', 4242));
  if (!nameInput.value) nameInput.focus();
  connect();
  requestAnimationFrame(frame);
}
