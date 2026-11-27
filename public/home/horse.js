// Hero horse: the Troya horse itself (/img/hero/horse.glb), in the exact chrome of the live site's footer mark.
// Transparent canvas, so the page color shows through; turns slowly, follows scroll and the pointer a little.
//
// The still picture under the canvas (/img/logo-3d-hd.*) is the hero until the 3D horse has really drawn a frame.
// Anything that goes wrong (no WebGL, software GL, a shader that fails to compile, a lost context, a failed
// download) removes the canvas and leaves that still in place: never a blank box over the hero.
import * as THREE from "three";

const canvas = document.querySelector("[data-horse3d]");
// Start only after the page has loaded, in idle time when the browser offers it, so building the 3D scene
// never holds up first paint, DOMContentLoaded or the first tap.
if (canvas) {
  const go = () => ("requestIdleCallback" in window ? requestIdleCallback(() => mount(canvas), { timeout: 1500 }) : setTimeout(() => mount(canvas), 150));
  if (document.readyState === "complete") go(); else addEventListener("load", go, { once: true });
}

// Software rasterisers draw this scene at a few frames a second and stall the main thread for seconds;
// on those the still picture looks better than the 3D horse.
const SOFTWARE_GL = /SwiftShader|llvmpipe|softpipe|Software|Microsoft Basic Render/i;

// true only for a hardware WebGL context that the browser does not flag as slow
function gpuOk() {
  const probe = document.createElement("canvas");
  const opts = { failIfMajorPerformanceCaveat: true };
  const gl = probe.getContext("webgl2", opts) || probe.getContext("webgl", opts);
  if (!gl) return false;
  let name = "";
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
  } catch {}
  try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}   // free the probe context right away
  return !SOFTWARE_GL.test(name);
}

function studioEnv(renderer) {
  const env = new THREE.Scene();
  const add = (w, h, c, k, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; env.add(m); };
  env.background = new THREE.Color(0x031014);
  add(30, 10, 0xd8f7ff, 1.4, 0, 9, -2); add(6, 20, 0x5fd3ef, 1.35, -10, 0, 2, Math.PI / 2); add(6, 20, 0x8ee6ff, 1.1, 10, 0, 2, -Math.PI / 2); add(10, 4, 0xffffff, 2.0, 4, 3, 9, -0.5); add(30, 14, 0x2a7487, 0.8, 0, 0, -10); add(30, 10, 0x0a4d5b, 1.0, 0, -9, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return tex;
}

async function mount(canvas) {
  if (!gpuOk()) return;                          // no WebGL, or only a slow/software one: the still picture stays
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // the 920 KB model and its loader wait until the page itself has loaded and the browser is idle: the still picture is the
  // hero until then (owner, 27 Nov 2026: the first load felt heavy; the model used to download alongside the page)
  const afterLoad = new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", () => r(), { once: true })))
    .then(() => new Promise((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 300))));
  const loading = afterLoad.then(() => Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"), import("/vendor/three/addons/libs/meshopt_decoder.module.js")])
    .then(([{ GLTFLoader }, { MeshoptDecoder }]) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/img/hero/horse.glb")));
  loading.catch(() => {});                       // handled below; avoids an unhandled rejection if we bail out first

  let renderer, failed = false, raf = 0, io = null;
  const fail = () => {
    if (failed) return;
    failed = true;
    cancelAnimationFrame(raf);
    io?.disconnect();
    document.documentElement.classList.remove("horse-ready");
    removeEventListener("resize", fit);
    try { renderer?.dispose(); } catch {}
    canvas.remove();                             // the still picture underneath is the hero again
  };

  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true }); } catch { canvas.remove(); return; }
  // a shader that does not compile once left a white box over the hero; drop back to the still instead
  renderer.debug.onShaderError = () => fail();
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); fail(); }, { once: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = canvas.dataset.exposure ? +canvas.dataset.exposure : 0.85;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  let mat, gltf;
  try {
    mat = new THREE.MeshPhysicalMaterial({ color: 0xd8f7ff, metalness: 0.92, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.12, iridescence: 0.3, envMapIntensity: 2.2, envMap: studioEnv(renderer), side: THREE.DoubleSide });
    gltf = await loading;
  } catch { fail(); return; }
  if (failed) return;

  const root = gltf.scene;
  root.traverse((o) => { if (o.isMesh) o.material = mat; });
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  root.scale.setScalar(10 / size.y);
  const b2 = new THREE.Box3().setFromObject(root), c = b2.getCenter(new THREE.Vector3());
  root.position.sub(c);                         // centred on its own middle
  const turn = new THREE.Group(); turn.add(root); scene.add(turn);
  camera.position.set(0, 0.4, 24); camera.lookAt(0, 0, 0);

  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    // keep the whole horse in frame whatever the box shape
    const fov = 28, need = 10.8 / (2 * Math.tan((fov * Math.PI) / 360));
    camera.position.z = Math.max(need, need / camera.aspect * 0.78);
    camera.updateProjectionMatrix();
  }
  fit(); addEventListener("resize", fit);

  let px = 0, py = 0;
  addEventListener("pointermove", (e) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; }, { passive: true });
  const base = canvas.dataset.base ? +canvas.dataset.base : -0.55;   // three-quarter view; pages can turn it
  const t0 = performance.now();
  let drawn = false, visible = true, running = false;
  const loop = (t) => {
    if (failed) return;
    // the frame before this one rendered without a shader error: now it is safe to fade the still out
    if (drawn && !document.documentElement.classList.contains("horse-ready")) document.documentElement.classList.add("horse-ready");
    if (!visible || document.hidden) { running = false; return; }   // off-screen or hidden tab: stop drawing
    const s = Math.min(1, scrollY / (innerHeight || 1));
    const idle = reduce ? 0 : Math.sin((t - t0) / 2600) * 0.12;
    turn.rotation.y = base + idle + s * 1.4 + px * 0.25;
    turn.rotation.x = py * 0.06;
    turn.position.y = reduce ? 0 : Math.sin((t - t0) / 1900) * 0.12;
    renderer.render(scene, camera);
    if (failed) return;
    drawn = true;
    raf = requestAnimationFrame(loop);
  };
  const start = () => { if (running || failed || !visible || document.hidden) return; running = true; raf = requestAnimationFrame(loop); };
  // like the code rain: no frames while the hero is scrolled away or the tab is in the background
  if ("IntersectionObserver" in window) { io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) start(); }); io.observe(canvas); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });
  start();
}
