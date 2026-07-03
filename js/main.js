import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { ARENA_LIST, getArena } from "./arenas.js";
import { PlayerController, RemotePlayer } from "./player.js";
import { Net, randomCode } from "./net.js";

/* =========================================================
   SCREEN ELEMENTS
========================================================= */
const screens = {
  menu: document.getElementById("screen-menu"),
  hostWait: document.getElementById("screen-host-wait"),
  joining: document.getElementById("screen-joining"),
};
const hud = document.getElementById("hud");
const hudHpCorner = document.getElementById("hud-hp-corner");
const canvas = document.getElementById("game-canvas");

function showScreen(name) {
  for (const key in screens) screens[key].classList.toggle("hidden", key !== name);
  canvas.classList.add("hidden");
  hud.classList.add("hidden");
  hudHpCorner.classList.add("hidden");
}
function showGame() {
  for (const key in screens) screens[key].classList.add("hidden");
  canvas.classList.remove("hidden");
  hud.classList.remove("hidden");
  hudHpCorner.classList.remove("hidden");
}

/* =========================================================
   ARENA PICKER (menu)
========================================================= */
const arenaGrid = document.getElementById("arena-grid");
let selectedArenaId = ARENA_LIST[0].id;

for (const arena of ARENA_LIST) {
  const card = document.createElement("button");
  card.className = "arena-card";
  card.dataset.id = arena.id;
  card.innerHTML = `
    <div class="arena-thumb" style="background-image:url('${arena.thumb}')"></div>
    <div class="arena-name">${arena.name}</div>
  `;
  card.addEventListener("click", () => {
    selectedArenaId = arena.id;
    document.querySelectorAll(".arena-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
  });
  arenaGrid.appendChild(card);
}
arenaGrid.firstElementChild.classList.add("selected");

/* =========================================================
   PLAYER NAME
========================================================= */
function getPlayerName() {
  const raw = document.getElementById("player-name-input").value.trim();
  return raw || `Player${Math.floor(Math.random() * 900 + 100)}`;
}

/* =========================================================
   NET
========================================================= */
const net = new Net();
let myColor, oppColor;

/* ---- HOST FLOW ---- */
async function attemptHost() {
  document.getElementById("btn-retry-host").classList.add("hidden");
  document.getElementById("host-code-display").textContent = "------";
  document.getElementById("host-status").textContent = "Getting a code...";

  try {
    const code = await net.host(randomCode());
    document.getElementById("host-code-display").textContent = code;
    document.getElementById("host-status").textContent = "Waiting for opponent...";

    net.onPeerConnected = () => {
      myColor = 0xffffff;   // host = white
      oppColor = 0xff4d6a;  // joiner = candy red
      const myName = getPlayerName();
      net.send({
        t: "arena",
        arenaId: selectedArenaId,
        hostColor: myColor,
        joinColor: oppColor,
        hostName: myName,
      });
      startMatch(selectedArenaId, true, myColor, oppColor, "Opponent");
    };
  } catch (err) {
    console.error("Host failed:", err);
    document.getElementById("host-status").textContent =
      `Failed to host: ${err.message || err.type || "unknown error"} (see console for details)`;
    document.getElementById("btn-retry-host").classList.remove("hidden");
  }
}

document.getElementById("btn-host").addEventListener("click", () => {
  showScreen("hostWait");
  attemptHost();
});

document.getElementById("btn-retry-host").addEventListener("click", () => {
  net.destroy();
  attemptHost();
});

document.getElementById("btn-cancel-host").addEventListener("click", () => {
  net.destroy();
  showScreen("menu");
});

/* ---- JOIN FLOW ---- */
document.getElementById("btn-join").addEventListener("click", () => {
  showScreen("joining");
  document.getElementById("join-status").textContent = "";
});

document.getElementById("btn-join-confirm").addEventListener("click", async () => {
  const code = document.getElementById("join-code-input").value.trim();
  if (code.length !== 6) {
    document.getElementById("join-status").textContent = "Enter the 6-digit code.";
    return;
  }
  document.getElementById("join-status").textContent = "Connecting...";

  net.onData = (msg) => {
    if (msg.t === "arena") {
      myColor = msg.joinColor;
      oppColor = msg.hostColor;
      startMatch(msg.arenaId, false, myColor, oppColor, msg.hostName || "Opponent");
      net.send({ t: "hello", name: getPlayerName() });
    }
  };

  try {
    await net.join(code);
    document.getElementById("join-status").textContent = "Connected. Waiting for arena...";
  } catch (err) {
    console.error("Join failed:", err);
    document.getElementById("join-status").textContent =
      `Couldn't connect: ${err.message || err.type || "unknown error"} (see console for details)`;
  }
});

document.getElementById("btn-cancel-join").addEventListener("click", () => {
  net.destroy();
  showScreen("menu");
});

/* =========================================================
   THREE.JS SETUP (created once, reused across matches)
========================================================= */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0d);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

const textureLoader = new THREE.TextureLoader();

