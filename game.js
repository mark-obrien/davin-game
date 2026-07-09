'use strict';

/* ============================================================
   TURBO RUSH 3D — an endless highway driving game
   Built with three.js (lib/three.min.js). No build step needed.

   Sections:
     1. Tunable constants          6. NPC traffic (the "AI")
     2. Game state                 7. Crash particles
     3. Renderer / scene / lights  8. Audio (engine + sfx)
     4. World (road, trees...)     9. Input
     5. Car factory               10. Game flow + main loop
   ============================================================ */

/* ---------------- 1. Tunable constants ---------------- */

const LANE_W = 3.6;            // metres, like a real highway lane
const LANES = 3;               // lanes per driving direction
const MEDIAN_HALF = 0.6;       // half-width of the central barrier strip
const ROAD_HALF = MEDIAN_HALF + LANES * LANE_W + 0.9;  // paved half-width
const ROAD_LEN = 420;          // how much road we keep around the player

const START_SPEED = 25;        // m/s  (= 90 km/h)
const MAX_SPEED = 64;          // m/s  (= 230 km/h)
const SPEED_RAMP = 0.45;       // m/s gained every second — the difficulty
const BOOST_MULT = 1.3;        // holding ↑
const BRAKE_MULT = 0.5;        // holding ↓

const STEER_ACCEL = 42;        // sideways acceleration, m/s²
const STEER_MAX = 13;          // max sideways speed, m/s

const PLAYER_HALF_W = 0.95;    // collision half-extents of the player car
const PLAYER_HALF_L = 2.25;

const SPAWN_Z = -300;          // NPCs appear here, hidden inside the fog
const NPC_COLORS = [0x3f7fbf, 0x8464c9, 0x3da776, 0xd8a13c, 0xb8443f,
                    0x8b939e, 0xe8e6e0, 0x2e3440, 0x7a5230];

// x position of a lane centre on the player's side of the road
const laneX = (i) => MEDIAN_HALF + LANE_W * (i + 0.5);

/* ---------------- 2. Game state ---------------- */

const STATE = { LOADING: 0, MENU: 1, PLAYING: 2, PAUSED: 3, OVER: 4 };
let state = STATE.LOADING;

let elapsed = 0;               // seconds since the run started
let distance = 0;              // metres driven
let bonus = 0;                 // points from near misses
let score = 0;
let best = Number(localStorage.getItem('turboRush3dBest') || 0);
let targetSpeed = START_SPEED; // what the difficulty ramp wants
let curSpeed = 0;              // what the car is actually doing
let shake = 0;                 // camera shake time left
let crashAnim = null;          // player tumble animation during a crash

const player = { x: laneX(1), latVel: 0, group: null };
let npcs = [];                 // active NPC cars
const npcPool = { sedan: [], truck: [] };  // recycled car models

/* ---------------- DOM handles ---------------- */

const $ = (id) => document.getElementById(id);
const ui = {
  hud: $('hud'), score: $('score'), speed: $('speed'), bestEl: $('best'),
  toast: $('toast'), loading: $('loading'), loadfill: $('loadfill'),
  loadstep: $('loadstep'), menu: $('menu'), gameover: $('gameover'),
  paused: $('paused'), finalScore: $('finalScore'), newBest: $('newBest'),
};

/* ---------------- 3. Renderer, scene, camera, lights ---------------- */

