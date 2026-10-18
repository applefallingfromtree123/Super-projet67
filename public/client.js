// 클라이언트: 입력 전송, 서버 상태 보간 렌더링, HUD / 채팅
(() => {
  const S = window.Shared;
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');

  let ws = null;
  let myId = null;
  let mode = null;
  let grid = null;
  let terrainCanvas = null;
  let miniTerrain = null;
  let lobbyModes = {};

  // 보간용 스냅샷: 이전/현재
  let prevSnap = null, curSnap = null, snapTime = 0, snapInterval = 33;
  const bulletsPrev = new Map();
  const effects = [];
  const trails = []; // 전투기 비행운, 전함 항적
  let deadInfo = null;
  let pendingSwitch = null;
  let inGame = false;

  const keys = {};
  const mouse = { x: 0, y: 0, l: false, r: false };
  const cam = { x: S.MAP_W / 2, y: S.MAP_H / 2 };

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
        buildTerrain();
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
      case 'fx': addEffect(m.x, m.y, m.s); break;
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
      b.innerHTML = `<div class="title">${MODE_ICON[key]} ${def.name}</div><div class="desc">${def.desc}</div><div class="count">접속자 ${info.humans}명</div>`;
      b.onclick = () => {
        const name = nameInput.value.trim();
        try { localStorage.setItem('bf_name', name); } catch {}
        send({ t: 'join', mode: key, name });
      };
      list.appendChild(b);
    }
  }
  function showLobby() {
    inGame = false;
    $('lobby').classList.remove('hidden');
    $('spawnPanel').classList.add('hidden');
    $('hud').classList.add('hidden');
  }
  $('backToLobby').onclick = () => { send({ t: 'leave' }); showLobby(); };

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
      info.innerHTML = `<div class="title">${v.name}</div>
        <div class="stat">체력 ${v.hp} · 속도 ${v.maxSpeed}</div>
        <div class="stat">주무기: ${v.weapons[0].name}</div>
        <div class="stat">보조: ${v.weapons[1].name}</div>
        <div class="desc">${vt === 'tank' ? '육지 전용 · 회전 포탑' : vt === 'ship' ? '바다 전용 · 강력한 함포' : '어디든 비행 · 멈출 수 없음'}</div>`;
      b.appendChild(info);
      b.onclick = () => {
        if (deadInfo && performance.now() < deadInfo.until) return;
        const me = curSnap && curSnap.p.find((p) => p.id === myId);
        if (me && me.a) pendingSwitch = vt;
        deadInfo = null;
        send({ t: 'spawn', vtype: vt });
        hideSpawn();
      };
      list.appendChild(b);
    }
    $('spawnPanel').classList.remove('hidden');
  }
  function hideSpawn() { $('spawnPanel').classList.add('hidden'); }

  // ---------- 지형 프리렌더 ----------
  function buildTerrain() {
    terrainCanvas = document.createElement('canvas');
    terrainCanvas.width = S.MAP_W; terrainCanvas.height = S.MAP_H;
    const t = terrainCanvas.getContext('2d');
    t.fillStyle = '#1d4f7a';
    t.fillRect(0, 0, S.MAP_W, S.MAP_H);
    for (let r = 0; r < S.ROWS; r++) {
      for (let c = 0; c < S.COLS; c++) {
        const x = c * S.TILE, y = r * S.TILE;
        if (grid[r * S.COLS + c]) {
          const shade = ((c * 7 + r * 13) % 5) * 3;
          t.fillStyle = `rgb(${62 + shade},${92 + shade},${50 + shade})`;
          t.fillRect(x, y, S.TILE, S.TILE);
        } else {
          // 해안 근처 얕은 바다
          let near = false;
          for (let dr = -1; dr <= 1 && !near; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < S.ROWS && cc < S.COLS && grid[rr * S.COLS + cc]) { near = true; break; }
          }
          if (near) { t.fillStyle = '#2a6d96'; t.fillRect(x, y, S.TILE, S.TILE); }
        }
      }
    }
    // 장식: 나무 / 파도
    for (let i = 0; i < 2500; i++) {
      const x = Math.random() * S.MAP_W, y = Math.random() * S.MAP_H;
      if (S.isLand(grid, x, y)) {
        t.fillStyle = 'rgba(30,60,28,0.7)';
        t.beginPath(); t.arc(x, y, 4 + Math.random() * 6, 0, Math.PI * 2); t.fill();
      } else if (i % 3 === 0) {
        t.strokeStyle = 'rgba(255,255,255,0.08)';
        t.beginPath(); t.moveTo(x, y); t.quadraticCurveTo(x + 8, y - 4, x + 16, y); t.stroke();
      }
    }
    // 격자
    t.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let x = 0; x <= S.MAP_W; x += 200) { t.beginPath(); t.moveTo(x, 0); t.lineTo(x, S.MAP_H); t.stroke(); }
    for (let y = 0; y <= S.MAP_H; y += 200) { t.beginPath(); t.moveTo(0, y); t.lineTo(S.MAP_W, y); t.stroke(); }
    t.strokeStyle = '#c33'; t.lineWidth = 6; t.strokeRect(0, 0, S.MAP_W, S.MAP_H);

    miniTerrain = document.createElement('canvas');
    miniTerrain.width = mini.width; miniTerrain.height = mini.height;
    miniTerrain.getContext('2d').drawImage(terrainCanvas, 0, 0, mini.width, mini.height);
  }

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

  function addEffect(x, y, s) {
    effects.push({ x, y, s: s || 8, t: 0, life: s ? 0.6 + s / 200 : 0.25 });
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
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const W = canvas.width = window.innerWidth;
    const H = canvas.height = window.innerHeight;
    ctx.fillStyle = '#0b1420';
    ctx.fillRect(0, 0, W, H);

    if (inGame && terrainCanvas) {
      const { players, bullets } = interpolated();
      const me = players.find((p) => p.id === myId);
      if (me && me.a) {
        // 전투기는 진행 방향 앞쪽을 더 보여줌
        const look = me.v === 'jet' ? 120 : 0;
        const tx = me.x + Math.cos(me.an) * look, ty = me.y + Math.sin(me.an) * look;
        cam.x += (tx - cam.x) * Math.min(1, dt * 8);
        cam.y += (ty - cam.y) * Math.min(1, dt * 8);
      }
      const ox = Math.round(W / 2 - cam.x), oy = Math.round(H / 2 - cam.y);
      ctx.drawImage(terrainCanvas, -ox, -oy, W, H, 0, 0, W, H);
      ctx.save();
      ctx.translate(ox, oy);

      // 항적 / 비행운
      for (const p of players) {
        if (!p.a) continue;
        if (p.v === 'ship' && Math.abs(p.sp) > 10 && Math.random() < dt * 12) trails.push({ x: p.x - Math.cos(p.an) * 38, y: p.y - Math.sin(p.an) * 38, t: 0, life: 1.8, k: 'wake' });
        if (p.v === 'jet') trails.push({ x: p.x - Math.cos(p.an) * 20, y: p.y - Math.sin(p.an) * 20, t: 0, life: 0.6, k: 'contrail' });
        if (p.v === 'tank' && Math.abs(p.sp) > 20 && Math.random() < 0.3) trails.push({ x: p.x, y: p.y, t: 0, life: 3, k: 'track', a: p.an });
      }
      for (let i = trails.length - 1; i >= 0; i--) {
        const tr = trails[i];
        tr.t += dt;
        if (tr.t > tr.life) { trails.splice(i, 1); continue; }
        const f = 1 - tr.t / tr.life;
        if (tr.k === 'wake') { ctx.strokeStyle = `rgba(255,255,255,${0.3 * f})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(tr.x, tr.y, 4 + tr.t * 14, 0, Math.PI * 2); ctx.stroke(); }
        else if (tr.k === 'contrail') { ctx.fillStyle = `rgba(255,255,255,${0.4 * f})`; ctx.beginPath(); ctx.arc(tr.x, tr.y, 3, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.save(); ctx.translate(tr.x, tr.y); ctx.rotate(tr.a); ctx.fillStyle = `rgba(30,25,15,${0.25 * f})`; ctx.fillRect(-3, -16, 6, 5); ctx.fillRect(-3, 11, 6, 5); ctx.restore(); }
      }

      // 지상 유닛 → 지상 포탄 → 전투기(그림자 포함) → 공중 탄환 순서로 그리기
      const alive = players.filter((p) => p.a && p.v);
      const drawUnit = (p) => {
        ctx.save(); ctx.translate(p.x, p.y);
        if (p.sh) { ctx.strokeStyle = 'rgba(120,200,255,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, S.VEHICLES[p.v].radius + 10, 0, Math.PI * 2); ctx.stroke(); }
        drawVehicle(ctx, p.v, p.an, p.tu, colorFor(p.id));
        ctx.restore();
      };
      for (const p of alive) if (p.v !== 'jet') drawUnit(p);
      drawBullets(bullets, 'ground');
      for (const p of alive) {
        if (p.v !== 'jet') continue;
        ctx.save(); ctx.translate(p.x + 30, p.y + 40); ctx.globalAlpha = 0.3;
        drawVehicle(ctx, 'jet', p.an, p.an, '#000'); ctx.restore();
      }
      for (const p of alive) if (p.v === 'jet') drawUnit(p);
      drawBullets(bullets, 'air');

      // 이름 / 체력바
      for (const p of alive) {
        const v = S.VEHICLES[p.v];
        const yOff = v.radius + 18;
        ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(p.x - 25, p.y - yOff, 50, 5);
        ctx.fillStyle = p.hp / v.hp > 0.35 ? '#3ecf6a' : '#e05a4f';
        ctx.fillRect(p.x - 25, p.y - yOff, 50 * Math.max(0, p.hp / v.hp), 5);
        ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = p.id === myId ? '#ffcf5a' : '#fff';
        ctx.fillText(p.n, p.x, p.y - yOff - 5);
      }

      // 폭발 효과
      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        e.t += dt;
        if (e.t > e.life) { effects.splice(i, 1); continue; }
        const f = e.t / e.life;
        const r = e.s ? e.s * (0.4 + f) : 6 + f * 6;
        ctx.fillStyle = `rgba(255,${Math.round(200 - f * 150)},60,${1 - f})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
        if (e.s > 50) { ctx.fillStyle = `rgba(60,60,60,${0.6 * (1 - f)})`; ctx.beginPath(); ctx.arc(e.x, e.y, r * 1.3, 0, Math.PI * 2); ctx.fill(); }
      }

      // 조준선
      if (me && me.a && me.v !== 'jet') {
        const wx = mouse.x - ox, wy = mouse.y - oy;
        ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(me.x, me.y); ctx.lineTo(me.x + Math.cos(me.tu) * 400, me.y + Math.sin(me.tu) * 400); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,207,90,.8)';
        ctx.beginPath(); ctx.arc(wx, wy, 10, 0, Math.PI * 2); ctx.stroke();
      } else if (me && me.a) {
        ctx.strokeStyle = 'rgba(255,207,90,.7)';
        const gx = me.x + Math.cos(me.an) * 260, gy = me.y + Math.sin(me.an) * 260;
        ctx.beginPath(); ctx.arc(gx, gy, 12, 0, Math.PI * 2); ctx.moveTo(gx - 18, gy); ctx.lineTo(gx + 18, gy); ctx.moveTo(gx, gy - 18); ctx.lineTo(gx, gy + 18); ctx.stroke();
      }
      ctx.restore();

      updateHud(me, players);
      drawMinimap(players);
    }
    requestAnimationFrame(frame);
  }

  function drawBullets(bullets, layer) {
    for (const b of bullets) {
      const [, x, y, a, vt, w] = b;
      const isAir = vt === 'jet';
      if ((layer === 'air') !== isAir) continue;
      const def = S.VEHICLES[vt].weapons[w];
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      if (def.homing) {
        ctx.fillStyle = '#ddd'; ctx.fillRect(-8, -2, 14, 4);
        ctx.fillStyle = 'rgba(255,160,60,.9)'; ctx.beginPath(); ctx.arc(-10, 0, 3 + Math.random() * 2, 0, Math.PI * 2); ctx.fill();
      } else if (def.splash) {
        ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.arc(0, 0, def.radius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,220,120,.3)'; ctx.fillRect(-14, -2, 14, 4);
      } else {
        ctx.fillStyle = '#fff6b0'; ctx.fillRect(-8, -1, 10, 2);
      }
      ctx.restore();
    }
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

  function drawMinimap(players) {
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
    mctx.strokeStyle = 'rgba(255,255,255,.5)';
    mctx.strokeRect((cam.x - innerWidth / 2) * sx, (cam.y - innerHeight / 2) * sy, innerWidth * sx, innerHeight * sy);
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

  // ---------- 입력 ----------
  const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  window.addEventListener('keydown', (e) => {
    if (!inGame || document.activeElement === nameInput || document.activeElement === $('lobbyChatInput')) return;
    if (e.key === 'Enter') { chatInput.focus(); e.preventDefault(); return; }
    if (e.code === 'Tab') e.preventDefault();
    if (e.code === 'Escape') {
      if ($('spawnPanel').classList.contains('hidden')) showSpawn('전투 기계 변경', 'Esc로 닫기 — 새 기체를 고르면 현재 기체는 퇴각(피격 1회 처리) 후 3초 뒤 재출격합니다');
      else if (!deadInfo) hideSpawn();
      return;
    }
    if (e.code === 'Space') e.preventDefault();
    keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.l = mouse.r = false; });
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) mouse.l = true; if (e.button === 2) mouse.r = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 터치: 왼쪽 절반 = 이동 스틱, 오른쪽 절반 = 조준 + 사격
  const touch = { move: null, aim: null };
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth / 2) touch.move = { id: t.identifier, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY };
      else { touch.aim = { id: t.identifier }; mouse.x = t.clientX; mouse.y = t.clientY; mouse.l = true; }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (touch.move && t.identifier === touch.move.id) { touch.move.x = t.clientX; touch.move.y = t.clientY; }
      if (touch.aim && t.identifier === touch.aim.id) { mouse.x = t.clientX; mouse.y = t.clientY; }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (touch.move && t.identifier === touch.move.id) touch.move = null;
      if (touch.aim && t.identifier === touch.aim.id) { touch.aim = null; mouse.l = false; }
    }
  });

  let lastInput = '';
  setInterval(() => {
    if (!inGame || !curSnap) return;
    const me = curSnap.p.find((p) => p.id === myId);
    const inp = { t: 'input', u: false, d: false, l: false, r: false, f1: mouse.l, f2: mouse.r || !!keys['Space'], aim: 0 };
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
    if (me) {
      const sx = me.x - cam.x + innerWidth / 2, sy = me.y - cam.y + innerHeight / 2;
      inp.aim = Math.round(Math.atan2(mouse.y - sy, mouse.x - sx) * 100) / 100;
    }
    const s = JSON.stringify(inp);
    if (s !== lastInput) { send(inp); lastInput = s; }
  }, 33);

  // 핑 표시 (상태 수신 간격)
  setInterval(() => { if (inGame) $('pingLabel').textContent = `${Math.round(1000 / snapInterval)} 틱/초`; }, 1000);

  renderModes();
  connect();
  requestAnimationFrame(frame);
})();
