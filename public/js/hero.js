// Hero: polished blue-chrome ribbons drifting across a black field (Three.js).
// Each ribbon is a flattened tube along a spline; a vertex shader keeps it breathing.
import * as THREE from "three";

const canvases = [...document.querySelectorAll("[data-hero]")];
if (canvases.length) canvases.forEach(mount);

function makeEnv(renderer) {
  // A dark studio with cool strip lights: gives the chrome its cool blue highlights.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010304);
  const strip = (w, h, color, intensity, x, y, z, ry = 0, rx = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); scene.add(m);
  };
  strip(40, 14, 0xd8f7ff, 1.6, 0, 11, -2, 0, Math.PI / 2);       // broad soft key overhead
  strip(8, 30, 0x5fd3ef, 1.4, -14, 0, 0, Math.PI / 2);            // cyan wall left
  strip(6, 30, 0x8ee6ff, 1.1, 14, 0, 0, -Math.PI / 2);            // ice wall right
  strip(40, 14, 0x0a4d5b, 1.2, 0, -11, 0, 0, -Math.PI / 2);       // teal floor bounce
  strip(40, 20, 0x2a7487, 0.55, 0, 0, -14);                       // back wall
  strip(10, 3, 0xffffff, 3.2, 6, 6, 10, -0.6, 0.3);               // hot spot
  strip(30, 1.2, 0xffffff, 2.6, 0, 2, 12, 0, 0);                   // long specular streak
  strip(5, 2, 0xffb8e0, 0.7, -7, -4, 11, 0.5, 0);                 // faint warm kick for iridescence
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.035).texture;
  pm.dispose();
  return tex;
}

function ribbonCurve(seed, spread) {
  const r = (n) => { const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
  const pts = [];
  const y0 = (r(1) - 0.5) * spread;
  const y1 = (r(2) - 0.5) * spread * 1.6;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const x = -16 + t * 32;
    const y = THREE.MathUtils.lerp(y0, y1, t) + Math.sin(t * Math.PI * (1.2 + r(3))) * (1.2 + r(4) * 1.8);
    const z = Math.cos(t * Math.PI * (0.8 + r(5))) * (1.6 + r(6) * 2) - 2;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
}

function mount(canvas) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); }
  catch { canvas.remove(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = makeEnv(renderer);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 22);

  const variant = canvas.dataset.hero || "main";
  const group = new THREE.Group();
  scene.add(group);

  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9fdcef, metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08,
    iridescence: 0.55, iridescenceIOR: 1.45, iridescenceThicknessRange: [180, 520], envMapIntensity: 1.25,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nattribute float aSeed;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float ph = position.x * 0.18 + aSeed * 6.2831;
        transformed.y += sin(ph + uTime * 0.35) * 0.55 + sin(ph * 2.3 - uTime * 0.21) * 0.18;
        transformed.z += cos(ph * 0.8 + uTime * 0.28) * 0.7;`);
  };

  const addRibbon = (curve, radius, seed, flat = 0.55) => {
    const geo = new THREE.TubeGeometry(curve, 320, radius, 40, false);
    const seeds = new Float32Array(geo.attributes.position.count).fill(seed);
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(1, flat, 0.8);          // flatten into a ribbon
    group.add(mesh);
    return mesh;
  };

  if (variant === "page") {
    for (let i = 0; i < 4; i++) {
      const m = addRibbon(ribbonCurve(i + 1.37, 7), 1.0 + ((i * 37) % 10) / 10 * 1.1, i * 0.173);
      m.rotation.z = (i % 2 ? 1 : -1) * 0.06 * i;
    }
    group.rotation.set(-0.12, 0, -0.32);
    group.position.set(6, 1.5, 0);
  } else {
    // full hero: a dense weave of cables crossing the whole frame, edge to edge, top to bottom.
    // [startY, endY, waves, depth, radius, flat]
    const LANES = [
      [-11, 7, 1.3, 2.4, 2.1, 0.5], [-8, 10, 1.1, 1.6, 1.4, 0.55], [-5, 12, 1.6, 2.8, 1.8, 0.48],
      [-2, 4, 0.9, 1.4, 2.4, 0.42], [1, -6, 1.4, 2.2, 1.6, 0.55], [3, 13, 1.2, 3.0, 1.2, 0.6],
      [6, -2, 1.7, 1.8, 2.0, 0.45], [-13, -1, 1.0, 2.0, 1.7, 0.5], [9, 6, 1.5, 2.6, 1.3, 0.58],
      [-6, -12, 1.2, 1.5, 1.9, 0.5], [12, 0, 1.0, 2.2, 1.5, 0.52], [-9, 3, 2.0, 1.2, 1.0, 0.65],
    ];
    LANES.forEach(([y0, y1, waves, depth, radius, flat], i) => {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const x = -30 + t * 60;
        const y = THREE.MathUtils.lerp(y0, y1, t) + Math.sin(t * Math.PI * waves + i) * (1.4 + (i % 3) * 0.6);
        const z = Math.cos(t * Math.PI * (0.7 + (i % 4) * 0.25) + i * 0.7) * depth - 3 - (i % 3) * 1.2;
        pts.push(new THREE.Vector3(x, y, z));
      }
      addRibbon(new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5), radius, i * 0.173, flat);
    });
    group.rotation.set(-0.1, 0, -0.18);
    group.position.set(2, -0.5, 0);
  }

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener("pointermove", (e) => { mouse.tx = e.clientX / innerWidth - 0.5; mouse.ty = e.clientY / innerHeight - 0.5; }, { passive: true });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the composition on narrow screens
    camera.position.z = w / h < 0.8 ? 34 : w / h < 1.2 ? 27 : 22;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  const clock = new THREE.Clock();
  canvas.style.opacity = "0";
  canvas.style.transition = "opacity 1.6s cubic-bezier(.2,.7,.1,1)";
  let first = true;
  function frame() {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = clock.getElapsedTime();
    uniforms.uTime.value = reduce ? 0 : t;
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;
    group.rotation.y = mouse.x * 0.18;
    group.rotation.x = -0.12 + mouse.y * 0.1;
    renderer.render(scene, camera);
    if (first) { first = false; requestAnimationFrame(() => (canvas.style.opacity = "1")); }
  }
  frame();
}