let renderer, scene, camera, sun;
const SKY = 0x9ec8ef;

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic colors
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;     // soft sun shadows
  document.body.prepend(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 70, 280);   // hides where NPCs spawn

  camera = new THREE.PerspectiveCamera(
    62, window.innerWidth / window.innerHeight, 0.1, 600);
  camera.position.set(0, 4.4, 8.5);

  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a5f2f, 0.65);
  scene.add(hemi);

  sun = new THREE.DirectionalLight(0xfff2d9, 1.35);
  sun.position.set(35, 55, -25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  sun.target.position.set(0, 0, -25);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/* ---------------- 4. The world ---------------- */

const props = [];   // everything that scrolls past and gets recycled

function addProp(obj) {
  props.push({ obj });
  scene.add(obj);
}

// The road surface is a canvas we paint once (asphalt noise + lane
// markings) and tile along the highway.
function makeRoadTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256;                 // 256 px  ↔  road width (24.6 m)
  cv.height = 480;                // 480 px  ↔  45 m of road length
  const c = cv.getContext('2d');
  const pxX = cv.width / (ROAD_HALF * 2);
  const xpx = (m) => (m + ROAD_HALF) * pxX;

  c.fillStyle = '#2e3237';
  c.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 5000; i++) {   // asphalt grain
    c.fillStyle = Math.random() < 0.5
      ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)';
    c.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
  }

  // double yellow centre line
  c.fillStyle = '#d9a441';
  c.fillRect(xpx(-0.32), 0, 2.5, cv.height);
  c.fillRect(xpx(0.18), 0, 2.5, cv.height);

  // solid white edge lines
  c.fillStyle = '#d7dbe0';
  const edge = MEDIAN_HALF + LANES * LANE_W + 0.15;
  c.fillRect(xpx(-edge), 0, 3, cv.height);
  c.fillRect(xpx(edge) - 3, 0, 3, cv.height);

  // dashed lane dividers: 3 m dash every 7.5 m (6 cycles fit exactly)
  c.fillStyle = 'rgba(215,219,224,0.9)';
  for (let l = 1; l < LANES; l++) {
    for (const s of [-1, 1]) {
      const x = xpx(s * (MEDIAN_HALF + LANE_W * l)) - 1.5;
      for (let y = 0; y < cv.height; y += 80) c.fillRect(x, y, 3, 32);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_LEN / 45);
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

let roadTex;

function initWorld() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  roadTex = makeRoadTexture();
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.93 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.02, -ROAD_LEN / 2 + 60);
  road.receiveShadow = true;
  scene.add(road);

  // concrete median barrier
  const median = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.85, ROAD_LEN),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.9 }));
  median.position.set(0, 0.43, -ROAD_LEN / 2 + 60);
  median.castShadow = true;
  median.receiveShadow = true;
  scene.add(median);

  // metal guardrails along both shoulders
  const railMat = new THREE.MeshStandardMaterial(
    { color: 0xb9c0c7, metalness: 0.65, roughness: 0.4 });
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.32, ROAD_LEN), railMat);
    rail.position.set(s * (ROAD_HALF + 0.35), 0.75, -ROAD_LEN / 2 + 60);
    scene.add(rail);
  }

  // recycled scenery: guardrail posts, median reflectors, trees, clouds
  const postGeo = new THREE.BoxGeometry(0.12, 0.75, 0.12);
  for (const s of [-1, 1]) {
    for (let z = 55; z > 55 - ROAD_LEN; z -= 12) {
      const post = new THREE.Mesh(postGeo, railMat);
      post.position.set(s * (ROAD_HALF + 0.35), 0.38, z);
      addProp(post, true);
    }
  }

  const reflGeo = new THREE.BoxGeometry(0.1, 0.08, 0.04);
  const reflMat = new THREE.MeshStandardMaterial(
    { color: 0xffd166, emissive: 0xffb703, emissiveIntensity: 1.4 });
  for (let z = 55; z > 55 - ROAD_LEN; z -= 15) {
    const r = new THREE.Mesh(reflGeo, reflMat);
    r.position.set(0, 0.9, z);
    addProp(r, true);
  }

  makeForest();
  makeClouds();
}

function makeForest() {
  const trunkMat = new THREE.MeshStandardMaterial(
    { color: 0x6b4a2f, roughness: 1 });
  const pineMat = new THREE.MeshStandardMaterial(
    { color: 0x2f6b33, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial(
    { color: 0x48883b, roughness: 1 });
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.2, 6);
  const coneGeo = new THREE.ConeGeometry(1.1, 2.2, 7);
  const blobGeo = new THREE.IcosahedronGeometry(1.1, 0);

  for (let i = 0; i < 46; i++) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.6;
    tree.add(trunk);
    if (Math.random() < 0.6) {          // pine
      const c1 = new THREE.Mesh(coneGeo, pineMat);
      c1.position.y = 2.1;
      const c2 = new THREE.Mesh(coneGeo, pineMat);
      c2.scale.setScalar(0.7);
      c2.position.y = 3.3;
      tree.add(c1, c2);
    } else {                            // leafy
      const blob = new THREE.Mesh(blobGeo, leafMat);
      blob.position.y = 2.0;
      blob.scale.set(1.2, 1.4, 1.2);
      tree.add(blob);
    }
    tree.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const s = 0.8 + Math.random() * 1.1;
    tree.scale.setScalar(s);
    placeTree(tree, Math.random() * -ROAD_LEN + 55);
    addProp(tree, true);
  }
}

