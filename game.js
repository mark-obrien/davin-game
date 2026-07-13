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

const BOOST_MULT = 1.3;        // holding ↑
const BRAKE_MULT = 0.5;        // holding ↓

// Difficulty presets — picked on the menu. Speeds are m/s.
const DIFFICULTIES = {
  easy: { label: 'EASY', startSpeed: 20, maxSpeed: 45, ramp: 0.3,
          spawnBase: 2.6, spawnMin: 1.0, copSpeed: 1.08, copBoost: 2,
          copEvery: 900, scoreMult: 0.7 },
  normal: { label: 'NORMAL', startSpeed: 25, maxSpeed: 64, ramp: 0.45,
            spawnBase: 2.2, spawnMin: 0.75, copSpeed: 1.12, copBoost: 3,
            copEvery: 500, scoreMult: 1 },
  hard: { label: 'HARD', startSpeed: 30, maxSpeed: 78, ramp: 0.65,
          spawnBase: 1.7, spawnMin: 0.55, copSpeed: 1.16, copBoost: 4,
          copEvery: 350, scoreMult: 1.4 },
};

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

const STATE = { LOADING: 0, MENU: 1, PLAYING: 2, PAUSED: 3, OVER: 4,
                TOWN: 5 };
let state = STATE.LOADING;

let elapsed = 0;               // seconds since the run started
let distance = 0;              // metres driven
let bonus = 0;                 // points from near misses
let score = 0;
let best = Number(localStorage.getItem('turboRush3dBest') || 0);
let difficulty = DIFFICULTIES.normal;
let targetSpeed = difficulty.startSpeed; // what the difficulty ramp wants
let curSpeed = 0;              // what the car is actually doing
let shake = 0;                 // camera shake time left
let crashFx = null;            // everything animating during a crash
let wanted = 0;                // ★ level — rises every time you escape
let oilCharges = 2;            // defensive oil slicks in stock
let shielded = false;          // one free hit from the shield power-up
let tiresBlown = 0;            // seconds of blown-tire handling left
let dayT = 0.06;               // position in the day/night cycle [0..1)
let pickupNext = 250;          // distance at which the next power-up spawns
let level = 1;                 // rises every 1500 m — traffic gets denser
let slowMoT = 0;               // seconds of slow-motion power-up left
let jamT = 0;                  // seconds of radar-jammer power-up left
let coins = 0;                 // coins grabbed this run (+25 score each)
let coinNext = 120;            // distance of the next coin row
let combo = 0;                 // consecutive near-misses
let comboT = -10;              // when the last near-miss happened
let rainbowHue = 0;            // boost-trail color cycling
let trailT = 0;
let paintName = 'red';         // the player's chosen paint job

const player = { x: laneX(1), latVel: 0, group: null };
let headlights = null;   // spotlight that comes on at night
let shieldMesh = null;   // glowing bubble while the shield is up

// Dev cheats for testing, e.g. index.html?wanted=2&copat=150&night=1
const DEV = new URLSearchParams(location.search);
if (DEV.has('night')) dayT = 0.5;
let npcs = [];                 // active NPC cars
const npcPool = { sedan: [], truck: [] };  // recycled car models

/* ---------------- DOM handles ---------------- */

const $ = (id) => document.getElementById(id);
const ui = {
  hud: $('hud'), score: $('score'), speed: $('speed'), bestEl: $('best'),
  toast: $('toast'), loading: $('loading'), loadfill: $('loadfill'),
  loadstep: $('loadstep'), menu: $('menu'), gameover: $('gameover'),
  paused: $('paused'), finalScore: $('finalScore'), newBest: $('newBest'),
  overTitle: $('overTitle'), wantedPanel: $('wantedPanel'),
  wanted: $('wanted'), oilBtn: $('oilBtn'), shieldTag: $('shieldTag'),
  mirror: $('mirror'), level: $('level'), fxTag: $('fxTag'),
  coins: $('coins'), rank: $('rank'), cheer: $('cheer'),
  hornBtn: $('hornBtn'), unlockHint: $('unlockHint'),
  townInput: $('townInput'), townStatus: $('townStatus'),
};

/* ---------------- 3. Renderer, scene, camera, lights ---------------- */

let renderer, scene, camera, sun, hemi, mirrorCam;
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
  // shadows are computed once per frame and shared with the mirror render
  renderer.shadowMap.autoUpdate = false;
  document.body.prepend(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 70, 280);   // hides where NPCs spawn

  camera = new THREE.PerspectiveCamera(
    62, window.innerWidth / window.innerHeight, 0.1, 600);
  camera.position.set(0, 4.4, 8.5);

  // the rear-view mirror is a second camera looking backwards
  mirrorCam = new THREE.PerspectiveCamera(50, 3.2, 0.4, 620);

  hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a5f2f, 0.65);
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
  // The sky is a dome mesh WITH fog enabled: it sits beyond the fog's
  // far distance, so it renders as 100% fog — the exact same color
  // transform the fogged ground gets. Sky and horizon can never show
  // a seam this way, in any camera, at any time of day.
  skyMat = new THREE.MeshBasicMaterial(
    { color: SKY, side: THREE.BackSide, depthWrite: false });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(520, 24, 12), skyMat));

  // large enough that its edge is beyond the fog and the camera far
  // plane — otherwise a seam shows at the horizon
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  roadTex = makeRoadTexture();
  roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.93 });
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN), roadMat);
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
  initRain();
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

let cloudMat = null;   // shared so the day/night cycle can tint the clouds
let skyMat = null;     // the sky-dome material, retinted by the cycle

function makeClouds() {
  cloudMat = new THREE.MeshBasicMaterial(
    { color: 0xffffff, transparent: true, opacity: 0.85 });
  const geo = new THREE.SphereGeometry(1, 10, 8);
  for (let i = 0; i < 6; i++) {
    const cloud = new THREE.Group();
    for (let p = 0; p < 3; p++) {
      const puff = new THREE.Mesh(geo, cloudMat);
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

/* ---------------- 4b. Day / night cycle ---------------- */

// Keyframes around the clock: noon → sunset → night → dawn → noon.
// `dark` drives everything night-related (headlights, cloud tint).
const skyC = (hex) => new THREE.Color(hex);
const DAY_PHASES = [
  { t: 0.0, sky: skyC(0x84b6ea), sunC: new THREE.Color(0xfff2d9),
    sunI: 1.35, hemiI: 0.65, dark: 0 },
  { t: 0.34, sky: skyC(0xe8a163), sunC: new THREE.Color(0xffb36b),
    sunI: 0.7, hemiI: 0.38, dark: 0.3 },
  { t: 0.46, sky: skyC(0x121d33), sunC: new THREE.Color(0x93a7e0),
    sunI: 0.14, hemiI: 0.16, dark: 1 },
  { t: 0.68, sky: skyC(0x121d33), sunC: new THREE.Color(0x93a7e0),
    sunI: 0.14, hemiI: 0.16, dark: 1 },
  { t: 0.82, sky: skyC(0xe8a163), sunC: new THREE.Color(0xffb36b),
    sunI: 0.7, hemiI: 0.38, dark: 0.3 },
  { t: 1.0, sky: skyC(0x84b6ea), sunC: new THREE.Color(0xfff2d9),
    sunI: 1.35, hemiI: 0.65, dark: 0 },
];
const DAY_LENGTH = 160;   // seconds for a full day
const _sky = new THREE.Color();
const _sunTint = new THREE.Color();

function applyDayNight(dt) {
  dayT = (dayT + dt / DAY_LENGTH) % 1;
  let a = DAY_PHASES[0];
  let b = DAY_PHASES[1];
  for (let i = 0; i < DAY_PHASES.length - 1; i++) {
    if (dayT >= DAY_PHASES[i].t && dayT <= DAY_PHASES[i + 1].t) {
      a = DAY_PHASES[i];
      b = DAY_PHASES[i + 1];
      break;
    }
  }
  const k = (dayT - a.t) / (b.t - a.t || 1);
  const mix = (x, y) => x + (y - x) * k;
  _sky.copy(a.sky).lerp(b.sky, k);
  _sunTint.copy(a.sunC).lerp(b.sunC, k);
  scene.background.copy(_sky);      // fallback, hidden behind the dome
  if (skyMat) skyMat.color.copy(_sky);
  scene.fog.color.copy(_sky);
  sun.color.copy(_sunTint);
  sun.intensity = mix(a.sunI, b.sunI);
  hemi.intensity = mix(a.hemiI, b.hemiI);
  const dark = mix(a.dark, b.dark);
  if (cloudMat) cloudMat.color.setScalar(1 - dark * 0.72);
  if (headlights) headlights.intensity = dark * 4;
}

/* ---------------- 4c. Weather (rain showers) ---------------- */

const RAIN_DROPS = 320;
const rain = { active: false, fade: 0, nextAt: 35, until: 0,
               geo: null, mat: null, mesh: null, drops: [], audio: null };
let roadMat = null;   // hoisted so rain can wet the asphalt

function initRain() {
  rain.geo = new THREE.BufferGeometry();
  rain.geo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 6), 3));
  rain.mat = new THREE.LineBasicMaterial(
    { color: 0xaec6dd, transparent: true, opacity: 0 });
  rain.mesh = new THREE.LineSegments(rain.geo, rain.mat);
  rain.mesh.frustumCulled = false;
  rain.mesh.visible = false;
  scene.add(rain.mesh);
  for (let i = 0; i < RAIN_DROPS; i++) {
    rain.drops.push({ x: (Math.random() - 0.5) * 50,
      y: Math.random() * 16, z: 10 - Math.random() * 55 });
  }
}

function startRainSound() {
  if (!actx || rain.audio) return;
  const buf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = actx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  const g = actx.createGain();
  g.gain.value = 0;
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start();
  g.gain.setTargetAtTime(0.05, actx.currentTime, 1.0);
  rain.audio = { src, g };
}

function stopRainSound() {
  if (!rain.audio) return;
  const a = rain.audio;
  rain.audio = null;
  a.g.gain.setTargetAtTime(0, actx.currentTime, 0.8);
  setTimeout(() => a.src.stop(), 2500);
}

