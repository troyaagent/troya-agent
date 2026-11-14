// Hero "Troy at night": a neoclassical hall on a misty plaza, and a giant rearing horse in banded blue chrome in front of it.
// Everything is built in Three.js. The horse is a GLB (/img/hero/horse.glb) when present; until then a banded placeholder stands in.
// The bands (like the planks of a wooden horse) come from a world-space shader on any mesh, so a fresh model gets them for free.
import * as THREE from "three";

const canvases = [...document.querySelectorAll("[data-hero-troy]")];
canvases.forEach(mount);

/* ---------- lighting environment for reflections ---------- */
function makeEnv(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010304);
  const strip = (w, h, color, k, x, y, z, ry = 0, rx = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); scene.add(m);
  };
  strip(40, 14, 0xd8f7ff, 2.0, 0, 11, -2, 0, Math.PI / 2);
  strip(8, 30, 0x5fd3ef, 2.2, -14, 0, 0, Math.PI / 2);
  strip(6, 30, 0x8ee6ff, 1.8, 14, 0, 0, -Math.PI / 2);
  strip(40, 14, 0x1a6f82, 1.2, 0, -11, 0, 0, -Math.PI / 2);
  strip(40, 20, 0x2a6b7c, 0.9, 0, 0, -14);
  strip(10, 3, 0xffffff, 3.4, 6, 6, 10, -0.6, 0.3);
  strip(30, 1.2, 0xffffff, 2.0, 0, 2, 12, 0, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.035).texture;
  pm.dispose();
  return tex;
}