function placeTree(tree, z) {
  const side = Math.random() < 0.5 ? -1 : 1;
  tree.position.set(
    side * (ROAD_HALF + 3.5 + Math.random() * 33), 0, z);
  tree.rotation.y = Math.random() * Math.PI * 2;
}

function makeClouds() {
  const mat = new THREE.MeshBasicMaterial(
    { color: 0xffffff, transparent: true, opacity: 0.85 });
  const geo = new THREE.SphereGeometry(1, 10, 8);
  for (let i = 0; i < 6; i++) {
    const cloud = new THREE.Group();
    for (let p = 0; p < 3; p++) {
      const puff = new THREE.Mesh(geo, mat);
      puff.position.set(p * 5 - 5 + Math.random() * 2, Math.random(), 0);
      puff.scale.set(4 + Math.random() * 3, 1.6 + Math.random(), 3);
      cloud.add(puff);
    }
    cloud.position.set((Math.random() - 0.5) * 220,
      42 + Math.random() * 22, Math.random() * -ROAD_LEN + 55);
    cloud.userData.parallax = 0.12;   // clouds scroll slower = far away
    addProp(cloud, true);
  }
}

// Scroll every prop toward the camera and loop it back when it passes.
function scrollWorld(dz) {
  roadTex.offset.y += dz / 45;
  for (const p of props) {
    p.obj.position.z += dz * (p.obj.userData.parallax || 1);
    if (p.obj.position.z > 58) {
      p.obj.position.z -= ROAD_LEN;
      if (p.obj.children.length && p.obj.userData.parallax === undefined) {
        placeTree(p.obj, p.obj.position.z);  // re-randomise trees only
      }
    }
  }
}

/* ---------------- 5. Car factory ---------------- */

// Shared geometry/materials (created once, reused by every car).
const carShared = {};

function initCarShared() {
  carShared.glass = new THREE.MeshStandardMaterial(
    { color: 0x0e1a26, metalness: 0.9, roughness: 0.12 });
  carShared.dark = new THREE.MeshStandardMaterial(
    { color: 0x22262b, roughness: 0.7 });
  carShared.tire = new THREE.MeshStandardMaterial(
    { color: 0x14161a, roughness: 0.95 });
  carShared.hub = new THREE.MeshStandardMaterial(
    { color: 0x9aa3ad, metalness: 0.8, roughness: 0.35 });
  carShared.headlight = new THREE.MeshStandardMaterial(
    { color: 0xffffff, emissive: 0xfff6cc, emissiveIntensity: 1.6 });
  carShared.taillight = new THREE.MeshStandardMaterial(
    { color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.4 });
  carShared.blinker = new THREE.MeshStandardMaterial(
    { color: 0xff9500, emissive: 0xff8800, emissiveIntensity: 2.2 });
  carShared.cargo = new THREE.MeshStandardMaterial(
    { color: 0xd6dade, roughness: 0.6 });

  carShared.tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 18);
  carShared.truckTireGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18);
  carShared.spokeGeo = new THREE.BoxGeometry(0.1, 0.5, 0.1);
  carShared.lightGeo = new THREE.BoxGeometry(0.34, 0.12, 0.07);
  carShared.blinkGeo = new THREE.BoxGeometry(0.08, 0.1, 0.22);
}

function makeWheel(x, y, z, truck) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(
    truck ? carShared.truckTireGeo : carShared.tireGeo, carShared.tire);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const spoke = new THREE.Mesh(carShared.spokeGeo, carShared.hub);
  spoke.scale.setScalar(truck ? 1.2 : 1);
  g.add(tire, spoke);
  g.position.set(x, y, z);
  return g;
}