function updateRain(dt, playerSpeed) {
  if (state === STATE.PLAYING && !rain.active &&
      (DEV.has('rain') || elapsed > rain.nextAt)) {
    rain.active = true;
    rain.until = elapsed + 20 + Math.random() * 25;
    toast('🌧 RAIN — SLIPPERY ROAD!');
    startRainSound();
  }
  if (rain.active && elapsed > rain.until && !DEV.has('rain')) {
    rain.active = false;
    rain.nextAt = elapsed + 40 + Math.random() * 50;
    stopRainSound();
  }

  rain.fade += ((rain.active ? 1 : 0) - rain.fade) * Math.min(1, 1.2 * dt);
  rain.mesh.visible = rain.fade > 0.01;
  rain.mat.opacity = rain.fade * 0.55;
  if (roadMat) {                    // wet asphalt: darker and glossier
    roadMat.roughness = 0.93 - rain.fade * 0.6;
    const c = 1 - rain.fade * 0.35;
    roadMat.color.setRGB(c, c, c);
  }

  if (!rain.mesh.visible) return;
  const p = rain.geo.attributes.position.array;
  for (let i = 0; i < RAIN_DROPS; i++) {
    const d = rain.drops[i];
    d.y -= 26 * dt;
    d.z += playerSpeed * dt * 0.5;
    if (d.y < 0 || d.z > 12) {
      d.y = 12 + Math.random() * 6;
      d.x = camera.position.x + (Math.random() - 0.5) * 50;
      d.z = 10 - Math.random() * 55;
    }
    const j = i * 6;
    p[j] = d.x;
    p[j + 1] = d.y;
    p[j + 2] = d.z;
    p[j + 3] = d.x + 0.06;
    p[j + 4] = d.y + 0.55;
    p[j + 5] = d.z - 0.4;
  }
  rain.geo.attributes.position.needsUpdate = true;
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

  // headlights: a real spotlight, faded in by the night cycle
  headlights = new THREE.SpotLight(0xfff3c2, 0, 60, 0.5, 0.5, 1.0);
  headlights.position.set(0, 1.1, -1.6);
  headlights.target.position.set(0, 0.1, -30);
  player.group.add(headlights);
  player.group.add(headlights.target);

  // shield bubble, hidden until the power-up is collected
  shieldMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0x55bbff, transparent: true,
      opacity: 0.2, depthWrite: false }));
  shieldMesh.scale.set(1.7, 1.2, 3.0);
  shieldMesh.position.y = 0.8;
  shieldMesh.visible = false;
  player.group.add(shieldMesh);

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
    hit: false, hazT: 0, vx: 0, vz: 0, spinY: 0,
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
    sameTimer = Math.max(difficulty.spawnMin,
      difficulty.spawnBase - elapsed * 0.015) * (0.8 + Math.random() * 0.5);
  }
  oncTimer -= dt;
  if (oncTimer <= 0) {
    trySpawnOncoming();
    oncTimer = 1.3 + Math.random() * 1.4;
  }

  for (const n of npcs) {
    // a car that got hit in a crash: shoved, spinning, hazards on
    if (n.hit) {
      n.hazT += dt;
      const on = n.hazT % 0.8 < 0.4;
      for (const b of n.g.userData.blinkL) b.visible = on;
      for (const b of n.g.userData.blinkR) b.visible = on;
      n.speed = Math.max(0, n.speed - 22 * dt);
      n.x += n.vx * dt;
      n.z += (playerSpeed - n.speed) * dt + n.vz * dt;
      const damp = Math.max(0, 1 - 2.5 * dt);
      n.vx *= damp;
      n.vz *= damp;
      n.g.rotation.y += n.spinY * dt;
      n.spinY *= Math.max(0, 1 - 1.8 * dt);
      n.g.position.set(n.x, 0, n.z);
      continue;
    }

    // brake hard behind the player's wreck instead of driving through it
    if (crashFx && n.dir === -1 && Math.abs(n.x - player.x) < 2.4 &&
        n.z < 0 && n.z > -18) {
      n.speed += (playerSpeed - n.speed) * Math.min(1, 3 * dt);
    }

    // cars coming up behind you brake too — braking mustn't mean
    // getting rear-ended by traffic you already overtook
    if (playing && n.dir === -1 && n.z > 2 && n.z < 20 &&
        Math.abs(n.x - player.x) < 2.4 && n.speed > playerSpeed * 0.95) {
      n.speed += (playerSpeed * 0.95 - n.speed) * Math.min(1, 4 * dt);
    }

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
        // chained near-misses build a combo for bigger points
        combo = elapsed - comboT < 3 ? combo + 1 : 1;
        comboT = elapsed;
        const pts = 100 * combo;
        bonus += pts;
        toast(combo > 1 ? `🔥 NEAR MISS x${combo}! +${pts}` : 'NEAR MISS +100');
        tone(700 + combo * 120, 0.16, 'triangle', 0.1, 600);
      }
    }
  }

  npcs = npcs.filter((n) => {
    if (n.z > 45 || n.z < SPAWN_Z - 60) { releaseNpc(n); return false; }
    return true;
  });
}

function laneClearFor(n, lane) {
  // never merge into the player's lane right where the player is
  if (n.dir === -1 && Math.abs(laneX(lane) - player.x) < 2.6 &&
      Math.abs(n.z) < 30) return false;
  return !npcs.some((m) => m !== n && m.dir === n.dir &&
    (m.lane === lane || m.targetLane === lane) &&
    Math.abs(m.z - n.z) < 20);
}

/* ---------------- 6b. Police chase ---------------- */

let cops = [];           // active cruisers (two of them at wanted ★★+)
const copPool = [];      // cruiser models, built once and reused
let nextCopAt = 500;     // distance (m) at which the next chase begins
let siren = null;
let stickTimer = 0;      // countdown to the next spike strip drop

function buildCopCar() {
  const g = buildCar('sedan');
  g.userData.paint.color.set(0xf2f4f6);   // white cruiser
  const barBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.1, 0.42), carShared.dark);
  barBase.position.set(0, 1.42, 0.15);
  const red = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.16, 0.4),
    new THREE.MeshStandardMaterial(
      { color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 2.5 }));
  red.position.set(-0.24, 1.54, 0.15);
  const blue = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.16, 0.4),
    new THREE.MeshStandardMaterial(
      { color: 0x2244ff, emissive: 0x0033ff, emissiveIntensity: 2.5 }));
  blue.position.set(0.24, 1.54, 0.15);
  g.add(barBase, red, blue);
  g.userData.red = red;
  g.userData.blue = blue;
  return g;
}

function getCopCar() {
  const pooled = copPool.pop();
  if (pooled) { pooled.visible = true; return pooled; }
  const g = buildCopCar();
  scene.add(g);
  return g;
}

// Wanted ★: one cruiser rams from behind. Wanted ★★+: a second unit
// pulls up alongside and squeezes you toward the barrier.
function spawnChase() {
  wanted = Math.max(1, wanted);
  const units = wanted >= 2 ? 2 : 1;
  const side = player.x > (MEDIAN_HALF + ROAD_HALF) / 2 ? -1 : 1;
  for (let i = 0; i < units; i++) {
    cops.push({
      g: getCopCar(),
      role: i === 0 ? 'tail' : 'side',
      side: i === 0 ? 0 : side,
      x: player.x + (i === 0 ? 0 : side * 3.2),
      z: 44 + i * 12,
      speed: curSpeed, t: 0, squeeze: 0,
      chaseFor: 14 + Math.random() * 5,
      retreating: false, spinning: false,
    });
  }
  const g = cops[0].g;
  g.rotation.set(0, 0, 0);   // pooled cars may come back spun around
  startSiren();
  toast(wanted >= 3 ? '🚨 WANTED ★★★ — CHOPPER + SPIKE STRIPS!'
      : units === 2 ? '🚨 TWO UNITS INCOMING!'
      : '🚨 POLICE! OUTRUN THEM!');
  stickTimer = 5;
  if (wanted >= 3) spawnHeli();   // air support at three stars
  updateWantedHud();
}

function removeCop(c, msg) {
  c.g.visible = false;
  c.g.rotation.set(0, 0, 0);
  copPool.push(c.g);
  cops = cops.filter((k) => k !== c);
  if (msg) {
    bonus += 500;
    toast(msg);
  }
  if (!cops.length) {
    stopSiren();
    hideHeli();
    wanted = Math.min(3, wanted + 1);   // they'll be back — angrier
    nextCopAt = distance + difficulty.copEvery * 2.6 + Math.random() * 600;
    updateWantedHud();
  }
}

