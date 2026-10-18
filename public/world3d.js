// 3D 렌더러 (Three.js): 지형 · 바다 · 하늘 · 전투 기계 · 탄환 · 폭발 효과 · 카메라
// 서버 좌표 (x, y) 는 3D 좌표 (x, 높이, y) 로 옮겨 그린다. 서버 각도 a 는 rotation.y = -a.
import * as THREE from 'three';

const S = window.Shared;
export const JET_ALT = 110;
const SEA_FLOOR = -22;
const SRGB = THREE.SRGBColorSpace;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// 시각 효과 전용 노이즈 (게임 규칙과 무관)
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------- 파티클 (불꽃 · 연기 · 비행운 · 물보라) ----------
class Particles {
  constructor(capacity, additive) {
    this.n = capacity;
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.a0 = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.uniforms = { projScale: { value: 500 } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        attribute float size; attribute vec4 pcolor; varying vec4 vColor; uniform float projScale;
        void main() {
          vColor = pcolor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * projScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = vColor.a * smoothstep(0.5, 0.15, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  // o: { x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav, drag }
  spawn(o) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = o.x; this.pos[i * 3 + 1] = o.y; this.pos[i * 3 + 2] = o.z;
    this.vel[i * 3] = o.vx || 0; this.vel[i * 3 + 1] = o.vy || 0; this.vel[i * 3 + 2] = o.vz || 0;
    this.col[i * 4] = o.r; this.col[i * 4 + 1] = o.g; this.col[i * 4 + 2] = o.b; this.col[i * 4 + 3] = o.a;
    this.life[i] = this.max[i] = o.life;
    this.s0[i] = o.s0; this.s1[i] = o.s1 ?? o.s0;
    this.a0[i] = o.a;
    this.grav[i] = o.grav || 0;
    this.drag[i] = o.drag || 0;
    this.size[i] = o.s0;
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.size[i] !== 0) { this.size[i] = 0; this.col[i * 4 + 3] = 0; } continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.max[i];
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.col[i * 4 + 3] = this.a0[i] * (1 - t) * (t < 0.1 ? t * 10 : 1);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}

// ---------- 전투 기계 모델 ----------
function std(color, opts = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2, ...opts }); }
const DARK = std(0x2a2c2e, { roughness: 0.9 });
const STEEL = std(0x3a3f45, { metalness: 0.5, roughness: 0.5 });
const GLASS = std(0x6fc3ff, { metalness: 0.6, roughness: 0.1, emissive: 0x0d2a40 });

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function barrel(len, r, mat) {
  const g = new THREE.CylinderGeometry(r, r, len, 10);
  g.rotateZ(-Math.PI / 2);
  g.translate(len / 2, 0, 0);
  return mesh(g, mat);
}
function extrudeFlat(points, depth, mat) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return mesh(g, mat);
}

function buildTank(color) {
  const body = std(color, { roughness: 0.75 });
  const dark = std(new THREE.Color(color).multiplyScalar(0.7), { roughness: 0.8 });
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(38, 9, 24), body, 0, 8, 0));
  g.add(mesh(new THREE.BoxGeometry(14, 5, 22), dark, 15, 10, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(42, 9, 7), DARK, 0, 5, s * 13.5));
    for (let i = 0; i < 5; i++) {
      const w = mesh(new THREE.CylinderGeometry(3.6, 3.6, 1.2, 12), STEEL, -15 + i * 7.5, 4.5, s * 17.2);
      w.rotation.x = Math.PI / 2;
      g.add(w);
    }
  }
  const turret = new THREE.Group();
  turret.position.set(-3, 15.5, 0);
  turret.add(mesh(new THREE.CylinderGeometry(9, 11, 7, 14), body));
  turret.add(mesh(new THREE.CylinderGeometry(3, 3, 2.5, 10), dark, -3, 4.5, 3));
  const b = barrel(30, 1.6, STEEL);
  b.position.set(8, 1, 0);
  turret.add(b);
  turret.add(mesh(new THREE.BoxGeometry(4, 3.6, 3.6), STEEL, 38, 1, 0));
  g.add(turret);
  g.userData.turrets = [turret];
  return g;
}