// Every car faces -z (the direction the player drives).
function buildCar(kind) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial(
    { color: 0xffffff, metalness: 0.75, roughness: 0.32 });
  const wheels = [];
  const blinkL = [], blinkR = [];
  let halfW, halfL;

  const addLights = (len) => {
    for (const s of [-1, 1]) {
      const head = new THREE.Mesh(carShared.lightGeo, carShared.headlight);
      head.position.set(s * 0.6, 0.72, -len / 2 + 0.03);
      const tail = new THREE.Mesh(carShared.lightGeo, carShared.taillight);
      tail.position.set(s * 0.6, 0.72, len / 2 - 0.03);
      g.add(head, tail);
      for (const zEnd of [-len / 2 + 0.35, len / 2 - 0.35]) {
        const b = new THREE.Mesh(carShared.blinkGeo, carShared.blinker);
        b.position.set(s * (halfW - 0.02), 0.7, zEnd);
        b.visible = false;
        (s < 0 ? blinkL : blinkR).push(b);
        g.add(b);
      }
    }
  };

  if (kind === 'truck') {
    halfW = 1.15; halfL = 3.5;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 1.9), paint);
    cab.position.set(0, 1.1, -2.4);
    const shield = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.6, 0.1), carShared.glass);
    shield.position.set(0, 1.45, -3.3);
    const cargo = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 2.3, 4.6), carShared.cargo);
    cargo.position.set(0, 1.5, 0.9);
    g.add(cab, shield, cargo);
    for (const z of [-2.3, 1.4, 2.6]) {
      wheels.push(makeWheel(-1.0, 0.42, z, true),
                  makeWheel(1.0, 0.42, z, true));
    }
    addLights(7);
  } else {
    halfW = 0.95; halfL = 2.25;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.55, 4.4), paint);
    body.position.y = 0.55;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.52, 2.1), carShared.glass);
    cabin.position.set(0, 1.06, 0.15);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.07, 1.25), paint);
    roof.position.set(0, 1.33, 0.15);
    const bumperF = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.28, 0.3), carShared.dark);
    bumperF.position.set(0, 0.4, -2.2);
    const bumperR = bumperF.clone();
    bumperR.position.z = 2.2;
    g.add(body, cabin, roof, bumperF, bumperR);
    wheels.push(makeWheel(-0.84, 0.34, -1.4), makeWheel(0.84, 0.34, -1.4),
                makeWheel(-0.84, 0.34, 1.4), makeWheel(0.84, 0.34, 1.4));
    addLights(4.4);
  }

  for (const w of wheels) g.add(w);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { paint, wheels, blinkL, blinkR, halfW, halfL, kind };
  return g;
}

function initPlayer() {
  player.group = buildCar('sedan');
  player.group.userData.paint.color.set(0xd42a1e);   // racing red
  // white racing stripe down the middle
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.02, 4.3),
    new THREE.MeshStandardMaterial({ color: 0xf5f0e6, roughness: 0.4 }));
  stripe.position.y = 0.84;
  player.group.add(stripe);
  player.group.position.set(player.x, 0, 0);
  scene.add(player.group);
}

/* ---------------- 6. NPC traffic ---------------- */

let sameTimer = 1.2;   // seconds until the next same-direction spawn
let oncTimer = 0.6;    // seconds until the next oncoming spawn

function getNpcCar(kind) {
  const pooled = npcPool[kind].pop();
  if (pooled) { pooled.visible = true; return pooled; }
  const g = buildCar(kind);
  scene.add(g);
  return g;
}

function spawnNpc(dir, lane) {
  const kind = Math.random() < 0.18 ? 'truck' : 'sedan';
  const g = getNpcCar(kind);
  g.userData.paint.color.set(
    NPC_COLORS[(Math.random() * NPC_COLORS.length) | 0]);
  g.rotation.set(0, dir === 1 ? Math.PI : 0, 0);

  const xSign = dir === -1 ? 1 : -1;
  // slow lane on the outside, fast lane next to the median — like real
  // life, but all clearly slower than you so you're always overtaking
  const laneSpeed = [19, 15.5, 12.5][lane] + Math.random() * 2.5;
  const n = {
    g, dir, kind, lane, targetLane: lane, xSign,
    x: xSign * laneX(lane),
    z: SPAWN_Z - (dir === 1 ? 20 : 0),
    speed: dir === 1 ? 18 + Math.random() * 10 : laneSpeed,
    halfW: g.userData.halfW, halfL: g.userData.halfL,
    blinkT: 0, changeCd: 4 + Math.random() * 8, passed: false,
  };
  npcs.push(n);
}

function trySpawnSame() {
  const openNear = [];   // room at the spawn point itself
  const openFar = [];    // lanes with no traffic anywhere in the approach
  for (let l = 0; l < LANES; l++) {
    const nearBlocked = npcs.some((n) => n.dir === -1 &&
      (n.lane === l || n.targetLane === l) && n.z < SPAWN_Z + 50);
    const farBlocked = npcs.some((n) => n.dir === -1 &&
      (n.lane === l || n.targetLane === l) && n.z < -100);
    if (!nearBlocked) openNear.push(l);
    if (!farBlocked) openFar.push(l);
  }
  // fairness rule: never fill the player's last open lane
  let candidates = openNear;
  if (openFar.length === 1) {
    candidates = openNear.filter((l) => l !== openFar[0]);
  }
  if (!candidates.length) return;
  spawnNpc(-1, candidates[(Math.random() * candidates.length) | 0]);
}