function updateCops(dt, playerSpeed) {
  if (!cops.length) {
    if (state === STATE.PLAYING && distance > nextCopAt) spawnChase();
    return;
  }

  // at wanted ★★+ the chase keeps dropping spike strips ahead of you
  // (unless your radar jammer is scrambling their coordination)
  if (state === STATE.PLAYING && wanted >= 2 && jamT <= 0) {
    stickTimer -= dt;
    if (stickTimer <= 0) {
      stickTimer = wanted >= 3 ? 4 + Math.random() * 3 : 7 + Math.random() * 4;
      spawnStick();
    }
  }

  for (const c of [...cops]) {
    c.t += dt;
    const phase = Math.floor(c.t * 7) % 2 === 0;
    c.g.userData.red.visible = phase;
    c.g.userData.blue.visible = !phase;

    if (state === STATE.OVER) {   // after a crash the cruisers pull up
      c.speed = Math.max(0, c.speed - 20 * dt);
      c.z = Math.max(6.5, c.z + (playerSpeed - c.speed) * dt);
      c.g.position.set(c.x, 0, c.z);
      continue;
    }

    if (c.spinning) {             // hit an oil slick — spins out behind you
      c.g.rotation.y += 7 * dt;
      c.speed += (playerSpeed * 0.4 - c.speed) * Math.min(1, 1.5 * dt);
      c.z += (playerSpeed - c.speed) * dt;
      c.g.position.set(c.x, 0, c.z);
      if (c.z > 40) removeCop(c, 'COP SPUN OUT! +500');
      continue;
    }

    // in the chopper's searchlight the chase never times out
    if (heli && heli.lit) c.chaseFor += dt;
    if (!c.retreating && c.t > c.chaseFor) c.retreating = true;

    // approach the hold position, capped at the cruiser's top speed
    const maxChase = playerSpeed * (difficulty.copSpeed + wanted * 0.01) +
                     difficulty.copBoost;
    const targetZ = c.role === 'side' ? 0.6 : 3.8;
    const wantSpeed = c.retreating ? playerSpeed * 0.75
      : Math.min(maxChase,
          playerSpeed + THREE.MathUtils.clamp((c.z - targetZ) * 0.6, -4, 99));
    c.speed += (wantSpeed - c.speed) * Math.min(1, 1.2 * dt);
    c.z += (playerSpeed - c.speed) * dt;
    const minZ = c.role === 'side' ? -1.5 : 3.6;
    if (c.z < minZ) c.z = minZ;

    // the tail unit lines up to ram; the side unit pulls alongside,
    // then squeezes in — change speed to break the box
    let targetX = player.x;
    if (c.role === 'side') {
      if (c.z > 7) {
        c.squeeze = 0;
        targetX = player.x + c.side * 2.8;
      } else {
        c.squeeze = Math.min(2.4, c.squeeze + 0.55 * dt);
        targetX = player.x + c.side * (2.8 - c.squeeze);
      }
    }
    // a radar jammer halves how well they can track you sideways
    const maxLat = (c.role === 'side' ? 6.5 : 8) * (jamT > 0 ? 0.45 : 1) * dt;
    c.x += THREE.MathUtils.clamp(targetX - c.x, -maxLat, maxLat);
    c.x = THREE.MathUtils.clamp(c.x, MEDIAN_HALF + 1.05, ROAD_HALF - 1.05);

    c.g.position.set(c.x, 0, c.z);
    const spin = (c.speed / 0.34) * dt;
    for (const w of c.g.userData.wheels) w.rotation.x -= spin;

    // rammed or squeezed you → busted
    if (Math.abs(c.x - player.x) < 1.8 && Math.abs(c.z) < 4.3) {
      crash({ x: c.x, z: c.z, halfW: 0.95, halfL: 2.25,
              hit: false, hazT: 0, vx: 0, vz: 0, spinY: 0 }, true);
      return;
    }

    // oil slicks spin them out
    for (const s of slicks) {
      if (Math.abs(s.m.position.x - c.x) < 2.2 &&
          Math.abs(s.m.position.z - c.z) < 3.2) {
        c.spinning = true;
        noiseBurst(0.6, 1800, 200, 0.3, 'bandpass');
        break;
      }
    }
    if (c.spinning) continue;

    // and they can still pile into traffic — bait them!
    for (const n of npcs) {
      if (n.dir !== -1 || n.hit) continue;
      if (Math.abs(n.x - c.x) < n.halfW + 0.75 &&
          Math.abs(n.z - c.z) < n.halfL + 1.95) {
        n.hit = true;
        n.hazT = 0;
        const away = Math.sign(n.x - c.x) || 1;
        n.vx = away * 3;
        n.vz = -5;
        n.spinY = away * 3;
        noiseBurst(0.5, 700, 120, 0.35);
        removeCop(c, 'THE COPS CRASHED! +500');
        break;
      }
    }
    if (!cops.includes(c)) continue;

    if (c.retreating && c.z > 40) {
      removeCop(c, cops.length === 1 ? 'YOU LOST THEM! +500' : null);
    }
  }

  updateSiren();
}

/* ------ 6d. Police helicopter — pilot: one chunky tuxedo cat ------ */

let heli = null;        // active chase state
let heliCraft = null;   // the model, built once and reused
let heliSound = null;

function buildCat() {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial(
    { color: 0x2b2d33, roughness: 0.75 });
  const white = new THREE.MeshStandardMaterial(
    { color: 0xf7f5ef, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 12), black);
  body.scale.set(1.15, 0.95, 1.05);                    // chunky.
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 10), white);
  belly.position.set(0, -0.02, -0.26);                 // tuxedo chest
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), black);
  head.position.set(0, 0.56, -0.12);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), white);
  muzzle.position.set(0, 0.48, -0.32);
  const earGeo = new THREE.ConeGeometry(0.11, 0.2, 6);
  const earL = new THREE.Mesh(earGeo, black);
  earL.position.set(-0.18, 0.87, -0.08);
  const earR = earL.clone();
  earR.position.x = 0.18;
  const eyeGeo = new THREE.SphereGeometry(0.05, 8, 6);
  const eyeMat = new THREE.MeshStandardMaterial(
    { color: 0x3dbf5f, emissive: 0x1d8f3f, emissiveIntensity: 0.9 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.12, 0.62, -0.4);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.12;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0xe58ea0 }));
  nose.position.set(0, 0.52, -0.5);
  const pawGeo = new THREE.SphereGeometry(0.11, 8, 6);
  const pawL = new THREE.Mesh(pawGeo, white);          // paws on the stick
  pawL.position.set(-0.2, 0.1, -0.55);
  const pawR = pawL.clone();
  pawR.position.x = 0.2;
  g.add(body, belly, head, muzzle, earL, earR, eyeL, eyeR, nose, pawL, pawR);
  return g;
}

function buildHeli() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial(
    { color: 0xf2f4f6, metalness: 0.3, roughness: 0.4 });
  const blue = new THREE.MeshStandardMaterial(
    { color: 0x2456a8, roughness: 0.5 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.5, 3.4), white);
  body.position.y = 0.2;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.34, 3.42), blue);
  stripe.position.y = 0.05;
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 2.8), white);
  boom.position.set(0, 0.45, 3.0);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.5), blue);
  fin.position.set(0, 0.85, 4.2);
  g.add(body, stripe, boom, fin);

  // glass bubble with the pilot inside — keep it clear enough that
  // everyone can see who is flying this thing
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xbfe4ff, transparent: true,
      opacity: 0.14, metalness: 0.5, roughness: 0.08, depthWrite: false }));
  bubble.position.set(0, 0.4, -1.55);
  const cat = buildCat();
  cat.scale.setScalar(1.0);
  cat.position.set(0, 0.0, -1.45);
  g.add(cat, bubble);

  // skids
  const skidGeo = new THREE.BoxGeometry(0.12, 0.08, 2.6);
  const strutGeo = new THREE.BoxGeometry(0.08, 0.5, 0.08);
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(skidGeo, carShared.dark);
    skid.position.set(s * 0.8, -0.85, -0.3);
    const s1 = new THREE.Mesh(strutGeo, carShared.dark);
    s1.position.set(s * 0.8, -0.6, -1.0);
    const s2 = s1.clone();
    s2.position.z = 0.5;
    g.add(skid, s1, s2);
  }

  // main + tail rotors
  const rotor = new THREE.Group();
  const bladeGeo = new THREE.BoxGeometry(9, 0.05, 0.3);
  const b1 = new THREE.Mesh(bladeGeo, carShared.dark);
  const b2 = b1.clone();
  b2.rotation.y = Math.PI / 2;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8), carShared.dark);
  shaft.position.y = -0.15;
  rotor.add(b1, b2, shaft);
  rotor.position.set(0, 1.15, 0);
  const tailRotor = new THREE.Group();
  const tb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, 0.16),
    carShared.dark);
  const tb2 = tb.clone();
  tb2.rotation.x = Math.PI / 2;
  tailRotor.add(tb, tb2);
  tailRotor.position.set(0.16, 0.85, 4.25);
  g.add(rotor, tailRotor);

  // searchlight: a real spotlight plus a visible beam cone
  const spot = new THREE.SpotLight(0xfff3c2, 2.5, 70, 0.3, 0.5);
  spot.position.set(0, -0.7, 0);
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, -20, 0);
  spot.target = spotTarget;
  const beamCone = new THREE.Mesh(
    new THREE.ConeGeometry(2.6, 1, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true,
      opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }));
  g.add(spot, spotTarget, beamCone);

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  bubble.castShadow = false;
  beamCone.castShadow = false;
  g.userData = { rotor, tailRotor, beamCone };
  return g;
}

function startHeliSound() {
  if (!actx || heliSound) return;
  const o = actx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 52;
  const f = actx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 180;
  const g = actx.createGain();
  g.gain.value = 0.045;
  const lfo = actx.createOscillator();          // wop-wop-wop
  lfo.type = 'square';
  lfo.frequency.value = 11;
  const lg = actx.createGain();
  lg.gain.value = 0.03;
  lfo.connect(lg);
  lg.connect(g.gain);
  o.connect(f);
  f.connect(g);
  g.connect(master);
  o.start();
  lfo.start();
  heliSound = { o, lfo, g };
}

function stopHeliSound() {
  if (!heliSound) return;
  const h = heliSound;
  heliSound = null;
  h.g.gain.setTargetAtTime(0, actx.currentTime, 0.4);
  setTimeout(() => { h.o.stop(); h.lfo.stop(); }, 1500);
}

function spawnHeli() {
  if (!heliCraft) {
    heliCraft = buildHeli();
    scene.add(heliCraft);
  }
  heliCraft.visible = true;
  heli = { t: 0, x: player.x, z: -40, y: 15, lit: false, litToast: 0 };
  startHeliSound();
}

function hideHeli() {
  if (!heli) return;
  heli = null;
  heliCraft.visible = false;
  stopHeliSound();
}

function updateHeli(dt, playerSpeed) {
  if (!heli) return;
  heli.t += dt;

  // sweeps ahead of you and periodically dips back over your position;
  // a radar jammer sends it wandering off your trail
  const targetX = jamT > 0 ? Math.sin(heli.t * 0.9) * 9
                           : player.x + Math.sin(heli.t * 0.45) * 4;
  const targetZ = -18 + Math.cos(heli.t * 0.35) * 20;
  heli.x += (targetX - heli.x) * Math.min(1, 1.1 * dt);
  heli.z += (targetZ - heli.z) * Math.min(1, 0.8 * dt);
  heli.y = 14 + Math.sin(heli.t * 0.8) * 1.2;

  heliCraft.position.set(heli.x, heli.y, heli.z);
  heliCraft.rotation.y = Math.PI;                 // face you — see the pilot
  heliCraft.rotation.z = (targetX - heli.x) * 0.05;
  const u = heliCraft.userData;
  u.rotor.rotation.y += 28 * dt;
  u.tailRotor.rotation.x += 40 * dt;
  u.beamCone.scale.set(1, heli.y, 1);
  u.beamCone.position.y = -0.7 - heli.y / 2;

  // caught in the searchlight → the chase never times out
  heli.lit = jamT <= 0 && state === STATE.PLAYING &&
    Math.abs(heli.x - player.x) < 2.6 && Math.abs(heli.z) < 3.5;
  if (heli.lit && heli.t > heli.litToast) {
    heli.litToast = heli.t + 6;
    toast('🔦 SPOTTED! GET OUT OF THE LIGHT!');
  }
}

