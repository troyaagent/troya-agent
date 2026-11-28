// The Troya horse for the app: one WebGL renderer for the life of the page, motion damped (no snapping to the pointer),
// pixel ratio capped, and it sleeps when it is off screen, behind another view, or the tab is hidden.
import * as THREE from "three";

function studioEnv(renderer) {
  const env = new THREE.Scene();
  const add = (w, h, c, k, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; m.lookAt(0, 0, 0); env.add(m); };
  // a dark studio with a few narrow lights: the body reads as deep gunmetal, only the edges catch light
  env.background = new THREE.Color(0x020b0e);
  add(28.2, 7.3, 0xcfefff, 1.29, 0, 9, -2); add(4.7, 20, 0x5fd3ef, 1.24, -10, 0, 2, Math.PI / 2); add(4.2, 20, 0x8ee6ff, 0.97, 10, 0, 2, -Math.PI / 2); add(8.2, 3.3, 0xffffff, 1.73, 4, 3, 9, -0.5); add(30, 14, 0x1f5666, 0.53, 0, -8, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  return tex;
}

export async function mountHorse(canvas, { base = -0.45, exposure = 0.90 } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); } catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xc0dbe4, metalness: 0.96, roughness: 0.31, clearcoat: 0.61, clearcoatRoughness: 0.14, envMapIntensity: 1.93, envMap: studioEnv(renderer) });
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"), import("/vendor/three/addons/libs/meshopt_decoder.module.js")]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/img/hero/horse.glb?v=light");
  const root = gltf.scene;
  root.traverse((o) => { if (o.isMesh) o.material = mat; });
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  root.scale.setScalar(10 / size.y);
  root.position.sub(new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3()));
  const turn = new THREE.Group(); turn.add(root); scene.add(turn);
  camera.position.set(0, 0.4, 24); camera.lookAt(0, 0, 0);
  const fit = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const need = 10.8 / (2 * Math.tan((28 * Math.PI) / 360));
    camera.position.z = Math.max(need, (need / camera.aspect) * 0.78);
    camera.updateProjectionMatrix();
  };
  fit();
  const ro = new ResizeObserver(fit); ro.observe(canvas);

  // pointer target, followed with critical damping: smooth, never snaps
  let tx = 0, ty = 0, cx = 0, cy = 0, visible = true, awake = true, raf = 0, last = performance.now();
  const onMove = (e) => { tx = e.clientX / innerWidth - 0.5; ty = e.clientY / innerHeight - 0.5; };
  addEventListener("pointermove", onMove, { passive: true });
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }, { threshold: 0.01 });
  io.observe(canvas);
  const onVis = () => wake(); document.addEventListener("visibilitychange", onVis);
  const t0 = performance.now();
  function frame(t) {
    raf = 0;
    if (!visible || !awake || document.hidden) return;
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const k = 1 - Math.exp(-dt * 4.2);              // ~250 ms to settle
    cx += (tx - cx) * k; cy += (ty - cy) * k;
    const idle = reduce ? 0 : Math.sin((t - t0) / 3200) * 0.1;
    turn.rotation.y = base + idle + cx * 0.32;
    turn.rotation.x = cy * 0.07;
    turn.position.y = reduce ? 0 : Math.sin((t - t0) / 2300) * 0.1;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && visible && awake && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  wake();
  return {
    sleep() { awake = false; },
    wake() { awake = true; wake(); },
    dispose() { awake = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); removeEventListener("pointermove", onMove); document.removeEventListener("visibilitychange", onVis); renderer.dispose(); },
  };
}