function buildShip(color) {
  const hullMat = std(0x7a838d, { roughness: 0.6 });
  const deck = std(0x8a7a62, { roughness: 0.9 });
  const accent = std(color, { roughness: 0.6 });
  const g = new THREE.Group();
  const outline = [[46, 0], [30, -12], [-34, -13], [-42, -8], [-42, 8], [-34, 13], [30, 12]];
  const hull = extrudeFlat(outline, 14, hullMat);
  hull.position.y = -6;
  g.add(hull);
  const top = extrudeFlat(outline.map(([x, y]) => [x * 0.97, y * 0.9]), 1, deck);
  top.position.y = 8;
  g.add(top);
  // 흘수선 띠 (플레이어 색)
  const band = extrudeFlat(outline.map(([x, y]) => [x * 1.005, y * 1.02]), 2, accent);
  band.position.y = 1;
  g.add(band);
  g.add(mesh(new THREE.BoxGeometry(24, 9, 14), std(0x9aa3ad), -6, 13, 0));
  g.add(mesh(new THREE.BoxGeometry(11, 8, 11), std(0xb7bec6), -3, 21, 0));
  g.add(mesh(new THREE.BoxGeometry(11.5, 2, 11.5), GLASS, -3, 23, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.8, 0.8, 20, 6), STEEL, -6, 32, 0));
  const funnel = mesh(new THREE.CylinderGeometry(3.4, 4.2, 13, 12), accent, -18, 19, 0);
  g.add(funnel);
  g.add(mesh(new THREE.CylinderGeometry(3.5, 3.5, 1.5, 12), DARK, -18, 26, 0));
  const turrets = [];
  for (const tx of [24, -32]) {
    const t = new THREE.Group();
    t.position.set(tx, 11.5, 0);
    t.add(mesh(new THREE.CylinderGeometry(6, 7, 5, 12), std(0x7d868f)));
    for (const z of [-2.3, 2.3]) {
      const b = barrel(20, 1.1, STEEL);
      b.position.set(4, 0.8, z);
      t.add(b);
    }
    g.add(t);
    turrets.push(t);
  }
  g.userData.turrets = turrets;
  g.userData.funnelTop = new THREE.Vector3(-18, 27, 0);
  return g;
}

function buildJet(color) {
  const body = std(color, { metalness: 0.45, roughness: 0.4 });
  const dark = std(new THREE.Color(color).multiplyScalar(0.6), { metalness: 0.4, roughness: 0.5 });
  const g = new THREE.Group();
  const fus = new THREE.CylinderGeometry(2.6, 3.4, 34, 12);
  fus.rotateZ(-Math.PI / 2);
  g.add(mesh(fus, body));
  const nose = new THREE.ConeGeometry(2.6, 11, 12);
  nose.rotateZ(-Math.PI / 2);
  g.add(mesh(nose, dark, 22.5, 0, 0));
  const canopy = mesh(new THREE.SphereGeometry(2.4, 12, 8), GLASS, 9, 2.3, 0);
  canopy.scale.set(2.6, 1, 1);
  g.add(canopy);
  const wing = extrudeFlat([[6, 0], [-8, 21], [-13, 21], [-12, 0], [-13, -21], [-8, -21]], 0.8, body);
  wing.position.y = -0.5;
  g.add(wing);
  const tail = extrudeFlat([[-12, 0], [-19, 9], [-22, 9], [-21, 0], [-22, -9], [-19, -9]], 0.6, dark);
  tail.position.y = 0.5;
  g.add(tail);
  const finShape = new THREE.Shape([[-11, 1], [-19, 12], [-22, 12], [-21, 1]].map(([x, y]) => new THREE.Vector2(x, y)));
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.6, bevelEnabled: false });
  fin.translate(0, 0, -0.3);
  g.add(mesh(fin, dark));
  const nozzle = new THREE.CylinderGeometry(2.6, 2.2, 3, 12);
  nozzle.rotateZ(-Math.PI / 2);
  g.add(mesh(nozzle, STEEL, -18.5, 0, 0));
  const flame = new THREE.Mesh(new THREE.ConeGeometry(2, 9, 10), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.geometry.rotateZ(Math.PI / 2);
  flame.position.set(-24, 0, 0);
  g.add(flame);
  g.userData.turrets = [];
  g.userData.flame = flame;
  return g;
}

const BUILDERS = { tank: buildTank, ship: buildShip, jet: buildJet };