/* ------- 6c. Spike strips, oil slicks, power-ups, wanted HUD ------- */

const stickPool = [];
let sticks = [];

function makeStick() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 0.06, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.8 }));
  base.position.y = 0.04;
  g.add(base);
  const spikeGeo = new THREE.ConeGeometry(0.06, 0.22, 5);
  const spikeMat = new THREE.MeshStandardMaterial(
    { color: 0xb9c2cc, metalness: 0.8, roughness: 0.3 });
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(spikeGeo, spikeMat);
    s.position.set(-1.9 + i * 0.475, 0.16, 0);
    g.add(s);
  }
  return g;
}

function spawnStick() {
  const lane = (Math.random() * LANES) | 0;
  let g = stickPool.pop();
  if (!g) { g = makeStick(); scene.add(g); }
  g.visible = true;
  g.position.set(laneX(lane), 0, -290);
  sticks.push({ g });
  toast('🚧 SPIKE STRIP AHEAD!');
}

function blowTires() {
  tiresBlown = 5;
  shake = Math.max(shake, 0.5);
  noiseBurst(0.2, 3200, 400, 0.4);
  noiseBurst(0.25, 2600, 300, 0.35, 'lowpass', 0.1);
  toast('💥 TIRES BLOWN!');
}

let tireSmokeT = 0;

function updateBlownTires(dt) {
  tiresBlown -= dt;
  shake = Math.max(shake, 0.06);   // constant rattle while limping
  tireSmokeT -= dt;
  if (tireSmokeT <= 0) {
    tireSmokeT = 0.09;
    spawnSmoke(player.x - 0.8, 0.35, 1.3, false);
    spawnSmoke(player.x + 0.8, 0.35, 1.3, false);
  }
  if (tiresBlown <= 0) toast('TIRES OK — GO!');
}

const slickPool = [];
let slicks = [];

function makeSlick() {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 20),
    new THREE.MeshStandardMaterial(
      { color: 0x0d0f12, roughness: 0.12, metalness: 0.75 }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

function deployOil() {
  if (state !== STATE.PLAYING || oilCharges <= 0) return;
  oilCharges--;
  updateOilHud();
  let m = slickPool.pop();
  if (!m) { m = makeSlick(); scene.add(m); }
  m.visible = true;
  m.position.set(player.x, 0.035, 3.4);
  slicks.push({ m, life: 15 });
  tone(160, 0.25, 'sine', 0.15, -100);
  toast('🛢️ OIL DROPPED');
}

const pickupPool = { shield: [], oil: [], slow: [], jammer: [] };
let pickups = [];

function makePickup(type) {
  if (type === 'shield') {
    return new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55),
      new THREE.MeshStandardMaterial(
        { color: 0x66bbff, emissive: 0x2277ff, emissiveIntensity: 1.6,
          metalness: 0.3, roughness: 0.3 }));
  }
  if (type === 'slow') {
    return new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.16, 10, 18),
      new THREE.MeshStandardMaterial(
        { color: 0x59e0e8, emissive: 0x18b7c9, emissiveIntensity: 1.5,
          roughness: 0.3 }));
  }
  if (type === 'jammer') {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6 }));
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8),
      new THREE.MeshStandardMaterial(
        { color: 0x9aa3ad, metalness: 0.8, roughness: 0.3 }));
    mast.position.y = 0.55;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6),
      new THREE.MeshStandardMaterial(
        { color: 0xff4444, emissive: 0xdd1111, emissiveIntensity: 2.2 }));
    tip.position.y = 1.05;
    g.add(base, mast, tip);
    return g;
  }
  const g = new THREE.Group();
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.75, 12),
    new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.5 }));
  const stripe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.43, 0.43, 0.18, 12),
    new THREE.MeshStandardMaterial(
      { color: 0xff8c42, emissive: 0xcc5500, emissiveIntensity: 0.8 }));
  g.add(barrel, stripe);
  return g;
}

function spawnPickup() {
  let lane = (Math.random() * LANES) | 0;
  if (DEV.has('pickup')) {           // test aid: spawn in the player's lane
    let bestD = 1e9;
    for (let l = 0; l < LANES; l++) {
      const d = Math.abs(laneX(l) - player.x);
      if (d < bestD) { bestD = d; lane = l; }
    }
  }
  if (!DEV.has('pickup') && npcs.some((n) => n.dir === -1 &&
      (n.lane === lane || n.targetLane === lane) && n.z < -240)) {
    pickupNext = distance + 60;   // lane busy at spawn depth — retry soon
    return;
  }
  const r = Math.random();
  let type = r < 0.3 ? 'oil' : r < 0.55 ? 'shield' : r < 0.8 ? 'slow'
                                                             : 'jammer';
  if (pickupPool[DEV.get('pickup')]) type = DEV.get('pickup');
  let g = pickupPool[type].pop();
  if (!g) { g = makePickup(type); scene.add(g); }
  g.visible = true;
  pickups.push({ g, type, x: laneX(lane), z: -295,
                 spin: Math.random() * 6, taken: false });
}

function collectPickup(p) {
  p.taken = true;
  tone(880, 0.12, 'triangle', 0.12, 440);
  if (p.type === 'oil') {
    oilCharges = Math.min(3, oilCharges + 1);
    updateOilHud();
    toast('🛢️ +1 OIL SLICK');
  } else if (p.type === 'slow') {
    slowMoT = 4;
    tone(300, 0.35, 'sine', 0.12, -150);
    toast('⏱ SLOW MOTION!');
  } else if (p.type === 'jammer') {
    jamT = 7;
    tone(1200, 0.25, 'square', 0.08, -500);
    toast('📡 RADAR JAMMED!');
  } else {
    setShield(true);
    toast('🛡 SHIELD UP!');
  }
}

/* --- coins: the classic collectible --- */

const coinPool = [];
let activeCoins = [];
let coinMat = null;

function spawnCoinRow() {
  let lane = (Math.random() * LANES) | 0;
  if (DEV.has('coinlane')) {        // test aid: rows in the player's lane
    let bestD = 1e9;
    for (let l = 0; l < LANES; l++) {
      const d = Math.abs(laneX(l) - player.x);
      if (d < bestD) { bestD = d; lane = l; }
    }
  } else if (npcs.some((n) => n.dir === -1 &&
      (n.lane === lane || n.targetLane === lane) && n.z < -230)) {
    coinNext = distance + 40;
    return;
  }
  if (!coinMat) {
    coinMat = new THREE.MeshStandardMaterial(
      { color: 0xffd34d, emissive: 0xbb8800, emissiveIntensity: 0.6,
        metalness: 0.8, roughness: 0.25 });
  }
  for (let i = 0; i < 5; i++) {
    let g = coinPool.pop();
    if (!g) {
      g = new THREE.Group();
      const c = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.09, 16), coinMat);
      c.rotation.x = Math.PI / 2;   // face the driver, spin like Mario's
      g.add(c);
      scene.add(g);
    }
    g.visible = true;
    g.position.set(laneX(lane), 1.0, -300 - i * 7);
    activeCoins.push({ g, taken: false });
  }
}

function updateCoins(dt, playerSpeed, playing) {
  for (const c of activeCoins) {
    c.g.position.z += playerSpeed * dt;
    c.g.rotation.y += 3.5 * dt;
    if (playing && !c.taken &&
        Math.abs(c.g.position.x - player.x) < 1.6 &&
        Math.abs(c.g.position.z) < 2.2) {
      c.taken = true;
      coins++;
      bonus += 25;
      ui.coins.textContent = coins;
      tone(1319, 0.08, 'triangle', 0.09);
      tone(1760, 0.12, 'triangle', 0.09, 0, 0.06);
    }
  }
  activeCoins = activeCoins.filter((c) => {
    if (c.taken || c.g.position.z > 45) {
      c.g.visible = false;
      coinPool.push(c.g);
      return false;
    }
    return true;
  });
}

/* --- the horn: beep and polite drivers move over --- */

function honk() {
  if (state !== STATE.PLAYING) return;
  tone(392, 0.15, 'square', 0.14);
  tone(494, 0.15, 'square', 0.14);
  tone(392, 0.15, 'square', 0.12, 0, 0.22);
  tone(494, 0.15, 'square', 0.12, 0, 0.22);
  for (const n of npcs) {
    if (n.dir !== -1 || n.hit || n.targetLane !== n.lane) continue;
    if (n.z < -4 && n.z > -30 && Math.abs(n.x - player.x) < 2.2) {
      for (const to of [n.lane - 1, n.lane + 1]) {
        if (to >= 0 && to < LANES && laneClearFor(n, to)) {
          n.targetLane = to;
          n.blinkT = 0;
          break;
        }
      }
      break;   // one car per honk
    }
  }
}

/* --- paint jobs --- */

const PAINTS = { red: 0xd42a1e, blue: 0x1f6fe0, green: 0x2fbf4e,
                 purple: 0x8a3fd6, pink: 0xf05fa0, yellow: 0xf2c010,
                 midnight: 0x1a2340, gold: 0xd9a520, rainbow: 0xff0000 };
// milestone rewards: beat these scores to unlock the fancy paints
const PAINT_UNLOCKS = { midnight: 1500, gold: 3000, rainbow: 6000 };

const paintUnlocked = (name) =>
  !(name in PAINT_UNLOCKS) || best >= PAINT_UNLOCKS[name];