function trySpawnOncoming() {
  const lane = (Math.random() * LANES) | 0;
  const blocked = npcs.some((n) => n.dir === 1 && n.lane === lane &&
    Math.abs(n.z - (SPAWN_Z - 20)) < 55);
  if (!blocked) spawnNpc(1, lane);
}

function releaseNpc(n) {
  n.g.visible = false;
  for (const b of n.g.userData.blinkL) b.visible = false;
  for (const b of n.g.userData.blinkR) b.visible = false;
  npcPool[n.kind].push(n.g);
}

function updateNpcs(dt, playerSpeed, playing) {
  sameTimer -= dt;
  if (sameTimer <= 0) {
    trySpawnSame();
    sameTimer = Math.max(0.75, 2.2 - elapsed * 0.015) * (0.8 + Math.random() * 0.5);
  }
  oncTimer -= dt;
  if (oncTimer <= 0) {
    trySpawnOncoming();
    oncTimer = 1.3 + Math.random() * 1.4;
  }

  for (const n of npcs) {
    // keep a safe following distance from the car ahead (simple AI)
    for (const m of npcs) {
      if (m === n || m.dir !== n.dir) continue;
      if (m.lane !== n.lane && m.targetLane !== n.lane) continue;
      const gap = (n.dir === -1 ? n.z - m.z : m.z - n.z) - n.halfL - m.halfL;
      if (gap > 0 && gap < 14) {
        n.speed += (m.speed * 0.97 - n.speed) * Math.min(1, 2.5 * dt);
      }
    }

    // occasionally change lanes (same-direction cars only)
    n.changeCd -= dt;
    if (n.dir === -1 && n.targetLane === n.lane && n.changeCd <= 0) {
      n.changeCd = 5 + Math.random() * 9;
      const to = n.lane + (Math.random() < 0.5 ? -1 : 1);
      if (Math.random() < 0.55 && to >= 0 && to < LANES &&
          laneClearFor(n, to)) {
        n.targetLane = to;
        n.blinkT = 0;
      }
    }

    // slide toward the target lane, blinker flashing
    const tx = n.xSign * laneX(n.targetLane);
    if (n.targetLane !== n.lane) {
      n.blinkT += dt;
      const d = THREE.MathUtils.clamp(tx - n.x, -2.4 * dt, 2.4 * dt);
      n.x += d;
      const side = tx > n.x ? n.g.userData.blinkR : n.g.userData.blinkL;
      const other = tx > n.x ? n.g.userData.blinkL : n.g.userData.blinkR;
      const on = n.blinkT % 0.66 < 0.33;
      for (const b of side) b.visible = on;
      for (const b of other) b.visible = false;
      if (Math.abs(tx - n.x) < 0.04) {
        n.lane = n.targetLane;
        for (const b of n.g.userData.blinkL) b.visible = false;
        for (const b of n.g.userData.blinkR) b.visible = false;
      }
    }

    // Move relative to the player (the player never actually moves in z).
    // Same-direction cars close at (playerSpeed - their speed);
    // oncoming cars close at (playerSpeed + their speed).
    n.z += (playerSpeed + n.dir * n.speed) * dt;

    n.g.position.set(n.x, 0, n.z);
    // oncoming cars are rotated 180°, which flips their local x axis,
    // so the same spin direction works for both traffic directions
    const spin = (n.speed / 0.34) * dt;
    for (const w of n.g.userData.wheels) w.rotation.x -= spin;

    // near-miss bonus: they squeezed past you with < ~half a metre to spare
    if (playing && n.dir === -1 && !n.passed && n.z > 3) {
      n.passed = true;
      if (Math.abs(n.x - player.x) < n.halfW + PLAYER_HALF_W + 0.6) {
        bonus += 100;
        toast('NEAR MISS +100');
        sfxNearMiss();
      }
    }
  }

  npcs = npcs.filter((n) => {
    if (n.z > 45 || n.z < SPAWN_Z - 60) { releaseNpc(n); return false; }
    return true;
  });
}