// ---------- 지형 / 바다 / 하늘 ----------
function waterNormalTexture() {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const waves = [[3, 1, 0.3], [1, 4, 1.7], [5, -2, 2.4], [-4, 3, 4.1], [7, 5, 0.9], [2, -7, 3.3]];
  const h = (u, v) => waves.reduce((s, [kx, ky, ph]) => s + Math.sin(Math.PI * 2 * (kx * u + ky * v) + ph) / Math.hypot(kx, ky), 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, e = 1 / N;
    const dx = (h(u + e, v) - h(u - e, v)) * 0.6, dy = (h(u, v + e) - h(u, v - e)) * 0.6;
    const len = Math.hypot(dx, dy, 1);
    const i = (y * N + x) * 4;
    img.data[i] = (-dx / len * 0.5 + 0.5) * 255;
    img.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
    img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class World {
  constructor(canvas, labelRoot) {
    this.canvas = canvas;
    this.labelRoot = labelRoot;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    this.renderer = r;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xbcd6ea, 1400, 5200);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(55, 1, 2, 16000);
    this.camera.position.set(S.MAP_W / 2, 600, S.MAP_H / 2 + 800);

    // 하늘 돔 (세로 그라디언트)
    const sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x2e6fbf) }, horizon: { value: new THREE.Color(0xbcd6ea) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float t = pow(clamp(vP.y,0.0,1.0),0.55); gl_FragColor = vec4(mix(horizon, top, t),1.0); }',
    }));
    sky.renderOrder = -1;
    this.sky = sky;
    scene.add(sky);

    scene.add(new THREE.HemisphereLight(0xd6ecff, 0x40502e, 0.75));
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -650; sc.right = sc.top = 650; sc.near = 10; sc.far = 3000;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.sun = sun;
    scene.add(sun, sun.target);
    this.sunDir = new THREE.Vector3(-0.5, 1, -0.35).normalize();

    // 바다
    this.waterTex = waterNormalTexture();
    this.waterTex.repeat.set(300, 300);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshStandardMaterial({
      color: 0x1f6f9a, roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.84,
      normalMap: this.waterTex, normalScale: new THREE.Vector2(0.55, 0.55),
    }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(S.MAP_W / 2, 0, S.MAP_H / 2);
    water.receiveShadow = true;
    water.renderOrder = 1;
    scene.add(water);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshStandardMaterial({ color: 0x1d4256, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(S.MAP_W / 2, SEA_FLOOR - 0.5, S.MAP_H / 2);
    scene.add(floor);

    this.fire = new Particles(3000, true);
    this.smoke = new Particles(5000, false);
    scene.add(this.fire.points, this.smoke.points);

    this.vehicles = new Map(); // id -> { group, vt, color, bank, lastAn }
    this.bullets = new Map(); // id -> { mesh, kind, sx, sy, y0 }
    this.labels = new Map();
    this.terrain = null;
    this.camMode = 'chase';
    this.time = 0;
    this.camTarget = new THREE.Vector3(S.MAP_W / 2, 0, S.MAP_H / 2);

    // 조준 표시 (내 기체 전용)
    const aimMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 10, gapSize: 10, transparent: true, opacity: 0.45, depthWrite: false });
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), aimMat);
    this.aimLine.frustumCulled = false;
    this.aimRing = new THREE.Mesh(new THREE.RingGeometry(9, 12, 32), new THREE.MeshBasicMaterial({ color: 0xffcf5a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.aimRing.renderOrder = 4;
    scene.add(this.aimLine, this.aimRing);

    // 탄환용 공유 지오메트리 / 재질
    this.bulletGeo = {
      tracer: new THREE.BoxGeometry(14, 0.9, 0.9),
      shell: new THREE.SphereGeometry(2.6, 10, 8),
      missile: (() => { const g = new THREE.CylinderGeometry(1.1, 1.1, 10, 8); g.rotateZ(-Math.PI / 2); return g; })(),
    };
    this.bulletMat = {
      tracer: new THREE.MeshBasicMaterial({ color: 0xfff1a0 }),
      shell: new THREE.MeshBasicMaterial({ color: 0xffd36a }),
      missile: new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.3, roughness: 0.4 }),
    };
    this.bulletPool = { tracer: [], shell: [], missile: [] };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.fire.uniforms.projScale.value = this.smoke.uniforms.projScale.value = scale;
  }

  // ---------- 지도 구성 ----------
  load(grid) {
    this.grid = grid;
    if (this.terrain) {
      this.scene.remove(this.terrain, this.trees, this.leaves, this.rocks, this.border);
      for (const o of [this.terrain, this.trees, this.leaves, this.rocks]) { o.geometry.dispose(); }
    }
    for (const id of [...this.vehicles.keys()]) this.removeVehicle(id);
    this.syncBullets([]);
    const C = S.COLS, R = S.ROWS, T = S.TILE;
    const land = (c, r) => (c >= 0 && r >= 0 && c < C && r < R ? grid[r * C + c] : 0);
    // 내륙 정도: 주변 7x7 타일 중 육지 비율 (누적합으로 계산)
    const sum = new Float32Array((C + 1) * (R + 1));
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      sum[(r + 1) * (C + 1) + c + 1] = land(c, r) + sum[r * (C + 1) + c + 1] + sum[(r + 1) * (C + 1) + c] - sum[r * (C + 1) + c];
    }
    const area = (c0, r0, c1, r1) => {
      c0 = clamp(c0, 0, C); c1 = clamp(c1, 0, C); r0 = clamp(r0, 0, R); r1 = clamp(r1, 0, R);
      return sum[r1 * (C + 1) + c1] - sum[r0 * (C + 1) + c1] - sum[r1 * (C + 1) + c0] + sum[r0 * (C + 1) + c0];
    };
    const VW = C + 1, VH = R + 1;
    const H = new Float32Array(VW * VH);
    const inland = new Float32Array(VW * VH);
    for (let j = 0; j < VH; j++) for (let i = 0; i < VW; i++) {
      const f = (land(i - 1, j - 1) + land(i, j - 1) + land(i - 1, j) + land(i, j)) / 4;
      const inl = area(i - 4, j - 4, i + 4, j + 4) / 64;
      inland[j * VW + i] = inl;
      const hills = (noise2(i / 11, j / 11) * 0.7 + noise2(i / 4, j / 4) * 0.3);
      const landH = 4 + inl * inl * hills * 48;
      const deep = SEA_FLOOR + (1 - Math.min(1, area(i - 3, j - 3, i + 3, j + 3) / 6)) * -6;
      H[j * VW + i] = f === 0 ? deep * (0.6 + 0.4 * (1 - inl)) : -7 + f * (landH + 7);
    }
    this.heights = H;

    const geo = new THREE.PlaneGeometry(S.MAP_W, S.MAP_H, C, R);
    geo.rotateX(-Math.PI / 2);
    geo.translate(S.MAP_W / 2, 0, S.MAP_H / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const h = H[k];
      pos.setY(k, h);
      const n = hash2(k * 0.37, k * 0.11) * 0.08;
      if (h < -3) col.setRGB(0.36, 0.42, 0.34, SRGB);
      else if (h < 2) col.setRGB(0.82 + n, 0.74 + n, 0.52 + n, SRGB); // 모래
      else if (h < 22) col.setRGB(0.3 + n, 0.5 + n, 0.16 + n, SRGB); // 풀
      else if (h < 33) col.setRGB(0.26 + n, 0.44 + n, 0.15 + n, SRGB); // 짙은 풀
      else if (h < 40) col.setRGB(0.4 + n, 0.42 + n, 0.25 + n, SRGB); // 마른 풀
      else col.setRGB(0.52 + n, 0.5 + n, 0.46 + n, SRGB); // 바위
      colors.set([col.r, col.g, col.b], k * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    terrain.receiveShadow = true;
    this.terrain = terrain;
    this.scene.add(terrain);

    // 나무 / 바위 (인스턴싱)
    const treePts = [], rockPts = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!land(c, r)) continue;
      const inl = inland[r * VW + c];
      for (let k = 0; k < 2; k++) {
        const x = (c + hash2(c * 3 + k, r * 7)) * T, y = (r + hash2(c * 5, r * 3 + k)) * T;
        const h = this.heightAt(x, y);
        if (h < 4) continue;
        const roll = hash2(c + k * 91, r * 1.7);
        if (roll < 0.55 * inl * (noise2(c / 6, r / 6) > 0.45 ? 1 : 0.25)) treePts.push([x, h, y, 0.7 + hash2(x, y) * 0.7]);
        else if (roll > 0.985) rockPts.push([x, h, y, 0.6 + hash2(y, x) * 1.6]);
      }
    }
    const trunkGeo = new THREE.CylinderGeometry(1.2, 1.8, 9, 6); trunkGeo.translate(0, 4.5, 0);
    const leafGeo = new THREE.ConeGeometry(8, 22, 7); leafGeo.translate(0, 18, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, std(0x5a3f2a, { roughness: 1 }), treePts.length);
    const leaves = new THREE.InstancedMesh(leafGeo, std(0xffffff, { roughness: 0.9, metalness: 0 }), treePts.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    treePts.forEach(([x, h, y, s], i) => {
      q.setFromAxisAngle(tmpV.set(0, 1, 0), hash2(x, i) * 6.28);
      m4.compose(tmpV2.set(x, h - 1, y), q, sc.set(s, s * (0.85 + hash2(i, y) * 0.4), s));
      trunks.setMatrixAt(i, m4);
      leaves.setMatrixAt(i, m4);
      leaves.setColorAt(i, col.setHSL(0.26 + hash2(i, x) * 0.08, 0.5, 0.26 + hash2(y, i) * 0.12, SRGB));
    });
    for (const m of [trunks, leaves]) { m.castShadow = true; m.receiveShadow = true; }
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(6, 0), std(0x8b8780, { roughness: 1, flatShading: true }), Math.max(1, rockPts.length));
    rockPts.forEach(([x, h, y, s], i) => {
      q.setFromEuler(new THREE.Euler(hash2(i, 1) * 3, hash2(i, 2) * 3, 0));
      m4.compose(tmpV2.set(x, h, y), q, sc.set(s * 1.3, s * 0.8, s));
      rocks.setMatrixAt(i, m4);
    });
    rocks.count = rockPts.length;
    rocks.castShadow = true;
    this.trees = trunks; this.leaves = leaves; this.rocks = rocks;
    this.scene.add(trunks, leaves, rocks);

    // 지도 경계 (반투명 붉은 벽)
    const border = new THREE.Group();
    const wallMat = new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const wall = (w, x, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 260), wallMat); m.position.set(x, 100, z); m.rotation.y = ry; border.add(m); };
    wall(S.MAP_W, S.MAP_W / 2, 0, 0); wall(S.MAP_W, S.MAP_W / 2, S.MAP_H, 0);
    wall(S.MAP_H, 0, S.MAP_H / 2, Math.PI / 2); wall(S.MAP_H, S.MAP_W, S.MAP_H / 2, Math.PI / 2);
    this.border = border;
    this.scene.add(border);
  }

  heightAt(x, y) {
    if (!this.heights) return 0;
    const C = S.COLS, fx = clamp(x / S.TILE, 0, C - 0.001), fy = clamp(y / S.TILE, 0, S.ROWS - 0.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, W = C + 1, H = this.heights;
    const a = H[j * W + i], b = H[j * W + i + 1], c = H[(j + 1) * W + i], d = H[(j + 1) * W + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }
  groundY(x, y) { return Math.max(0, this.heightAt(x, y)); }

  // ---------- 효과 ----------
  effect(x, y, s, players) {
    // 공중 폭발인지 판단: 근처에 전투기가 있으면 그 고도에서 터진다
    let h = this.groundY(x, y);
    for (const p of players || []) if (p.v === 'jet' && Math.hypot(p.x - x, p.y - y) < 60) { h = JET_ALT; break; }
    const onWater = h < 1 && !S.isLand(this.grid, x, y);
    if (!s) {
      this.fire.spawn({ x, y: h + 6, z: y, life: 0.18, s0: 10, s1: 4, r: 1, g: 0.85, b: 0.4, a: 1 });
      for (let i = 0; i < 3; i++) this.fire.spawn({ x, y: h + 6, z: y, vx: (Math.random() - 0.5) * 120, vy: Math.random() * 80, vz: (Math.random() - 0.5) * 120, life: 0.3, s0: 3, s1: 1, r: 1, g: 0.7, b: 0.3, a: 1, grav: 200 });
      return;
    }
    const big = s >= 80;
    if (onWater && h < 1) {
      // 물기둥
      for (let i = 0; i < (big ? 40 : 22); i++) {
        this.smoke.spawn({ x: x + (Math.random() - 0.5) * s * 0.4, y: 2, z: y + (Math.random() - 0.5) * s * 0.4, vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * s * 2.2, vz: (Math.random() - 0.5) * 40, life: 1.2 + Math.random() * 0.6, s0: 6, s1: 16, r: 0.92, g: 0.96, b: 1, a: 0.85, grav: 140 });
      }
    }
    this.fire.spawn({ x, y: h + 8, z: y, life: 0.35, s0: s * 0.6, s1: s * 1.4, r: 1, g: 0.75, b: 0.35, a: 1 });
    for (let i = 0; i < (big ? 26 : 12); i++) {
      const sp = s * 1.6;
      this.fire.spawn({ x, y: h + 8, z: y, vx: (Math.random() - 0.5) * sp, vy: Math.random() * sp * 0.7, vz: (Math.random() - 0.5) * sp, life: 0.4 + Math.random() * 0.4, s0: s * 0.35, s1: s * 0.1, r: 1, g: 0.45 + Math.random() * 0.3, b: 0.15, a: 0.9, drag: 2.5 });
    }
    for (let i = 0; i < (big ? 18 : 8); i++) {
      const sp = s * 0.7;
      const g = 0.18 + Math.random() * 0.15;
      this.smoke.spawn({ x, y: h + 8, z: y, vx: (Math.random() - 0.5) * sp, vy: 15 + Math.random() * 30, vz: (Math.random() - 0.5) * sp, life: 1.6 + Math.random() * 1.4, s0: s * 0.4, s1: s * 1.3, r: g, g, b: g, a: 0.7, drag: 1.2 });
    }
    if (big) for (let i = 0; i < 14; i++) {
      this.smoke.spawn({ x, y: h + 10, z: y, vx: (Math.random() - 0.5) * 220, vy: 80 + Math.random() * 140, vz: (Math.random() - 0.5) * 220, life: 1.2, s0: 3, s1: 2, r: 0.1, g: 0.1, b: 0.1, a: 1, grav: 260 });
    }
  }

  // ---------- 매 프레임 ----------
  removeVehicle(id) {
    const v = this.vehicles.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    v.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.vehicles.delete(id);
  }

  syncVehicles(players, dt, colorFor) {
    const seen = new Set();
    for (const p of players) {
      if (!p.a || !p.v) continue;
      seen.add(p.id);
      let v = this.vehicles.get(p.id);
      const color = colorFor(p.id);
      if (!v || v.vt !== p.v || v.color !== color) {
        this.removeVehicle(p.id);
        const group = BUILDERS[p.v](color);
        group.rotation.order = 'YZX';
        const shield = new THREE.Mesh(new THREE.SphereGeometry(S.VEHICLES[p.v].radius * 1.9, 20, 14), new THREE.MeshBasicMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.14, depthWrite: false }));
        group.add(shield);
        group.userData.shield = shield;
        this.scene.add(group);
        v = { group, vt: p.v, color, bank: 0, lastAn: p.an };
        this.vehicles.set(p.id, v);
      }
      const g = v.group;
      const turnRate = angleDiff(v.lastAn, p.an) / Math.max(dt, 1e-3);
      v.lastAn = p.an;
      g.rotation.y = -p.an;
      if (p.v === 'tank') {
        const hF = this.heightAt(p.x + Math.cos(p.an) * 18, p.y + Math.sin(p.an) * 18);
        const hB = this.heightAt(p.x - Math.cos(p.an) * 18, p.y - Math.sin(p.an) * 18);
        g.position.set(p.x, Math.max(this.heightAt(p.x, p.y), (hF + hB) / 2), p.y);
        g.rotation.z = Math.atan2(hF - hB, 36);
        g.rotation.x = 0;
        if (Math.abs(p.sp) > 40 && Math.random() < dt * 14) {
          this.smoke.spawn({ x: p.x - Math.cos(p.an) * 20, y: g.position.y + 3, z: p.y - Math.sin(p.an) * 20, vy: 8, life: 1.4, s0: 8, s1: 22, r: 0.62, g: 0.55, b: 0.42, a: 0.4, drag: 1 });
        }
      } else if (p.v === 'ship') {
        g.position.set(p.x, Math.sin(this.time * 1.4 + p.id) * 0.7, p.y);
        g.rotation.x = Math.sin(this.time * 0.9 + p.id) * 0.03;
        g.rotation.z = Math.sin(this.time * 1.1 + p.id * 2) * 0.015;
        if (Math.abs(p.sp) > 8) {
          const sp = Math.abs(p.sp) / 95;
          if (Math.random() < dt * 40 * sp) for (const side of [-1, 1]) {
            const bx = p.x + Math.cos(p.an) * 40, by = p.y + Math.sin(p.an) * 40;
            this.smoke.spawn({ x: bx, y: 1.5, z: by, vx: Math.cos(p.an + side * 1.9) * 25, vz: Math.sin(p.an + side * 1.9) * 25, life: 2.2, s0: 5, s1: 18, r: 0.95, g: 0.98, b: 1, a: 0.6 * sp, drag: 0.4 });
          }
          if (Math.random() < dt * 30 * sp) this.smoke.spawn({ x: p.x - Math.cos(p.an) * 44, y: 1.2, z: p.y - Math.sin(p.an) * 44, life: 3, s0: 10, s1: 34, r: 0.95, g: 0.98, b: 1, a: 0.5 * sp, drag: 0.5 });
        }
        if (Math.random() < dt * 6) {
          tmpV.copy(g.userData.funnelTop); g.localToWorld(tmpV);
          this.smoke.spawn({ x: tmpV.x, y: tmpV.y, z: tmpV.z, vx: -6, vy: 14, life: 2.4, s0: 5, s1: 18, r: 0.3, g: 0.3, b: 0.32, a: 0.45, drag: 0.5 });
        }
      } else {
        v.bank += (clamp(turnRate * 0.45, -1.1, 1.1) - v.bank) * Math.min(1, dt * 6);
        g.position.set(p.x, JET_ALT + Math.sin(this.time * 2 + p.id) * 1.5, p.y);
        g.rotation.x = v.bank;
        g.rotation.z = 0;
        const thr = clamp((p.sp - 170) / 210, 0, 1);
        g.userData.flame.scale.set(0.6 + thr * 0.9, 0.7 + thr * 0.6 + Math.random() * 0.2, 0.7 + thr * 0.6);
        for (const side of [-1, 1]) {
          tmpV.set(-10, 0, side * 20); g.localToWorld(tmpV);
          this.smoke.spawn({ x: tmpV.x, y: tmpV.y, z: tmpV.z, life: 0.9, s0: 1.5, s1: 4, r: 1, g: 1, b: 1, a: 0.35 });
        }
      }
      for (const t of g.userData.turrets) t.rotation.y = -angleDiff(p.an, p.tu);
      g.userData.shield.visible = !!p.sh;
      // 크게 부서진 기체는 연기를 뿜는다
      if (p.hp / S.VEHICLES[p.v].hp < 0.35 && Math.random() < dt * 18) {
        this.smoke.spawn({ x: g.position.x, y: g.position.y + 12, z: g.position.z, vy: 20, life: 1.8, s0: 6, s1: 22, r: 0.12, g: 0.12, b: 0.12, a: 0.6, drag: 0.6 });
        if (Math.random() < 0.4) this.fire.spawn({ x: g.position.x, y: g.position.y + 10, z: g.position.z, vy: 10, life: 0.4, s0: 6, s1: 2, r: 1, g: 0.5, b: 0.15, a: 0.9 });
      }
    }
    for (const id of [...this.vehicles.keys()]) if (!seen.has(id)) this.removeVehicle(id);
  }

  bulletHeight(b, vt, w, traveled) {
    const def = S.VEHICLES[vt].weapons[w];
    if (vt === 'jet') return Math.max(this.groundY(b.x, b.y) + 4, b.y0 - traveled * 0.07);
    if (def.hits.includes('air')) return Math.min(JET_ALT, b.y0 + traveled * 0.22);
    // 포탄: 포물선
    const range = def.speed * def.life;
    const t = clamp(traveled / range, 0, 1);
    return b.y0 + Math.sin(Math.PI * t) * range * (vt === 'ship' ? 0.12 : 0.05) - t * (b.y0 - 2);
  }

  syncBullets(bullets) {
    const seen = new Set();
    for (const [id, x, y, a, vt, w] of bullets) {
      seen.add(id);
      let b = this.bullets.get(id);
      const def = S.VEHICLES[vt].weapons[w];
      if (!b) {
        const kind = def.homing ? 'missile' : def.splash ? 'shell' : 'tracer';
        const m = this.bulletPool[kind].pop() || new THREE.Mesh(this.bulletGeo[kind], this.bulletMat[kind]);
        this.scene.add(m);
        const y0 = vt === 'jet' ? JET_ALT : vt === 'tank' ? this.groundY(x, y) + 17 : 12;
        b = { mesh: m, kind, sx: x, sy: y, y0, x, y };
        this.bullets.set(id, b);
        // 포구 화염
        if (kind !== 'tracer' || Math.random() < 0.3) {
          this.fire.spawn({ x, y: y0, z: y, life: 0.12, s0: kind === 'tracer' ? 6 : 22, s1: 4, r: 1, g: 0.8, b: 0.4, a: 1 });
          if (kind === 'shell') for (let i = 0; i < 4; i++) this.smoke.spawn({ x, y: y0, z: y, vx: Math.cos(a) * 30 + (Math.random() - 0.5) * 20, vy: 6, vz: Math.sin(a) * 30 + (Math.random() - 0.5) * 20, life: 1, s0: 6, s1: 16, r: 0.6, g: 0.6, b: 0.6, a: 0.5, drag: 1.5 });
        }
      }
      b.x = x; b.y = y;
      const traveled = Math.hypot(x - b.sx, y - b.sy);
      const h = this.bulletHeight(b, vt, w, traveled);
      b.mesh.position.set(x, h, y);
      b.mesh.rotation.set(0, -a, 0);
      if (b.kind === 'missile') this.smoke.spawn({ x: x - Math.cos(a) * 6, y: h, z: y - Math.sin(a) * 6, life: 1.1, s0: 3, s1: 9, r: 0.85, g: 0.85, b: 0.85, a: 0.55 });
      if (b.kind === 'missile') this.fire.spawn({ x: x - Math.cos(a) * 6, y: h, z: y - Math.sin(a) * 6, life: 0.08, s0: 6, s1: 2, r: 1, g: 0.6, b: 0.2, a: 1 });
    }
    for (const [id, b] of this.bullets) if (!seen.has(id)) {
      this.scene.remove(b.mesh);
      this.bulletPool[b.kind].push(b.mesh);
      this.bullets.delete(id);
    }
  }

  syncLabels(players, myId) {
    const seen = new Set();
    const w = window.innerWidth, h = window.innerHeight;
    for (const p of players) {
      if (!p.a || !p.v) continue;
      const g = this.vehicles.get(p.id)?.group;
      if (!g) continue;
      tmpV.copy(g.position); tmpV.y += p.v === 'ship' ? 46 : p.v === 'jet' ? 22 : 34;
      const d = tmpV.distanceTo(this.camera.position);
      tmpV.project(this.camera);
      if (tmpV.z > 1 || d > 2600) continue;
      seen.add(p.id);
      let el = this.labels.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lbl';
        el.innerHTML = '<span></span><div class="bar"><i></i></div>';
        this.labelRoot.appendChild(el);
        this.labels.set(p.id, el);
      }
      el.firstChild.textContent = p.n;
      el.classList.toggle('me', p.id === myId);
      const ratio = p.hp / S.VEHICLES[p.v].hp;
      const bar = el.lastChild.firstChild;
      bar.style.width = `${ratio * 100}%`;
      bar.style.background = ratio > 0.35 ? '#3ecf6a' : '#e05a4f';
      el.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * w}px, ${(-tmpV.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
      el.style.opacity = d > 1800 ? String(1 - (d - 1800) / 800) : '1';
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
  }

  updateCamera(me, dt) {
    const cam = this.camera;
    const k = 1 - Math.exp(-dt * 6);
    if (me && me.a && me.v) {
      const g = this.vehicles.get(me.id)?.group;
      const base = g ? g.position : tmpV.set(me.x, 0, me.y);
      const fx = Math.cos(me.an), fz = Math.sin(me.an);
      let dist, height, look;
      if (this.camMode === 'top') { dist = 380; height = 720; look = 0; }
      else if (me.v === 'tank') { dist = 115; height = 52; look = 70; }
      else if (me.v === 'ship') { dist = 175; height = 88; look = 90; }
      else { dist = 150; height = 42; look = 120; }
      const desired = tmpV2.set(base.x - fx * dist, base.y + height, base.z - fz * dist);
      if (this.camMode === 'top') desired.set(base.x, base.y + height, base.z + dist);
      const ground = this.groundY(desired.x, desired.z) + 12;
      if (desired.y < ground) desired.y = ground;
      const lookAt = tmpV.set(base.x + fx * look, base.y + (me.v === 'jet' ? 8 : 14), base.z + fz * look);
      // 출격 직후처럼 멀리 떨어져 있으면 바로 이동
      if (cam.position.distanceTo(desired) > 900) { cam.position.copy(desired); this.camTarget.copy(lookAt); }
      cam.position.lerp(desired, k);
      this.camTarget.lerp(lookAt, Math.min(1, k * 1.5));
      cam.lookAt(this.camTarget);
    } else {
      // 관전: 천천히 선회
      const t = this.time * 0.05;
      const cx = this.lastFocus ? this.lastFocus.x : S.MAP_W / 2, cz = this.lastFocus ? this.lastFocus.z : S.MAP_H / 2;
      cam.position.lerp(tmpV2.set(cx + Math.cos(t) * 700, 420, cz + Math.sin(t) * 700), k * 0.5);
      this.camTarget.lerp(tmpV.set(cx, 0, cz), k);
      cam.lookAt(this.camTarget);
    }
    if (me && me.a) this.lastFocus = { x: me.x, z: me.y };
    // 그림자 영역과 하늘을 카메라 주변으로 이동
    const focus = this.camTarget;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 1500);
    this.sky.position.copy(cam.position);
  }

  updateAim(me) {
    const show = me && me.a && me.v;
    this.aimLine.visible = this.aimRing.visible = !!show;
    if (!show) return;
    const g = this.vehicles.get(me.id)?.group;
    if (!g) return;
    const w = S.VEHICLES[me.v].weapons[0];
    const dir = me.v === 'jet' ? me.an : me.tu;
    const range = me.v === 'jet' ? 320 : Math.min(700, w.speed * w.life);
    const ex = me.x + Math.cos(dir) * range, ez = me.y + Math.sin(dir) * range;
    const y0 = me.v === 'jet' ? JET_ALT : g.position.y + (me.v === 'tank' ? 17 : 12);
    const ey = me.v === 'jet' ? JET_ALT : this.groundY(ex, ez) + 1.5;
    const p = this.aimLine.geometry.attributes.position;
    p.setXYZ(0, me.x, y0, me.y); p.setXYZ(1, ex, ey, ez); p.needsUpdate = true;
    this.aimLine.computeLineDistances();
    this.aimRing.position.set(ex, ey, ez);
    if (me.v === 'jet') this.aimRing.quaternion.copy(this.camera.quaternion);
    else this.aimRing.rotation.set(-Math.PI / 2, 0, 0);
  }

  render(players, bullets, dt, myId, colorFor) {
    this.time += dt;
    this.waterTex.offset.x = this.time * 0.012;
    this.waterTex.offset.y = this.time * 0.007;
    const me = players.find((p) => p.id === myId);
    this.syncVehicles(players, dt, colorFor);
    this.syncBullets(bullets);
    this.updateCamera(me, dt);
    this.updateAim(me);
    this.fire.update(dt);
    this.smoke.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.syncLabels(players, myId);
  }

  // 로비 배경: 플레이어 없이 지도 위를 선회
  renderIdle(dt) {
    this.time += dt;
    this.waterTex.offset.x = this.time * 0.012;
    this.aimLine.visible = this.aimRing.visible = false;
    this.updateCamera(null, dt);
    this.fire.update(dt);
    this.smoke.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  clearLabels() { for (const el of this.labels.values()) el.remove(); this.labels.clear(); }
}