function setPaint(name, quiet) {
  if (!PAINTS[name]) name = 'red';
  if (!paintUnlocked(name)) {
    if (quiet) { setPaint('red', true); return; }
    ui.unlockHint.textContent =
      `🔒 Reach ${PAINT_UNLOCKS[name]} points to unlock this paint!`;
    return;
  }
  ui.unlockHint.textContent = '';
  paintName = name;
  localStorage.setItem('turboRushPaint', paintName);
  if (player.group && paintName !== 'rainbow') {
    player.group.userData.paint.color.set(PAINTS[paintName]);
  }
  document.querySelectorAll('.paint').forEach((b) =>
    b.classList.toggle('selected', b.dataset.p === paintName));
}

function updatePaintLocks() {
  document.querySelectorAll('.paint').forEach((b) => {
    const locked = !paintUnlocked(b.dataset.p);
    b.classList.toggle('locked', locked);
    b.textContent = locked ? '🔒' : '';
  });
}

// Officer Whiskers' portrait, drawn once onto a small canvas
function drawCatFace() {
  const cv = $('catFace');
  if (!cv) return;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, 96, 96);
  c.fillStyle = '#232529';                              // ears
  c.beginPath(); c.moveTo(14, 38); c.lineTo(22, 8); c.lineTo(42, 26); c.fill();
  c.beginPath(); c.moveTo(82, 38); c.lineTo(74, 8); c.lineTo(54, 26); c.fill();
  c.fillStyle = '#e58ea0';
  c.beginPath(); c.moveTo(21, 31); c.lineTo(25, 16); c.lineTo(35, 25); c.fill();
  c.beginPath(); c.moveTo(75, 31); c.lineTo(71, 16); c.lineTo(61, 25); c.fill();
  c.fillStyle = '#232529';                              // chunky head
  c.beginPath(); c.ellipse(48, 54, 34, 30, 0, 0, 7); c.fill();
  c.fillStyle = '#f5f2ea';                              // white muzzle
  c.beginPath(); c.ellipse(48, 66, 20, 14, 0, 0, 7); c.fill();
  c.fillStyle = '#3dbf5f';                              // green eyes
  c.beginPath(); c.ellipse(34, 50, 7, 8, 0, 0, 7); c.fill();
  c.beginPath(); c.ellipse(62, 50, 7, 8, 0, 0, 7); c.fill();
  c.fillStyle = '#111';
  c.beginPath(); c.ellipse(34, 51, 2.5, 6, 0, 0, 7); c.fill();
  c.beginPath(); c.ellipse(62, 51, 2.5, 6, 0, 0, 7); c.fill();
  c.fillStyle = '#e58ea0';                              // nose
  c.beginPath(); c.moveTo(43, 60); c.lineTo(53, 60); c.lineTo(48, 66); c.fill();
  c.strokeStyle = '#232529';                            // mouth
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(48, 66); c.lineTo(48, 70);
  c.moveTo(48, 70); c.quadraticCurveTo(43, 75, 38, 71);
  c.moveTo(48, 70); c.quadraticCurveTo(53, 75, 58, 71);
  c.stroke();
  c.strokeStyle = '#ddd';                               // whiskers
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(28, 62); c.lineTo(6, 58); c.moveTo(28, 67); c.lineTo(6, 68);
  c.moveTo(68, 62); c.lineTo(90, 58); c.moveTo(68, 67); c.lineTo(90, 68);
  c.stroke();
  c.fillStyle = '#2456a8';                              // police cap
  c.beginPath(); c.ellipse(48, 26, 26, 10, 0, Math.PI, 0); c.fill();
  c.fillRect(22, 22, 52, 7);
  c.fillStyle = '#ffd166';                              // badge
  c.beginPath(); c.arc(48, 25, 3.5, 0, 7); c.fill();
}

// small bottom-left readout for timed effects
function updateFxTag() {
  const parts = [];
  if (slowMoT > 0) parts.push(`⏱ ${Math.ceil(slowMoT)}s`);
  if (jamT > 0) parts.push(`📡 ${Math.ceil(jamT)}s`);
  if (rain.fade > 0.5) parts.push('🌧 SLIPPERY');
  ui.fxTag.textContent = parts.join('   ');
  ui.fxTag.classList.toggle('hidden', !parts.length);
}

// Everything lying on the road scrolls past like the scenery does
function updateWorldItems(dt, playerSpeed, playing) {
  for (const p of pickups) {
    if (p.taken) continue;
    p.z += playerSpeed * dt;
    p.spin += dt;
    p.g.position.set(p.x, 1.0 + Math.sin(p.spin * 3) * 0.15, p.z);
    p.g.rotation.y += 2 * dt;
    if (playing && Math.abs(p.x - player.x) < 1.7 && Math.abs(p.z) < 2.6) {
      collectPickup(p);
    }
  }
  pickups = pickups.filter((p) => {
    if (p.taken || p.z > 45) {
      p.g.visible = false;
      pickupPool[p.type].push(p.g);
      return false;
    }
    return true;
  });

  sticks = sticks.filter((st) => {
    st.g.position.z += playerSpeed * dt;
    if (playing && tiresBlown <= 0 &&
        Math.abs(st.g.position.x - player.x) < 2.5 &&
        Math.abs(st.g.position.z) < 2.0) {
      blowTires();
    }
    if (st.g.position.z > 45) {
      st.g.visible = false;
      stickPool.push(st.g);
      return false;
    }
    return true;
  });

  slicks = slicks.filter((s) => {
    s.m.position.z += playerSpeed * dt;
    s.life -= dt;
    if (s.life <= 0 || s.m.position.z > 45) {
      s.m.visible = false;
      slickPool.push(s.m);
      return false;
    }
    return true;
  });
}

function updateWantedHud() {
  ui.wantedPanel.classList.toggle('hidden', wanted === 0);
  // star as an ASCII escape: survives a wrong-charset server
  ui.wanted.textContent = '\u2605'.repeat(wanted);
  ui.wantedPanel.classList.toggle('chase', cops.length > 0);
}

function updateOilHud() {
  ui.oilBtn.textContent = `🛢️ ×${oilCharges}`;
  ui.oilBtn.classList.toggle('empty', oilCharges === 0);
}