/* ---------- the footer mark's studio: the horse mirrors this, so hero and footer horse look the same ---------- */
function studioEnv(renderer) {
  const env = new THREE.Scene();
  const add = (w, h, c, k, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; env.add(m); };
  // softer than the footer studio (owner: a little less contrast and brightness): dimmer highlights, darks lifted to a deep teal
  env.background = new THREE.Color(0x031014);
  add(30, 10, 0xd8f7ff, 1.4, 0, 9, -2); add(6, 20, 0x5fd3ef, 1.35, -10, 0, 2, Math.PI / 2); add(6, 20, 0x8ee6ff, 1.1, 10, 0, 2, -Math.PI / 2); add(10, 4, 0xffffff, 2.0, 4, 3, 9, -0.5); add(30, 14, 0x2a7487, 0.8, 0, 0, -10); add(30, 10, 0x0a4d5b, 1.0, 0, -9, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  return tex;
}

/* ---------- banded chrome (planks) ---------- */
function bandedChrome(uniforms, seams = true) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xc4f0fb, metalness: 1, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.12,
    iridescence: 0.35, iridescenceIOR: 1.4, iridescenceThicknessRange: [200, 480], envMapIntensity: 2.1,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uBand = uniforms.uBand;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uBand;")
      // planks: thin dark seams every uBand units of height, each plank slightly rounded so it catches light on its top edge
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        float bandY = vWPos.y / uBand;
        float f = fract(bandY);
        float seam = ${seams ? "smoothstep(0.0, 0.07, f) * smoothstep(1.0, 0.93, f)" : "1.0"};
        roughnessFactor = mix(0.65, roughnessFactor, seam);
        diffuseColor.rgb *= mix(0.3, 1.0, seam);
        // a slow sweep of light running up the planks
        float sweep = smoothstep(0.0, 1.0, 1.0 - abs(fract(bandY * 0.02 - uTime * 0.05) - 0.5) * 6.0);
        diffuseColor.rgb += vec3(0.25, 0.55, 0.65) * sweep * 0.35 * seam;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        ${seams ? "float fb = fract(vWPos.y / uBand); normal = normalize(normal + vec3(0.0, (fb - 0.5) * 0.6, 0.0));" : ""}`);
  };
  return mat;
}

/* ---------- the hall ---------- */
function buildHall() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x36575f, roughness: 0.64, metalness: 0.2, envMapIntensity: 0.85 });
  const stoneLite = new THREE.MeshStandardMaterial({ color: 0x4d7783, roughness: 0.5, metalness: 0.28, envMapIntensity: 1.0 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x041014, roughness: 0.25, metalness: 0.6, emissive: new THREE.Color(0x15596a), emissiveIntensity: 1.15 });
  const box = (w, h, d, x, y, z, m = stone) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y + h / 2, z); g.add(o); return o; };

  // steps across the front
  for (let i = 0; i < 7; i++) box(40 - i * 0.6, 0.34, 12 - i * 0.9, 0, i * 0.34, -24 - i * 0.45, i % 2 ? stone : stoneLite);
  const baseY = 7 * 0.34;
  // podium + portico floor
  box(44, 0.6, 9, 0, baseY - 0.6, -32);
  // columns (instanced): shaft + base + capital
  const colX = [-10.5, -6.3, -2.1, 2.1, 6.3, 10.5];
  const H = 10.5;
  const shaftGeo = new THREE.CylinderGeometry(0.62, 0.7, H, 28, 1);
  const shafts = new THREE.InstancedMesh(shaftGeo, stoneLite, colX.length * 2);
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.5, 1.8), stoneLite, colX.length * 2);
  const bases = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.95, 1.0, 0.45, 28), stoneLite, colX.length * 2);
  const m4 = new THREE.Matrix4();
  colX.forEach((x, i) => {
    [-28.6, -31.2].forEach((z, j) => {
      const k = i * 2 + j;
      m4.makeTranslation(x, baseY + H / 2 + 0.45, z); shafts.setMatrixAt(k, m4);
      m4.makeTranslation(x, baseY + H + 0.45 + 0.25, z); caps.setMatrixAt(k, m4);
      m4.makeTranslation(x, baseY + 0.22, z); bases.setMatrixAt(k, m4);
    });
  });
  g.add(shafts, caps, bases);
  const topY = baseY + H + 0.95;
  // entablature + frieze + cornice
  box(25, 1.4, 5.2, 0, topY, -30);
  box(26, 0.45, 5.8, 0, topY + 1.4, -30, stoneLite);
  // pediment
  const tri = new THREE.Shape();
  tri.moveTo(-13, 0); tri.lineTo(13, 0); tri.lineTo(0, 3.6); tri.lineTo(-13, 0);
  const ped = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.25, bevelSegments: 2 }), stone);
  ped.position.set(0, topY + 1.85, -32.5); g.add(ped);
  // the door behind the columns, softly lit
  box(5, 7.5, 0.3, 0, baseY, -34.2, glass);
  // wings with windows and pilasters
  for (const side of [-1, 1]) {
    const cx = side * 27;
    box(30, 13.5, 10, cx, baseY - 0.6, -36);
    box(31, 0.6, 11, cx, baseY + 12.9, -36, stoneLite);           // cornice
    box(30.4, 0.9, 10.4, cx, baseY - 0.6, -36, stoneLite);         // plinth band
    const win = new THREE.InstancedMesh(new THREE.BoxGeometry(2.0, 3.6, 0.25), glass, 12);
    const pil = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 12.5, 0.5), stoneLite, 7);
    let w = 0;
    for (let c = 0; c < 6; c++) {
      const x = cx - 12.5 + c * 5;
      for (const y of [baseY + 2.4, baseY + 8.0]) { m4.makeTranslation(x, y + 1.8, -30.9); win.setMatrixAt(w++, m4); }
    }
    for (let c = 0; c < 7; c++) { m4.makeTranslation(cx - 15 + c * 5, baseY + 6.25, -30.8); pil.setMatrixAt(c, m4); }
    g.add(win, pil);
    // balustrade on the roof line
    const bal = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.2, 1.1, 10), stoneLite, 48);
    for (let i = 0; i < 48; i++) { m4.makeTranslation(cx - 14.6 + i * 0.62, baseY + 13.5 + 0.55, -31.2); bal.setMatrixAt(i, m4); }
    g.add(bal);
    box(30, 0.3, 0.6, cx, baseY + 14.6, -31.2, stoneLite);
  }
  // dome behind the portico
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.8, 3, 40), stone);
  drum.position.set(0, topY + 6.5, -40); g.add(drum);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4.8, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2c515c, roughness: 0.35, metalness: 0.7, envMapIntensity: 1.25 }));
  dome.position.set(0, topY + 8, -40); g.add(dome);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 1.6, 16), stoneLite);
  lantern.position.set(0, topY + 13.4, -40); g.add(lantern);
  return g;
}

/* ---------- placeholder horse (until the GLB exists) ---------- */
async function placeholderHorse(mat) {
  const { SVGLoader } = await import("/vendor/three/addons/loaders/SVGLoader.js");
  const svg = await (await fetch("/img/logo.svg")).text();
  const data = new SVGLoader().parse(svg);
  const grp = new THREE.Group();
  for (const p of data.paths) for (const s of SVGLoader.createShapes(p)) {
    grp.add(new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 110, bevelEnabled: true, bevelThickness: 18, bevelSize: 10, bevelSegments: 6, curveSegments: 24 }), mat));
  }
  const box = new THREE.Box3().setFromObject(grp);
  const c = box.getCenter(new THREE.Vector3());
  grp.children.forEach((m) => m.geometry.translate(-c.x, -box.min.y, -c.z));
  grp.scale.set(0.025, -0.025, 0.025);
  grp.position.y = 12.8;
  return grp;
}
async function loadHorse(mat, glbMat) {
  try {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"), import("/vendor/three/addons/libs/meshopt_decoder.module.js")]);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/img/hero/horse.glb");
    const root = gltf.scene;
    // the model already carries its slats as geometry, so it gets the chrome with the light sweep but no painted seams
    root.traverse((o) => { if (o.isMesh) { o.material = glbMat; o.castShadow = false; } });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = 25 / size.y;                        // monumental: nearly as tall as the hall's roof line
    root.scale.setScalar(s);
    const b2 = new THREE.Box3().setFromObject(root);
    const c = b2.getCenter(new THREE.Vector3());
    root.position.sub(new THREE.Vector3(c.x, b2.min.y, c.z));
    const grp = new THREE.Group(); grp.add(root);
    grp.userData.model = true;
    return grp;
  } catch { return placeholderHorse(mat); }
}

/* ---------- soft beams from the floor lights ---------- */
function beamTexture() {
  const c = document.createElement("canvas"); c.width = 64; c.height = 256;
  const x = c.getContext("2d");
  const gr = x.createLinearGradient(0, 256, 0, 0);
  gr.addColorStop(0, "rgba(140,230,255,0.55)"); gr.addColorStop(0.5, "rgba(95,211,239,0.12)"); gr.addColorStop(1, "rgba(95,211,239,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 64, 256);
  const side = x.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, "rgba(0,0,0,1)"); side.addColorStop(0.5, "rgba(0,0,0,0)"); side.addColorStop(1, "rgba(0,0,0,1)");
  x.globalCompositeOperation = "destination-out"; x.fillStyle = side; x.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ---------- mount ---------- */
async function mount(canvas) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" }); }
  catch { canvas.remove(); return; }
  const narrow = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, narrow ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.32;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030a0e);
  scene.environment = makeEnv(renderer);
  scene.fog = new THREE.FogExp2(0x05121a, 0.0118);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);

  // lights: cool moon, blue uplights at the hall, a rim on the horse
  scene.add(new THREE.HemisphereLight(0x3f8aa0, 0x061216, 0.8));
  const moon = new THREE.DirectionalLight(0xbfefff, 1.7); moon.position.set(-30, 40, 30); scene.add(moon);
  const rim = new THREE.DirectionalLight(0x5fd3ef, 3.0); rim.position.set(25, 12, -20); scene.add(rim);
  for (const x of [-16, -6, 6, 16]) {
    const s = new THREE.SpotLight(0x5fd3ef, 600, 60, 0.42, 0.6, 1.6);
    s.position.set(x, 0.4, -20); s.target.position.set(x * 0.7, 14, -31); scene.add(s, s.target);
  }

  // misty glossy plaza
  const floor = new THREE.Mesh(new THREE.CircleGeometry(160, 64), new THREE.MeshStandardMaterial({ color: 0x08141a, roughness: 0.3, metalness: 0.82, envMapIntensity: 0.9 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  scene.add(buildHall());

  // beams of light rising from the floor lamps
  const bt = beamTexture();
  for (const x of [-16, -6, 6, 16]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(5, 18), new THREE.MeshBasicMaterial({ map: bt, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }));
    b.position.set(x * 0.85, 9, -26.5); scene.add(b);
  }

  // the horse on its plinth
  const uniforms = { uTime: { value: 0 }, uBand: { value: 0.42 } };
  const horseMat = bandedChrome(uniforms);
  // exactly the footer mark's chrome (fx.js mountMark): same material, same studio env, drawn at the footer's exposure (1.5)
  const glbMat = new THREE.MeshPhysicalMaterial({ color: 0xd8f7ff, metalness: 0.92, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.12, iridescence: 0.3, envMapIntensity: 2.2, envMap: studioEnv(renderer), side: THREE.DoubleSide, fog: false });
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 7.8, 0.9, 64), new THREE.MeshStandardMaterial({ color: 0x0b171b, roughness: 0.45, metalness: 0.6, envMapIntensity: 0.9 }));
  plinth.scale.z = 0.62; plinth.position.y = 0.45;
  const stage = new THREE.Group(); stage.add(plinth);
  stage.position.set(narrow ? 0 : 9, 0, -11);
  scene.add(stage);
  for (const [x, z] of [[-6, 6], [6, 5], [0, -7]]) {
    const sp = new THREE.SpotLight(0x8ee6ff, 900, 60, 0.5, 0.55, 1.4);
    sp.position.set(x, 0.6, z); sp.target.position.set(0, 13, 0);
    stage.add(sp, sp.target);
  }
  const horse = await loadHorse(horseMat, glbMat);
  window.__troyReady = true;
  if (horse.userData.model) plinth.visible = false; // the sculpture brings its own base
  else horse.position.y += 0.9;
  // the horse is drawn in its own pass, lit only by the footer's studio env (no scene lights, no fog),
  // so it reads exactly like the footer mark while the hall keeps its moody light
  const horseScene = new THREE.Scene();
  horseScene.environment = scene.environment;   // used only by the placeholder; the GLB chrome carries its own env
  horseScene.fog = scene.fog;
  const hStage = new THREE.Group();
  hStage.position.copy(stage.position);
  horseScene.add(hStage);
  hStage.add(horse);
  // the horse faces +Z in the model; turn it to show its right side, three-quarters toward the camera
  const baseTurn = horse.userData.model ? Math.PI / 2 - 0.55 : -0.35;
  stage.rotation.y = baseTurn;

  // drifting dust in the light
  const N = 500, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 70; pos[i * 3 + 1] = Math.random() * 22; pos[i * 3 + 2] = -30 + Math.random() * 40; }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x8ee6ff, size: 0.07, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  horseScene.add(dust);   // after the horse, so specks in front of it still show

  // camera path: a slow push toward the hall with a gentle drift; the pointer adds parallax
  const look = new THREE.Vector3(narrow ? 0 : 3, 12, -18);
  let px = 0, py = 0, tx = 0, ty = 0;
  addEventListener("pointermove", (e) => { tx = (e.clientX / innerWidth - 0.5); ty = (e.clientY / innerHeight - 0.5); }, { passive: true });

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 48 : 34;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  const clock = new THREE.Clock();
  const frame = () => {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = reduce ? 6 : clock.getElapsedTime();
    uniforms.uTime.value = t;
    px += (tx - px) * 0.04; py += (ty - py) * 0.04;
    const kit = window.__troyKit?.cam?.(t, { narrow });   // content-kit stills and films drive the camera; never set on the site
    if (kit) {
      camera.position.set(...kit.p); look.set(...kit.t);
      if (kit.fov && camera.fov !== kit.fov) { camera.fov = kit.fov; camera.updateProjectionMatrix(); }
      camera.lookAt(look);
      stage.rotation.y = baseTurn + (kit.turn ?? 0);
    } else {
      const push = (Math.sin(t * 0.06) * 0.5 + 0.5);
      camera.position.set(Math.sin(t * 0.05) * 5 + px * 3, 3.2 + push * 1.2 - py * 1.5, 54 - push * 6);
      camera.lookAt(look);
      stage.rotation.y = baseTurn + Math.sin(t * 0.12) * 0.3;
    }
    hStage.rotation.y = stage.rotation.y;
    hStage.visible = !window.__troyKit?.noHorse;   // kit stills of the hall alone (banner)
    dust.rotation.y = t * 0.01;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.toneMappingExposure = 0.7;    // softer than the footer mark (1.5): owner asked for less contrast and brightness
    renderer.render(horseScene, camera);   // depth kept from the first pass, so the hall still sits behind it
    renderer.toneMappingExposure = 1.32;
  };
  frame();
}