// Loads a texture; on failure (file missing), resolves to null so callers
// fall back to a flat color material instead of breaking the scene.
function loadTextureSafe(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    textureLoader.load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

function makeMaterial(tex, fallbackColor, repeat = [1, 1]) {
  if (tex) {
    tex.repeat.set(repeat[0], repeat[1]);
    return new THREE.MeshStandardMaterial({ map: tex });
  }
  return new THREE.MeshStandardMaterial({ color: fallbackColor });
}

/* =========================================================
   MATCH STATE (rebuilt each time a match starts)
========================================================= */
let local, remote, wallBoxes, floorMesh, arenaObjects = [];
let raycaster = new THREE.Raycaster();
let laser;
let matchActive = false;
let mySpawn, oppSpawn;

let myKills = 0, myDeaths = 0;

async function buildArena(arena) {
  // Clear anything left from a previous match.
  for (const obj of arenaObjects) scene.remove(obj);
  arenaObjects = [];
  wallBoxes = [];

  const [floorTex, wallTex] = await Promise.all([
    loadTextureSafe(arena.textures?.floor),
    loadTextureSafe(arena.textures?.wall),
  ]);

  const floorMat = makeMaterial(floorTex, arena.fallbackColors?.floor ?? 0x222222, [4, 4]);
  const wallMat = makeMaterial(wallTex, arena.fallbackColors?.wall ?? 0x333333, [2, 1]);

  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(arena.floorSize, arena.floorSize), floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  scene.add(floorMesh);
  arenaObjects.push(floorMesh);

  for (const [w, h, d, x, y, z] of arena.walls) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    arenaObjects.push(mesh);
    wallBoxes.push(new THREE.Box3().setFromObject(mesh));
  }

  // Props (pillars / platforms) — each can have its own texture key.
  if (arena.props) {
    const propTexCache = {};
    for (const prop of arena.props) {
      if (!(prop.type in propTexCache)) {
        propTexCache[prop.type] = await loadTextureSafe(arena.textures?.[prop.type]);
      }
      const mat = makeMaterial(
        propTexCache[prop.type],
        arena.fallbackColors?.[prop.type] ?? 0x444444,
        [1, 1]
      );
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(prop.w, prop.h, prop.d), mat);
      mesh.position.set(prop.x, prop.y, prop.z);
      scene.add(mesh);
      arenaObjects.push(mesh);
      wallBoxes.push(new THREE.Box3().setFromObject(mesh));
    }
  }
}

async function startMatch(arenaId, isHost, colorMe, colorOpp, oppName) {
  const arena = getArena(arenaId);
  await buildArena(arena);

  mySpawn = isHost ? arena.spawns[0] : arena.spawns[1];
  oppSpawn = isHost ? arena.spawns[1] : arena.spawns[0];

  if (local) scene.remove(local.mesh);
  if (remote) scene.remove(remote.mesh, remote.hpBar, remote.nameSprite);

  local = new PlayerController(scene, camera, colorMe);
  local.spawn(mySpawn);

  remote = new RemotePlayer(scene, colorOpp, oppName);
  remote.spawn(oppSpawn);

  if (laser) scene.remove(laser);
  laser = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: colorMe })
  );
  scene.add(laser);

  myKills = 0;
  myDeaths = 0;
  updateScoreHud();

  net.onData = handleNetData;
  net.onPeerDisconnected = handleOpponentLeft;

  matchActive = true;
  showGame();
  document.body.requestPointerLock();
}

function handleOpponentLeft() {
  matchActive = false;
  document.exitPointerLock();
  alert("Opponent disconnected.");
  showScreen("menu");
}

function handleNetData(msg) {
  if (msg.t === "state") {
    remote.applyNetState(msg);
  } else if (msg.t === "hit") {
    const died = local.takeDamage(msg.damage);
    if (died) {
      myDeaths++;
      net.send({ t: "died" });
      local.spawn(mySpawn);
      updateScoreHud();
    }
  } else if (msg.t === "died") {
    myKills++;
    updateScoreHud();
  } else if (msg.t === "hello") {
    remote.setName(msg.name);
  }
}

function updateScoreHud() {
  document.getElementById("hud-score").textContent = `Kills ${myKills} · Deaths ${myDeaths}`;
}

/* =========================================================
   INPUT
========================================================= */
const keys = {};
let firing = false;

addEventListener("keydown", (e) => (keys[e.code] = true));
addEventListener("keyup", (e) => (keys[e.code] = false));
addEventListener("mousedown", () => (firing = true));
addEventListener("mouseup", () => (firing = false));
canvas.addEventListener("click", () => {
  if (matchActive) document.body.requestPointerLock();
});

addEventListener("mousemove", (e) => {
  if (!matchActive || document.pointerLockElement !== document.body) return;
  local.yaw -= e.movementX * 0.002;
  local.pitch -= e.movementY * 0.002;
  local.pitch = Math.max(-1.4, Math.min(1.4, local.pitch));
});

/* =========================================================
   MAIN LOOP
========================================================= */
let last = performance.now();
let netSendAccum = 0;
const NET_SEND_INTERVAL = 1 / 20; // 20Hz state sync

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (!matchActive) {
    renderer.render(scene, camera);
    return;
  }

  local.applyInput(keys, firing);
  local.update(dt, wallBoxes, keys.Space);
  remote.update(dt, camera);

  /* Shooting — client-authoritative over its own hits, sent to the
     opponent who applies damage to their own (authoritative) hp. */
  if (firing && remote.visible) {
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir).normalize();
    raycaster.set(origin, dir);

    const targets = [remote.mesh, ...arenaObjects.filter((o) => o !== floorMesh)];
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits[0];
    const end = hit ? hit.point : origin.clone().add(dir.multiplyScalar(50));

    laser.geometry.setFromPoints([origin, end]);
    laser.visible = true;

    if (hit && hit.object === remote.mesh) {
      net.send({ t: "hit", damage: 40 * dt });
    }
  } else {
    laser.visible = false;
  }

  /* Periodic state broadcast */
  netSendAccum += dt;
  if (netSendAccum >= NET_SEND_INTERVAL) {
    netSendAccum = 0;
    net.send({ t: "state", ...local.getNetState() });
  }

  document.getElementById("hud-hp-value").textContent = Math.ceil(local.hp);

  renderer.render(scene, camera);
}

showScreen("menu");
loop();