function setShield(on) {
  shielded = on;
  if (shieldMesh) shieldMesh.visible = on;
  ui.shieldTag.classList.toggle('hidden', !on);
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

/* --- smoke, fire flash and heavy debris for the crash --- */

let flash;                   // orange point light: the impact fireball
const smokePool = [];
const debrisPool = [];       // loose wheels, a bumper, glass shards
let shardMat;

function initSmoke() {
  flash = new THREE.PointLight(0xff8844, 0, 16);
  scene.add(flash);
  const geo = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 26; i++) {
    const mat = new THREE.MeshBasicMaterial(
      { color: 0x565b62, transparent: true, opacity: 0, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    scene.add(m);
    smokePool.push({ m, mat, vel: new THREE.Vector3(),
                     age: 0, life: 0, baseO: 0.5 });
  }
}

function spawnSmoke(x, y, z, fire, trailColor) {
  const p = smokePool.find((s) => s.life <= 0);
  if (!p) return;
  p.age = 0;
  p.small = trailColor !== undefined;   // boost-trail puffs stay small
  p.life = p.small ? 0.45 : fire ? 0.5 : 1.4 + Math.random() * 1.1;
  p.baseO = p.small ? 0.85 : fire ? 0.95 : 0.5;
  p.m.visible = true;
  p.m.position.set(x + (Math.random() - 0.5) * (p.small ? 0.3 : 1.2),
                   y + (Math.random() - 0.5) * 0.3,
                   z + (Math.random() - 0.5) * (p.small ? 0.3 : 1.6));
  p.vel.set((Math.random() - 0.5) * 1.2, 1.2 + Math.random() * 1.4,
            0.6 + (Math.random() - 0.5));
  p.mat.color.set(trailColor !== undefined ? trailColor : fire
    ? (Math.random() < 0.5 ? 0xff8a3c : 0xffb340)
    : [0x43474d, 0x585d64, 0x7b8189][(Math.random() * 3) | 0]);
  p.mat.opacity = p.baseO;
  p.m.scale.setScalar(p.small ? 0.25 : fire ? 0.35 : 0.5);
}

function updateSmoke(dt) {
  for (const p of smokePool) {
    if (p.life <= 0) continue;
    p.age += dt;
    if (p.age >= p.life) { p.life = 0; p.m.visible = false; continue; }
    p.m.position.addScaledVector(p.vel, dt);
    const k = p.age / p.life;
    p.m.scale.setScalar(p.small ? 0.25 + k * 0.5 : 0.35 + k * 1.9);
    p.mat.opacity = p.baseO * (1 - k) ** 1.1;
  }
}

function initDebris() {
  shardMat = new THREE.MeshBasicMaterial(
    { color: 0xcfe8ff, transparent: true, opacity: 0.9 });
  const items = [];
  const tireGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 14);
  items.push(new THREE.Mesh(tireGeo, carShared.tire));
  items.push(new THREE.Mesh(tireGeo, carShared.tire));
  items.push(new THREE.Mesh(                                  // bumper
    new THREE.BoxGeometry(1.5, 0.12, 0.2), carShared.dark));
  const shardGeo = new THREE.BoxGeometry(0.16, 0.02, 0.16);
  for (let i = 0; i < 10; i++) items.push(new THREE.Mesh(shardGeo, shardMat));
  for (const m of items) {
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    debrisPool.push({ m, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
  }
}

function launchDebris(x, y, z) {
  shardMat.opacity = 0.9;
  for (const d of debrisPool) {
    d.m.visible = true;
    d.m.position.set(x, y, z);
    d.m.rotation.set(0, 0, 0);
    const a = Math.random() * Math.PI * 2;
    const out = 3 + Math.random() * 7;
    d.vel.set(Math.cos(a) * out, 4 + Math.random() * 6,
              Math.sin(a) * out - 3);
    d.spin.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
  }
}

function updateDebris(dt) {
  shardMat.opacity = Math.max(0, shardMat.opacity - 0.35 * dt);
  for (const d of debrisPool) {
    if (!d.m.visible) continue;
    d.vel.y -= 22 * dt;
    d.m.position.addScaledVector(d.vel, dt);
    if (d.m.position.y < 0.15) {
      d.m.position.y = 0.15;
      d.vel.y *= -0.4;
      d.vel.x *= 0.75;
      d.vel.z *= 0.75;
      d.spin.multiplyScalar(0.7);
    }
    d.m.rotation.x += d.spin.x * dt;
    d.m.rotation.y += d.spin.y * dt;
    d.m.rotation.z += d.spin.z * dt;
  }
}

// Runs every frame after a crash: tumbles the wreck, flickers the
// fireball light, keeps pumping out smoke.
const _rotM = new THREE.Matrix4();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

function updateCrashFx(dt) {
  if (!crashFx) return;
  const g = player.group;
  g.position.x += crashFx.vx * dt;
  g.position.y += crashFx.vy * dt;
  crashFx.vy -= 22 * dt;
  g.rotation.x += crashFx.spinX * dt;
  g.rotation.y += crashFx.spinY * dt;
  g.rotation.z += crashFx.spinZ * dt;

  // Keep the tumbling body above the road. The car rotates around its
  // base point, so a naive y >= 0 clamp lets half of it swing through
  // the asphalt. Instead, project the rotated bounding box (half
  // extents 0.95 × 0.7 × 2.25 around a centre 0.7 up) onto the up axis
  // and rest the car on its lowest point — it can even settle on its
  // roof at the right height.
  _rotM.makeRotationFromEuler(g.rotation);
  _rotM.extractBasis(_bx, _by, _bz);
  const support = 0.95 * Math.abs(_bx.y) + 0.7 * Math.abs(_by.y) +
                  2.25 * Math.abs(_bz.y);
  const lowest = g.position.y + 0.7 * _by.y - support;
  if (lowest < 0) {
    g.position.y -= lowest;
    if (crashFx.vy < 0) {
      crashFx.vy *= -0.35;
      crashFx.vx *= 0.7;
    }
    const damp = Math.max(0, 1 - 4 * dt);   // stop tumbling once grounded
    crashFx.spinX *= damp;
    crashFx.spinY *= damp;
    crashFx.spinZ *= damp;
  }
  player.x = g.position.x;   // the camera keeps tracking the wreck

  flash.position.set(g.position.x, 1.2, g.position.z);
  flash.intensity =
    Math.max(0, 4.5 - crashFx.t * 4) * (0.7 + Math.random() * 0.6);

  if (crashFx.t < 5.5) {     // fireball puffs first, then grey smoke
    crashFx.emit -= dt;
    if (crashFx.emit <= 0) {
      crashFx.emit = 0.07;
      spawnSmoke(g.position.x, 0.9, g.position.z, crashFx.t < 0.45);
    }
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

function tone(freq, dur, type, vol, slide, at) {
  if (!actx) return;
  const t = actx.currentTime + (at || 0);
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

/* --- police siren: one oscillator wailing between two notes --- */

function startSiren() {
  if (!actx || siren) return;
  const o = actx.createOscillator();
  o.type = 'triangle';
  const g = actx.createGain();
  g.gain.value = 0;
  o.connect(g);
  g.connect(master);
  o.start();
  siren = { o, g };
}

function stopSiren() {
  if (!siren) return;
  const s = siren;
  siren = null;
  s.g.gain.setTargetAtTime(0, actx.currentTime, 0.1);
  setTimeout(() => s.o.stop(), 500);
}

function updateSiren() {
  if (!siren || !cops.length || !actx) return;
  const t = actx.currentTime;
  const freq = Math.floor(cops[0].t * 1.4) % 2 ? 660 : 990;   // wee-woo
  siren.o.frequency.setTargetAtTime(freq, t, 0.03);
  // louder the closer the nearest cruiser gets
  let minZ = 42;
  for (const c of cops) minZ = Math.min(minZ, Math.abs(c.z));
  const vol = THREE.MathUtils.clamp(0.07 - (minZ / 42) * 0.055, 0.015, 0.08);
  siren.g.gain.setTargetAtTime(vol, t, 0.1);
}

function noiseBurst(dur, from, to, vol, band, at) {
  if (!actx) return;
  const t = actx.currentTime + (at || 0);
  const buf = actx.createBuffer(1, actx.sampleRate * dur, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 1.4;
  }
  const src = actx.createBufferSource();
  src.buffer = buf;
  const f = actx.createBiquadFilter();
  f.type = band || 'lowpass';
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
  f.Q.value = band === 'bandpass' ? 1.5 : 0.8;
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t);
}

// A crash is several sounds layered, like the real thing
function sfxCrash() {
  tone(65, 0.5, 'sine', 0.55, -35);                     // deep impact thump
  noiseBurst(0.75, 900, 110, 0.5);                      // metal crunch
  noiseBurst(0.3, 5200, 2400, 0.22, 'bandpass', 0.04);  // glass shatter
  noiseBurst(0.4, 480, 90, 0.3, 'lowpass', 0.5);        // the wreck lands
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
  if (e.target && e.target.tagName === 'INPUT') {   // typing a place name
    if (e.key === 'Enter') {
      startTownDrive();
      e.preventDefault();
    }
    return;
  }
  ensureAudio();
  const k = keyName(e);
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.key === ' ' && state === STATE.PLAYING) {
    deployOil();                 // defensive maneuver!
    e.preventDefault();
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (state === STATE.MENU) startGame();
    else if (state === STATE.OVER && ui.gameover.classList.contains('hidden') === false) startGame();
    e.preventDefault();
  }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    if (state === STATE.TOWN) exitTown();
    else togglePause();
  }
  if (e.key === 'h' || e.key === 'H') honk();
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
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
  if (state !== STATE.PLAYING && state !== STATE.TOWN) return;
  if (e.clientX < window.innerWidth / 2) touch.left = true;
  else touch.right = true;
});
window.addEventListener('pointerup', () => {
  touch.left = touch.right = false;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === STATE.PLAYING) togglePause();
});

/* -------- 9b. Town Drive: real roads from OpenStreetMap -------- */
// Type a real place on the menu; roads + buildings are fetched from
// the free OpenStreetMap APIs and built as a drivable world.
// (Google Maps doesn't allow extracting its road data — OSM does.)

const TOWN_X = 6000;   // the town is built far from the highway world
let townGroup = null;
const town = { x: 0, z: 0, heading: 0, speed: 0, coins: [] };
const unitBox = new THREE.BoxGeometry(1, 1, 1);

// tiny synthetic map for offline testing (?osmtest=1)
const OSM_SAMPLE = { elements: [
  { tags: { highway: 'residential' },
    geometry: [{ lat: -0.003, lon: 0 }, { lat: 0.003, lon: 0 }] },
  { tags: { highway: 'residential' },
    geometry: [{ lat: 0, lon: -0.003 }, { lat: 0, lon: 0.003 }] },
  { tags: { highway: 'primary' },
    geometry: [{ lat: -0.002, lon: -0.003 }, { lat: 0.002, lon: 0.003 }] },
  { tags: { building: 'yes' },
    geometry: [{ lat: 0.0004, lon: 0.0004 }, { lat: 0.0009, lon: 0.0004 },
               { lat: 0.0009, lon: 0.0009 }, { lat: 0.0004, lon: 0.0009 }] },
  { tags: { building: 'yes' },
    geometry: [{ lat: -0.0008, lon: 0.0005 }, { lat: -0.0004, lon: 0.0005 },
               { lat: -0.0004, lon: 0.0011 }, { lat: -0.0008, lon: 0.0011 }] },
] };

// Several public Overpass servers exist; some reject requests from a
// "null" origin (a game opened straight from a file), so try each in
// turn with a plain GET until one answers.
async function fetchOverpass(query) {
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  let lastErr = null;
  for (const url of mirrors) {
    try {
      const r = await fetch(url + '?data=' + encodeURIComponent(query));
      if (r.ok) return await r.json();
      lastErr = new Error(`${url} → HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;   // CORS/network — try the next mirror
    }
  }
  throw lastErr || new Error('no Overpass mirror answered');
}

async function startTownDrive() {
  const q = ui.townInput.value.trim();
  if (!q && !DEV.has('osmtest')) {
    ui.townStatus.textContent = 'Type a place first!';
    return;
  }
  try {
    let lat = 0;
    let lon = 0;
    if (!DEV.has('osmtest')) {
      ui.townStatus.textContent = `🔍 Finding ${q}…`;
      const g = await fetch('https://nominatim.openstreetmap.org/search' +
        '?format=json&limit=1&q=' + encodeURIComponent(q))
        .then((r) => r.json());
      if (!g.length) {
        ui.townStatus.textContent = '😿 Could not find that place — try another!';
        return;
      }
      lat = Number(g[0].lat);
      lon = Number(g[0].lon);
    }
    ui.townStatus.textContent = '🛣️ Downloading the streets…';
    let data = OSM_SAMPLE;
    if (!DEV.has('osmtest')) {
      const R = 0.0055;   // roughly a 600 m square around the spot
      const bbox = `${lat - R},${lon - R * 1.5},${lat + R},${lon + R * 1.5}`;
      const query = '[out:json][timeout:20];(' +
        `way["highway"~"^(primary|secondary|tertiary|residential|` +
        `unclassified|living_street|service|pedestrian)$"](${bbox});` +
        `way["building"](${bbox}););out geom;`;
      data = await fetchOverpass(query);
    }
    buildTown(data, lat, lon);
    ui.townStatus.textContent = 'Map data © OpenStreetMap contributors';
    enterTown();
  } catch (err) {
    ui.townStatus.textContent =
      '😿 Map servers would not answer — wait a minute and try again!';
  }
}

function buildTown(data, lat0, lon0) {
  if (townGroup) {
    scene.remove(townGroup);
    townGroup.traverse((o) => { if (o.isMesh && o.geometry !== unitBox) o.geometry.dispose(); });
  }
  town.coins = [];
  townGroup = new THREE.Group();
  townGroup.position.set(TOWN_X, 0, 0);
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const toXZ = (la, lo) => [(lo - lon0) * 111320 * cosLat,
                            -(la - lat0) * 110540];

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshStandardMaterial({ color: 0x4a8040, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  townGroup.add(ground);

  const bldMat = new THREE.MeshStandardMaterial(
    { color: 0xb9b2a4, roughness: 0.85 });
  const coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.09, 16);
  const verts = [];
  let spawnSet = false;
  let buildings = 0;

  for (const el of data.elements || []) {
    if (!el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map((p) => toXZ(p.lat, p.lon));

    if (el.tags && el.tags.building) {
      if (buildings++ > 400) continue;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const [x, z] of pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      const w = maxX - minX;
      const d = maxZ - minZ;
      if (w < 3 || d < 3 || w > 90 || d > 90) continue;
      const h = el.tags['building:levels'] * 3 || 5 + Math.random() * 7;
      const m = new THREE.Mesh(unitBox, bldMat);
      m.scale.set(w, h, d);
      m.position.set((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
      townGroup.add(m);
      continue;
    }

    // road ribbon: a quad per segment, all in one geometry
    const wRoad = /primary|secondary/.test(el.tags && el.tags.highway)
      ? 9 : 6.5;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * wRoad / 2;
      const nz = (dx / len) * wRoad / 2;
      verts.push(
        x1 + nx, 0, z1 + nz, x2 + nx, 0, z2 + nz, x2 - nx, 0, z2 - nz,
        x1 + nx, 0, z1 + nz, x2 - nx, 0, z2 - nz, x1 - nx, 0, z1 - nz);
      if (Math.random() < 0.18 && town.coins.length < 70) {
        const c = new THREE.Mesh(coinGeo, coinMat ||
          (coinMat = new THREE.MeshStandardMaterial(
            { color: 0xffd34d, emissive: 0xbb8800, emissiveIntensity: 0.6,
              metalness: 0.8, roughness: 0.25 })));
        c.rotation.x = Math.PI / 2;
        c.position.set((x1 + x2) / 2, 1, (z1 + z2) / 2);
        townGroup.add(c);
        town.coins.push({ m: c, x: (x1 + x2) / 2, z: (z1 + z2) / 2,
                          taken: false });
      }
      if (!spawnSet) {
        spawnSet = true;
        town.x = x1;
        town.z = z1;
        town.heading = Math.atan2(dx, -dz);   // face along the street
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  const roads = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.9 }));
  roads.position.y = 0.02;
  townGroup.add(roads);
  scene.add(townGroup);
}

function enterTown() {
  state = STATE.TOWN;
  town.speed = 0;
  ui.menu.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.mirror.classList.add('hidden');
  ui.oilBtn.classList.add('hidden');
  ui.hornBtn.classList.add('hidden');
  ensureAudio();
  startEngine();
  toast('🗺️ TOWN DRIVE — Esc to go back');
}

function exitTown() {
  stopEngine();
  state = STATE.MENU;
  ui.menu.classList.remove('hidden');
  ui.hud.classList.add('hidden');
  resetRun(true);   // put the car back on the endless highway
}

function updateTown(dt) {
  const accel = (keys.up ? 14 : 0) - (keys.down ? 18 : 0);
  town.speed = THREE.MathUtils.clamp(
    town.speed + (accel - town.speed * 0.5) * dt, -7, 22);
  const steer = ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) +
                ((touch.right ? 1 : 0) - (touch.left ? 1 : 0));
  town.heading += steer * dt * 1.9 *
    Math.min(1, Math.abs(town.speed) / 7) * Math.sign(town.speed || 1);

  const fx = Math.sin(town.heading);
  const fz = -Math.cos(town.heading);
  town.x = THREE.MathUtils.clamp(town.x + fx * town.speed * dt, -1000, 1000);
  town.z = THREE.MathUtils.clamp(town.z + fz * town.speed * dt, -1000, 1000);

  const px = TOWN_X + town.x;
  const pz = town.z;
  player.group.position.set(px, 0, pz);
  player.group.rotation.set(0, -town.heading, 0);
  const spin = (town.speed / 0.34) * dt;
  for (const w of player.group.userData.wheels) w.rotation.x -= spin;

  camera.position.set(px - fx * 9.5, 4.6, pz - fz * 9.5);
  camera.lookAt(px + fx * 5, 1.0, pz + fz * 5);
  if (camera.fov !== 62) { camera.fov = 62; camera.updateProjectionMatrix(); }

  for (const c of town.coins) {
    if (c.taken) continue;
    c.m.rotation.y += 3.5 * dt;
    if (Math.hypot(c.x - town.x, c.z - town.z) < 2.6) {
      c.taken = true;
      c.m.visible = false;
      coins++;
      ui.coins.textContent = coins;
      tone(1319, 0.08, 'triangle', 0.09);
      tone(1760, 0.12, 'triangle', 0.09, 0, 0.06);
    }
  }

  updateEngine(Math.abs(town.speed) * 1.8 + 3);
  ui.speed.textContent = `${Math.round(Math.abs(town.speed) * 3.6)} km/h`;
}

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
  targetSpeed = difficulty.startSpeed;
  curSpeed = menuMode ? 22 : difficulty.startSpeed * 0.4;
  shake = 0;
  crashFx = null;
  player.x = laneX(1);
  player.latVel = 0;
  player.group.position.set(player.x, 0, 0);
  player.group.rotation.set(0, 0, 0);
  player.group.scale.set(1, 1, 1);      // un-crumple
  player.group.visible = true;
  if (flash) flash.intensity = 0;
  for (const s of smokePool) { s.life = 0; s.m.visible = false; }
  for (const d of debrisPool) d.m.visible = false;
  for (const c of cops) {
    c.g.visible = false;
    c.g.rotation.set(0, 0, 0);
    copPool.push(c.g);
  }
  cops = [];
  stopSiren();
  nextCopAt = difficulty.copEvery + Math.random() * 200;
  wanted = 0;
  if (DEV.has('wanted')) wanted = Math.min(3, Number(DEV.get('wanted')) || 0);
  if (DEV.has('copat')) nextCopAt = Number(DEV.get('copat')) || nextCopAt;
  oilCharges = 2;
  tiresBlown = 0;
  setShield(false);
  pickupNext = 250 + Math.random() * 150;
  for (const p of pickups) { p.g.visible = false; pickupPool[p.type].push(p.g); }
  pickups = [];
  for (const st of sticks) { st.g.visible = false; stickPool.push(st.g); }
  sticks = [];
  for (const s of slicks) { s.m.visible = false; slickPool.push(s.m); }
  slicks = [];
  updateWantedHud();
  updateOilHud();
  level = 1;
  ui.level.textContent = '1';
  slowMoT = 0;
  jamT = 0;
  coins = 0;
  ui.coins.textContent = '0';
  combo = 0;
  comboT = -10;
  coinNext = 120 + Math.random() * 80;
  for (const c of activeCoins) { c.g.visible = false; coinPool.push(c.g); }
  activeCoins = [];
  hideHeli();
  rain.active = false;
  rain.fade = 0;
  rain.until = 0;
  rain.nextAt = 35 + Math.random() * 40;
  if (rain.mesh) { rain.mesh.visible = false; rain.mat.opacity = 0; }
  if (roadMat) { roadMat.roughness = 0.93; roadMat.color.setRGB(1, 1, 1); }
  stopRainSound();
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
  ui.mirror.classList.remove('hidden');
  ui.oilBtn.classList.remove('hidden');
  ui.hornBtn.classList.remove('hidden');
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

function crash(n, busted) {
  state = STATE.OVER;
  stopEngine();
  stopSiren();
  sfxCrash();
  shake = 1.4;
  const hitX = (player.x + n.x) / 2;
  const hitZ = n.z / 2;
  explode(hitX, 0.9, hitZ);
  launchDebris(hitX, 0.8, hitZ);

  // the car you hit is shoved aside, spins out, hazards on
  const away = Math.sign(n.x - player.x) || 1;
  n.hit = true;
  n.hazT = 0;
  n.vx = away * (2.5 + Math.random() * 2);
  n.vz = -(4 + Math.random() * 4);
  n.spinY = away * (2 + Math.random() * 2.5);

  // your car crumples and is thrown the other way
  player.group.scale.set(1.04, 0.93, 0.88);
  crashFx = { t: 0, emit: 0,
    vx: -away * (2.5 + Math.random() * 2), vy: 5.5,
    spinX: (Math.random() - 0.5) * 6,
    spinY: -away * (2.5 + Math.random() * 3),
    spinZ: (Math.random() - 0.5) * 6 };

  ui.overTitle.textContent = busted ? 'BUSTED!' : 'CRASHED!';
  const prevBest = best;
  if (score > best) {
    best = score;
    localStorage.setItem('turboRush3dBest', best);
    ui.newBest.classList.remove('hidden');
  } else {
    ui.newBest.classList.add('hidden');
  }
  ui.finalScore.textContent =
    `Score ${score} · ${(distance / 1000).toFixed(2)} km · 🪙 ${coins} · ${difficulty.label}`;
  const RANKS = [[8000, 'TRAFFIC LEGEND'], [4000, 'TURBO CHAMPION'],
    [2000, 'HIGHWAY HERO'], [800, 'STREET RUNNER'], [0, 'ROOKIE RACER']];
  ui.rank.textContent = `RANK: ${RANKS.find((r) => score >= r[0])[1]}`;

  // crossing a milestone unlocks a paint job — Whiskers announces it
  let unlockMsg = '';
  for (const [name, thr] of Object.entries(PAINT_UNLOCKS)) {
    if (prevBest < thr && best >= thr) {
      unlockMsg = `"🔓 New paint unlocked: ${name.toUpperCase()}! Fancy."`;
    }
  }
  updatePaintLocks();
  const QUOTES = busted
    ? ['"BUSTED! Justice is served. 🐾"',
       '"The law always wins. Meow."',
       '"Straight to cat jail. No treats for you."',
       '"I never miss. I am a cat."']
    : ['"You almost got away... almost!"',
       '"Nice driving, citizen!"',
       '"I was watching the WHOLE time."',
       '"My grandma drives faster. She is also a cat."',
       '"Try the boost — I dare you!"',
       '"See you on the highway!"'];
  ui.cheer.textContent = unlockMsg ||
    QUOTES[(Math.random() * QUOTES.length) | 0];
  setTimeout(() => {
    if (state === STATE.OVER) ui.gameover.classList.remove('hidden');
  }, 2200);
}

function updatePlayer(dt) {
  const left = keys.left || touch.left;
  const right = keys.right || touch.right;
  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  let grip = tiresBlown > 0 ? 0.5 : 1;     // blown tires barely steer
  if (rain.fade > 0.5) grip *= 0.8;        // wet road is slippery
  if (dir) {
    player.latVel += dir * STEER_ACCEL * grip * dt;
  } else {
    player.latVel -= player.latVel * Math.min(1, 10 * dt);
  }
  player.latVel = THREE.MathUtils.clamp(
    player.latVel, -STEER_MAX * grip, STEER_MAX * grip);
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
  if (state !== STATE.PLAYING) return;   // the cop may have busted us already
  for (const n of npcs) {
    if (Math.abs(n.z) > 8 || n.hit) continue;
    const hitW = (PLAYER_HALF_W + n.halfW) - 0.25;   // small forgiveness
    const hitL = (PLAYER_HALF_L + n.halfL) - 0.35;
    if (Math.abs(n.x - player.x) < hitW && Math.abs(n.z) < hitL) {
      if (shielded) {
        // the shield takes the hit: the other car is knocked away
        setShield(false);
        const away = Math.sign(n.x - player.x) || 1;
        n.hit = true;
        n.hazT = 0;
        n.vx = away * 4;
        n.vz = -6;
        n.spinY = away * 4;
        shake = Math.max(shake, 0.5);
        noiseBurst(0.5, 900, 150, 0.4);
        toast('🛡 SHIELD SAVED YOU!');
        continue;
      }
      crash(n);
      return;
    }
  }
}

function updateCamera(dt) {
  if (DEV.has('helicam') && heli) {   // debug: admire the pilot
    camera.position.set(heli.x + 3.2, heli.y + 0.6, heli.z + 6.5);
    camera.lookAt(heli.x, heli.y + 0.2, heli.z);
    return;
  }
  const targetX = player.x * 0.6;
  camera.position.x += (targetX - camera.position.x) * Math.min(1, 5 * dt);
  camera.position.y = 4.4;
  camera.position.z = 8.5;
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    camera.position.x += (Math.random() - 0.5) * shake * 0.7;
    camera.position.y += (Math.random() - 0.5) * shake * 0.5;
  }
  if (state === STATE.OVER) {
    camera.lookAt(player.x * 0.9, 0.8, player.group.position.z);
  } else {
    camera.lookAt(player.x * 0.85, 1.1, -14);
  }
  const fov = 60 + Math.max(0, curSpeed - difficulty.startSpeed) * 0.28;
  if (Math.abs(camera.fov - fov) > 0.1) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const rawDt = Math.min(clock.getDelta(), 0.05);
  let dt = rawDt;
  if (state === STATE.OVER && crashFx) {
    crashFx.t += rawDt;
    // brief slow motion right after impact, then back to full speed
    dt = rawDt * (crashFx.t < 0.7 ? 0.35
      : Math.min(1, 0.35 + (crashFx.t - 0.7) * 1.1));
  }

  if (state === STATE.MENU) {
    // attract mode: the world cruises along behind the menu
    curSpeed = 22;
    scrollWorld(curSpeed * dt);
    updateNpcs(dt, curSpeed, false);
    updateCamera(dt);
  } else if (state === STATE.PLAYING) {
    elapsed += dt;

    // levels: every 1500 m the world gets faster and denser
    const lvl = Math.floor(distance / (Number(DEV.get('lvlm')) || 1500)) + 1;
    if (lvl !== level) {
      level = lvl;
      ui.level.textContent = level;
      toast(`LEVEL ${level}!`);
      tone(520, 0.3, 'triangle', 0.12, 400);
    }
    targetSpeed = Math.min(difficulty.maxSpeed + (level - 1) * 2,
      difficulty.startSpeed + difficulty.ramp * elapsed + (level - 1) * 2);

    if (tiresBlown > 0) updateBlownTires(dt);
    const want = targetSpeed *
      (keys.up ? BOOST_MULT : keys.down ? BRAKE_MULT : 1) *
      (tiresBlown > 0 ? 0.55 : 1);
    curSpeed += THREE.MathUtils.clamp(want - curSpeed, -38 * dt, 16 * dt);

    // slow-motion power-up: the world runs slow, your reflexes don't
    slowMoT = Math.max(0, slowMoT - dt);
    jamT = Math.max(0, jamT - dt);
    const wdt = slowMoT > 0 ? dt * 0.45 : dt;

    distance += curSpeed * wdt;
    score = Math.floor(distance * difficulty.scoreMult) + bonus;

    if (distance > pickupNext) {
      spawnPickup();
      pickupNext = Math.max(pickupNext, distance) + 300 + Math.random() * 250;
    }
    if (distance > coinNext) {
      spawnCoinRow();
      coinNext = Math.max(coinNext, distance) + 130 + Math.random() * 120;
    }

    // rainbow trail while boosting
    if (keys.up && curSpeed > 5) {
      rainbowHue += dt * 1.5;
      trailT -= dt;
      if (trailT <= 0) {
        trailT = 0.05;
        const c = new THREE.Color().setHSL(rainbowHue % 1, 0.95, 0.6);
        spawnSmoke(player.x - 0.5, 0.45, 2.5, false, c.getHex());
        spawnSmoke(player.x + 0.5, 0.45, 2.5, false, c.getHex());
      }
    }

    scrollWorld(curSpeed * wdt);
    updatePlayer(dt);
    updateNpcs(wdt, curSpeed, true);
    updateCops(wdt, curSpeed);
    updateWorldItems(wdt, curSpeed, true);
    updateCoins(wdt, curSpeed, true);
    updateHeli(wdt, curSpeed);
    updateRain(dt, curSpeed);
    checkCollisions();
    updateEngine(curSpeed);
    updateCamera(dt);
    updateFxTag();

    ui.score.textContent = score;
    ui.speed.textContent = `${Math.round(curSpeed * 3.6)} km/h`;
  } else if (state === STATE.OVER) {
    // the world doesn't freeze: your wreck grinds to a halt while the
    // traffic around it keeps living — cars brake behind the crash,
    // oncoming traffic streams past
    curSpeed = Math.max(0, curSpeed - 26 * dt);
    scrollWorld(curSpeed * dt);
    updateNpcs(dt, curSpeed, false);
    updateCops(dt, curSpeed);
    updateWorldItems(dt, curSpeed, false);
    updateCoins(dt, curSpeed, false);
    updateHeli(dt, curSpeed);     // it hovers over the wreck
    updateRain(dt, curSpeed);
    updateCrashFx(dt);
    updateCamera(dt);
  } else if (state === STATE.TOWN) {
    updateTown(dt);
  }

  // the rainbow paint job shimmers through the hues
  if (paintName === 'rainbow' && player.group) {
    player.group.userData.paint.color.setHSL(
      (clock.elapsedTime * 0.25) % 1, 0.9, 0.5);
  }

  if (state !== STATE.PAUSED) applyDayNight(dt);
  updateParticles(dt);
  updateSmoke(dt);
  updateDebris(dt);

  renderer.shadowMap.needsUpdate = true;
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  if (DEV.has('mirrorfull')) {   // debug: show the mirror cam fullscreen
    mirrorCam.aspect = window.innerWidth / window.innerHeight;
    mirrorCam.updateProjectionMatrix();
    mirrorCam.position.set(player.x, 2.5, -0.6);
    mirrorCam.lookAt(player.x, 0.2, 26);
    renderer.render(scene, mirrorCam);
    return;
  }
  renderer.render(scene, camera);

  // rear-view mirror: a second, small render looking backwards
  if (state !== STATE.MENU && state !== STATE.TOWN &&
      !DEV.has('nomirror')) {
    const mw = THREE.MathUtils.clamp(window.innerWidth * 0.3, 200, 400);
    const mh = mw / 3.2;
    const mx = (window.innerWidth - mw) / 2;
    const my = window.innerHeight - 78 - mh;   // 78px from the top edge
    mirrorCam.position.set(player.x, 2.5, -0.6);
    mirrorCam.lookAt(player.x, 0.2, 26);   // watch the road right behind you
    renderer.setScissorTest(true);
    renderer.setViewport(mx, my, mw, mh);
    renderer.setScissor(mx, my, mw, mh);
    renderer.render(scene, mirrorCam);
    renderer.setScissorTest(false);
  }
}

/* ---------------- Loading sequence ---------------- */

const LOAD_STEPS = [
  ['Igniting the engine…', initRenderer],
  ['Paving the highway…', initWorld],
  ['Building your car…', () => { initCarShared(); initPlayer(); }],
  ['Hiring NPC drivers…', () => {
    initParticles();
    initSmoke();
    initDebris();
    resetRun(true);   // also seeds traffic for the menu's attract mode
  }],
  ['Final checks…', () => {
    ui.bestEl.textContent = best;
    setPaint(paintName);   // apply the saved paint to the built car
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
$('oilBtn').addEventListener('click', () => { ensureAudio(); deployOil(); });
$('hornBtn').addEventListener('click', () => { ensureAudio(); honk(); });
$('townBtn').addEventListener('click', () => {
  ensureAudio();
  startTownDrive();
});

document.querySelectorAll('.paint').forEach((b) =>
  b.addEventListener('click', () => { setPaint(b.dataset.p); b.blur(); }));
setPaint(localStorage.getItem('turboRushPaint') || 'red', true);
updatePaintLocks();
drawCatFace();

function setDifficulty(key) {
  difficulty = DIFFICULTIES[key] || DIFFICULTIES.normal;
  localStorage.setItem('turboRush3dDiff', key in DIFFICULTIES ? key : 'normal');
  document.querySelectorAll('.diff').forEach((b) =>
    b.classList.toggle('selected', DIFFICULTIES[b.dataset.diff] === difficulty));
}

document.querySelectorAll('.diff').forEach((b) =>
  b.addEventListener('click', () => { setDifficulty(b.dataset.diff); b.blur(); }));

setDifficulty(localStorage.getItem('turboRush3dDiff') || 'normal');

runLoader(0);