function laneClearFor(n, lane) {
  return !npcs.some((m) => m !== n && m.dir === n.dir &&
    (m.lane === lane || m.targetLane === lane) &&
    Math.abs(m.z - n.z) < 20);
}

/* ---------------- 7. Crash particles ---------------- */

const particles = [];

function initParticles() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mats = [0xd42a1e, 0xff8c42, 0x22262b, 0xbfc5cc].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(geo, mats[i % mats.length]);
    m.visible = false;
    scene.add(m);
    particles.push({ m, vel: new THREE.Vector3(), spin: new THREE.Vector3(),
                     life: 0 });
  }
}

function explode(x, y, z) {
  for (const p of particles) {
    p.life = 1.1 + Math.random() * 0.6;
    p.maxLife = p.life;
    p.m.visible = true;
    p.m.position.set(x, y, z);
    const a = Math.random() * Math.PI * 2;
    const up = 3 + Math.random() * 9;
    const out = 2 + Math.random() * 10;
    p.vel.set(Math.cos(a) * out, up, Math.sin(a) * out - 4);
    p.spin.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
    p.m.scale.setScalar(0.1 + Math.random() * 0.22);
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    p.vel.y -= 22 * dt;
    p.m.position.addScaledVector(p.vel, dt);
    if (p.m.position.y < 0.08) { p.m.position.y = 0.08; p.vel.y *= -0.4; }
    p.m.rotation.x += p.spin.x * dt;
    p.m.rotation.y += p.spin.y * dt;
    p.m.scale.setScalar(Math.max(0.01, 0.25 * (p.life / p.maxLife)));
    if (p.life <= 0) p.m.visible = false;
  }
}

/* ---------------- 8. Audio ---------------- */

const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, master = null, engine = null, muted = false;

function ensureAudio() {
  if (!AC) return;
  if (!actx) {
    actx = new AC();
    master = actx.createGain();
    master.gain.value = 0.9;
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
}

function startEngine() {
  if (!actx || engine) return;
  const o1 = actx.createOscillator();
  o1.type = 'sawtooth';
  const o2 = actx.createOscillator();
  o2.type = 'square';
  const filt = actx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 420;
  filt.Q.value = 1.1;
  const g = actx.createGain();
  g.gain.value = 0;
  o1.connect(filt);
  o2.connect(filt);
  filt.connect(g);
  g.connect(master);
  o1.start();
  o2.start();
  engine = { o1, o2, g };
}

function stopEngine() {
  if (!engine) return;
  const e = engine;
  engine = null;
  e.g.gain.setTargetAtTime(0, actx.currentTime, 0.08);
  setTimeout(() => { e.o1.stop(); e.o2.stop(); }, 500);
}

function updateEngine(speed) {
  if (!engine) return;
  const t = actx.currentTime;
  const rpm = 46 + speed * 1.55;      // pitch follows your speed
  engine.o1.frequency.setTargetAtTime(rpm, t, 0.06);
  engine.o2.frequency.setTargetAtTime(rpm * 1.5 + 3, t, 0.06);
  engine.g.gain.setTargetAtTime(0.045 + Math.min(0.03, speed * 0.0005), t, 0.1);
}

function tone(freq, dur, type, vol, slide) {
  if (!actx) return;
  const t = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(
    Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol || 0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur);
}

const sfxNearMiss = () => tone(700, 0.16, 'triangle', 0.1, 600);
const sfxStart = () => tone(180, 0.5, 'sawtooth', 0.09, 320);

function sfxCrash() {
  if (!actx) return;
  const dur = 0.6;
  const buf = actx.createBuffer(1, actx.sampleRate * dur, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 1.6;
  }
  const src = actx.createBufferSource();
  src.buffer = buf;
  const g = actx.createGain();
  g.gain.value = 0.5;
  src.connect(g);
  g.connect(master);
  src.start();
}

/* ---------------- 9. Input ---------------- */

const keys = {};
const touch = { left: false, right: false };

function keyName(e) {
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': return 'left';
    case 'ArrowRight': case 'd': case 'D': return 'right';
    case 'ArrowUp': case 'w': case 'W': return 'up';
    case 'ArrowDown': case 's': case 'S': return 'down';
  }
  return null;
}

window.addEventListener('keydown', (e) => {
  ensureAudio();
  const k = keyName(e);
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.key === 'Enter' || e.key === ' ') {
    if (state === STATE.MENU) startGame();
    else if (state === STATE.OVER && ui.gameover.classList.contains('hidden') === false) startGame();
    e.preventDefault();
  }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
  if (e.key === 'm' || e.key === 'M') {
    muted = !muted;
    if (master) master.gain.value = muted ? 0 : 0.9;
    toast(muted ? 'MUTED' : 'SOUND ON');
  }
});

