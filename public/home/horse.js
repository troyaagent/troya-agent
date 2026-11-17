// Hero horse: the Troya horse itself (/img/hero/horse.glb), in the exact chrome of the live site's footer mark.
// Transparent canvas, so the page color shows through; turns slowly, follows scroll and the pointer a little.
import * as THREE from "three";

const canvas = document.querySelector("[data-horse3d]");
if (canvas) mount(canvas);

function studioEnv(renderer) {
  const env = new THREE.Scene();
  const add = (w, h, c, k, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; env.add(m); };
  env.background = new THREE.Color(0x031014);
  add(30, 10, 0xd8f7ff, 1.4, 0, 9, -2); add(6, 20, 0x5fd3ef, 1.35, -10, 0, 2, Math.PI / 2); add(6, 20, 0x8ee6ff, 1.1, 10, 0, 2, -Math.PI / 2); add(10, 4, 0xffffff, 2.0, 4, 3, 9, -0.5); add(30, 14, 0x2a7487, 0.8, 0, 0, -10); add(30, 10, 0x0a4d5b, 1.0, 0, -9, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  return tex;
}

async function mount(canvas) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  { const probe = document.createElement("canvas"); if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) return; }   // no WebGL: the still picture stays
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); } catch { return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = canvas.dataset.exposure ? +canvas.dataset.exposure : 0.85;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xd8f7ff, metalness: 0.92, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.12, iridescence: 0.3, envMapIntensity: 2.2, envMap: studioEnv(renderer), side: THREE.DoubleSide });

  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"), import("/vendor/three/addons/libs/meshopt_decoder.module.js")]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/img/hero/horse.glb");
  const root = gltf.scene;
  root.traverse((o) => { if (o.isMesh) o.material = mat; });
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  root.scale.setScalar(10 / size.y);
  const b2 = new THREE.Box3().setFromObject(root), c = b2.getCenter(new THREE.Vector3());
  root.position.sub(c);                         // centred on its own middle
  const turn = new THREE.Group(); turn.add(root); scene.add(turn);
  camera.position.set(0, 0.4, 24); camera.lookAt(0, 0, 0);

  const fit = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    // keep the whole horse in frame whatever the box shape
    const fov = 28, need = 10.8 / (2 * Math.tan((fov * Math.PI) / 360));
    camera.position.z = Math.max(need, need / camera.aspect * 0.78);
    camera.updateProjectionMatrix();
  };
  fit(); addEventListener("resize", fit);
  document.documentElement.classList.add("horse-ready");

  let px = 0, py = 0;
  addEventListener("pointermove", (e) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; }, { passive: true });
  const base = canvas.dataset.base ? +canvas.dataset.base : -0.55;   // three-quarter view; pages can turn it
  const t0 = performance.now();
  const loop = (t) => {
    const s = Math.min(1, scrollY / (innerHeight || 1));
    const idle = reduce ? 0 : Math.sin((t - t0) / 2600) * 0.12;
    turn.rotation.y = base + idle + s * 1.4 + px * 0.25;
    turn.rotation.x = py * 0.06;
    turn.position.y = reduce ? 0 : Math.sin((t - t0) / 1900) * 0.12;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
