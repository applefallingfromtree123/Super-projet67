// 서버(Node)와 클라이언트(브라우저)가 함께 쓰는 게임 규칙 / 지형 정의
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE = 40;
  const MAP_W = 6400;
  const MAP_H = 4800;
  const COLS = MAP_W / TILE;
  const ROWS = MAP_H / TILE;

  // 전투 모드
  const MODES = {
    combined: { name: '통합전', desc: '전차 · 전함 · 전투기 모두 참전', vehicles: ['tank', 'ship', 'jet'], map: 'mixed' },
    tank: { name: '전차전', desc: '전차끼리 지상 대결', vehicles: ['tank'], map: 'land' },
    ship: { name: '해전', desc: '전함끼리 바다 위 대결', vehicles: ['ship'], map: 'sea' },
    air: { name: '공중전', desc: '전투기끼리 공중 도그파이트', vehicles: ['jet'], map: 'mixed' },
  };

  // 전투 기계 능력치
  // layer: ground = 지상/해상, air = 공중
  // weapons[].hits: 맞출 수 있는 층
  const VEHICLES = {
    tank: {
      name: '전차', layer: 'ground', terrain: 'land', hp: 120, radius: 18,
      maxSpeed: 130, accel: 260, turnRate: 2.4, minSpeed: -60,
      weapons: [
        { name: '주포', speed: 620, dmg: 34, reload: 1.1, life: 1.1, radius: 4, hits: ['ground'], splash: 30 },
        { name: '기관총', speed: 750, dmg: 4, reload: 0.09, life: 0.7, radius: 2, hits: ['ground', 'air'], spread: 0.06 },
      ],
    },
    ship: {
      name: '전함', layer: 'ground', terrain: 'sea', hp: 260, radius: 30,
      maxSpeed: 95, accel: 70, turnRate: 0.9, minSpeed: -35,
      weapons: [
        { name: '함포', speed: 520, dmg: 48, reload: 2.2, life: 2.0, radius: 5, hits: ['ground'], splash: 55, count: 2 },
        { name: '대공포', speed: 800, dmg: 6, reload: 0.12, life: 0.9, radius: 2, hits: ['air', 'ground'], spread: 0.12 },
      ],
    },
    jet: {
      name: '전투기', layer: 'air', terrain: 'any', hp: 80, radius: 16,
      maxSpeed: 380, accel: 220, turnRate: 2.8, minSpeed: 170,
      weapons: [
        { name: '기관포', speed: 950, dmg: 5, reload: 0.08, life: 0.75, radius: 2, hits: ['air', 'ground'], spread: 0.04, fixed: true },
        { name: '미사일', speed: 520, dmg: 42, reload: 3.5, life: 3.0, radius: 4, hits: ['air', 'ground'], homing: 3.2, fixed: true, splash: 35 },
      ],
    },
  };

  // 결정적 난수 (방 마다 같은 지도를 서버/클라에서 재현)
  function hash(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
    const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  }
  function fbm(x, y, seed) {
    return valueNoise(x, y, seed) * 0.6 + valueNoise(x * 2, y * 2, seed + 7) * 0.3 + valueNoise(x * 4, y * 4, seed + 13) * 0.1;
  }

  // 1 = 육지, 0 = 바다
  function generateMap(type, seed) {
    const grid = new Uint8Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const nx = c / COLS, ny = r / ROWS;
        const n = fbm(c / 14, r / 14, seed);
        let land;
        if (type === 'land') {
          land = n > 0.28; // 작은 호수 몇 개
        } else if (type === 'sea') {
          land = n > 0.74; // 작은 섬 몇 개
        } else {
          // 왼쪽은 대륙, 오른쪽은 바다, 해안선은 구불구불
          const coast = 0.5 + Math.sin(ny * 7) * 0.06 + (n - 0.5) * 0.35;
          land = nx < coast ? n > 0.25 : n > 0.78;
        }
        // 지도 가장자리 처리
        if (type === 'land' && (c === 0 || r === 0 || c === COLS - 1 || r === ROWS - 1)) land = true;
        grid[r * COLS + c] = land ? 1 : 0;
      }
    }
    return grid;
  }

  function isLand(grid, x, y) {
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return false;
    return grid[r * COLS + c] === 1;
  }

  // 해당 위치를 지나갈 수 있는가 (원 둘레 몇 점 검사)
  function canOccupy(grid, vtype, x, y) {
    const v = VEHICLES[vtype];
    if (x < v.radius || y < v.radius || x > MAP_W - v.radius || y > MAP_H - v.radius) return false;
    if (v.terrain === 'any') return true;
    const wantLand = v.terrain === 'land';
    const pts = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    for (const [dx, dy] of pts) {
      if (isLand(grid, x + dx * v.radius, y + dy * v.radius) !== wantLand) return false;
    }
    return true;
  }

  return { TILE, MAP_W, MAP_H, COLS, ROWS, MODES, VEHICLES, generateMap, isLand, canOccupy };
});