window.addEventListener('keyup', (e) => {
  const k = keyName(e);
  if (k) keys[k] = false;
});

window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  touch.left = touch.right = false;
});

// touch: hold the left / right half of the screen to steer
window.addEventListener('pointerdown', (e) => {
  ensureAudio();
  if (e.target.tagName === 'BUTTON') return;
  if (state !== STATE.PLAYING) return;
  if (e.clientX < window.innerWidth / 2) touch.left = true;
  else touch.right = true;
});
window.addEventListener('pointerup', () => {
  touch.left = touch.right = false;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === STATE.PLAYING) togglePause();
});

/* ---------------- 10. Game flow + main loop ---------------- */

let toastTimer = null;

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.style.opacity = 0; }, 900);
}

function resetRun(menuMode) {
  elapsed = 0;
  distance = 0;
  bonus = 0;
  score = 0;
  targetSpeed = START_SPEED;
  curSpeed = menuMode ? 22 : START_SPEED * 0.4;
  shake = 0;
  crashAnim = null;
  player.x = laneX(1);
  player.latVel = 0;
  player.group.position.set(player.x, 0, 0);
  player.group.rotation.set(0, 0, 0);
  player.group.visible = true;
  for (const n of npcs) releaseNpc(n);
  npcs = [];
  sameTimer = 1.2;
  oncTimer = 0.4;
  for (const p of particles) { p.life = 0; p.m.visible = false; }

  // seed the highway so there is traffic to overtake right away
  for (let i = 0; i < 5; i++) {
    spawnNpc(-1, (Math.random() * LANES) | 0);
    npcs[npcs.length - 1].z = -75 - i * 52 - Math.random() * 18;
  }
  for (let i = 0; i < 3; i++) {
    spawnNpc(1, (Math.random() * LANES) | 0);
    npcs[npcs.length - 1].z = -50 - i * 85 - Math.random() * 30;
  }
}

function startGame() {
  resetRun(false);
  state = STATE.PLAYING;
  ui.menu.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.bestEl.textContent = best;
  ensureAudio();
  startEngine();
  sfxStart();
}

function togglePause() {
  if (state === STATE.PLAYING) {
    state = STATE.PAUSED;
    ui.paused.classList.remove('hidden');
    if (engine && actx) engine.g.gain.setTargetAtTime(0.005, actx.currentTime, 0.05);
  } else if (state === STATE.PAUSED) {
    state = STATE.PLAYING;
    ui.paused.classList.add('hidden');
  }
}

function crash(n) {
  state = STATE.OVER;
  stopEngine();
  sfxCrash();
  shake = 1.0;
  explode((player.x + n.x) / 2, 0.9, (0 + n.z) / 2);
  crashAnim = { t: 0, vy: 6.5,
    spinX: (Math.random() - 0.5) * 7, spinZ: (Math.random() - 0.5) * 7 };
  if (score > best) {
    best = score;
    localStorage.setItem('turboRush3dBest', best);
    ui.newBest.classList.remove('hidden');
  } else {
    ui.newBest.classList.add('hidden');
  }
  ui.finalScore.textContent =
    `Score ${score} — you drove ${(distance / 1000).toFixed(2)} km`;
  setTimeout(() => {
    if (state === STATE.OVER) ui.gameover.classList.remove('hidden');
  }, 1100);
}

function updatePlayer(dt) {
  const left = keys.left || touch.left;
  const right = keys.right || touch.right;
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (dir) {
    player.latVel += dir * STEER_ACCEL * dt;
  } else {
    player.latVel -= player.latVel * Math.min(1, 10 * dt);
  }
  player.latVel = THREE.MathUtils.clamp(player.latVel, -STEER_MAX, STEER_MAX);
  player.x += player.latVel * dt;

  const minX = MEDIAN_HALF + PLAYER_HALF_W + 0.15;
  const maxX = ROAD_HALF - PLAYER_HALF_W - 0.15;
  if (player.x < minX) { player.x = minX; player.latVel = 0; }
  if (player.x > maxX) { player.x = maxX; player.latVel = 0; }

  player.group.position.x = player.x;
  player.group.rotation.y = -player.latVel * 0.014;   // nose into the turn
  player.group.rotation.z = player.latVel * 0.009;    // body roll
  const spin = (curSpeed / 0.34) * dt;
  for (const w of player.group.userData.wheels) w.rotation.x -= spin;
}

function checkCollisions() {
  for (const n of npcs) {
    if (Math.abs(n.z) > 8) continue;
    const hitW = (PLAYER_HALF_W + n.halfW) - 0.25;   // small forgiveness
    const hitL = (PLAYER_HALF_L + n.halfL) - 0.35;
    if (Math.abs(n.x - player.x) < hitW && Math.abs(n.z) < hitL) {
      crash(n);
      return;
    }
  }
}

function updateCamera(dt) {
  const targetX = player.x * 0.6;
  camera.position.x += (targetX - camera.position.x) * Math.min(1, 5 * dt);
  camera.position.y = 4.4;
  camera.position.z = 8.5;
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    camera.position.x += (Math.random() - 0.5) * shake * 0.7;
    camera.position.y += (Math.random() - 0.5) * shake * 0.5;
  }
  camera.lookAt(player.x * 0.85, 1.1, -14);
  const fov = 60 + Math.max(0, curSpeed - START_SPEED) * 0.28;
  if (Math.abs(camera.fov - fov) > 0.1) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state === STATE.MENU) {
    // attract mode: the world cruises along behind the menu
    curSpeed = 22;
    scrollWorld(curSpeed * dt);
    updateNpcs(dt, curSpeed, false);
    updateCamera(dt);
  } else if (state === STATE.PLAYING) {
    elapsed += dt;
    targetSpeed = Math.min(MAX_SPEED, START_SPEED + SPEED_RAMP * elapsed);
    const want = targetSpeed *
      (keys.up ? BOOST_MULT : keys.down ? BRAKE_MULT : 1);
    curSpeed += THREE.MathUtils.clamp(want - curSpeed, -38 * dt, 16 * dt);
    distance += curSpeed * dt;
    score = Math.floor(distance) + bonus;

    scrollWorld(curSpeed * dt);
    updatePlayer(dt);
    updateNpcs(dt, curSpeed, true);
    checkCollisions();
    updateEngine(curSpeed);
    updateCamera(dt);

    ui.score.textContent = score;
    ui.speed.textContent = `${Math.round(curSpeed * 3.6)} km/h`;
  } else if (state === STATE.OVER) {
    if (crashAnim) {
      // the car tumbles for a moment after impact
      crashAnim.t += dt;
      const g = player.group;
      g.position.y += crashAnim.vy * dt;
      crashAnim.vy -= 20 * dt;
      if (g.position.y < 0) { g.position.y = 0; crashAnim.vy *= -0.35; }
      g.rotation.x += crashAnim.spinX * dt;
      g.rotation.z += crashAnim.spinZ * dt;
      if (crashAnim.t > 1.4) crashAnim = null;
    }
    updateCamera(dt);
  }

  updateParticles(dt);
  renderer.render(scene, camera);
}

/* ---------------- Loading sequence ---------------- */

const LOAD_STEPS = [
  ['Igniting the engine…', initRenderer],
  ['Paving the highway…', initWorld],
  ['Building your car…', () => { initCarShared(); initPlayer(); }],
  ['Hiring NPC drivers…', () => {
    initParticles();
    resetRun(true);   // also seeds traffic for the menu's attract mode
  }],
  ['Final checks…', () => {
    ui.bestEl.textContent = best;
  }],
];

function runLoader(i) {
  if (i >= LOAD_STEPS.length) {
    ui.loadfill.style.width = '100%';
    setTimeout(() => {
      ui.loading.classList.add('hidden');
      ui.menu.classList.remove('hidden');
      state = STATE.MENU;
      frame();   // the render loop only starts once everything exists
    }, 350);
    return;
  }
  const [label, fn] = LOAD_STEPS[i];
  ui.loadstep.textContent = label;
  ui.loadfill.style.width = `${(i / LOAD_STEPS.length) * 100}%`;
  setTimeout(() => {
    try {
      fn();
    } catch (err) {
      ui.loadstep.textContent =
        'Sorry — your browser could not start WebGL (3D graphics).';
      throw err;
    }
    runLoader(i + 1);
  }, 220);
}

$('startBtn').addEventListener('click', () => { ensureAudio(); startGame(); });
$('restartBtn').addEventListener('click', () => { ensureAudio(); startGame(); });

runLoader(0);
