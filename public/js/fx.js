// Section backdrops (fragment shaders on a full-screen quad) + the 3D horse mark in the footer.
const COMMON = `precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
vec3 blue(float t){ return mix(mix(vec3(.01,.03,.04), vec3(.04,.30,.36), smoothstep(.0,.5,t)), mix(vec3(.25,.72,.83), vec3(.85,.97,1.), smoothstep(.6,1.,t)), smoothstep(.45,1.,t)); }
`;

const SHADERS = {
  // thin blue light streaks drifting sideways
  wisps: `void main(){
    vec2 uv = gl_FragCoord.xy / uRes; vec2 p = uv; p.x *= uRes.x/uRes.y;
    float t = uTime*.05;
    float f = fbm(vec2(p.x*1.1 + t, p.y*3.2 - t*.6) + fbm(p*1.6 + t)*1.4);
    float band = smoothstep(.62,.0, abs(f-.52)*7.0);
    float fine = smoothstep(.0,.9, 1.-abs(sin((p.y + f*.9)*26.0 + t*3.0)));
    float a = band * (.35 + .65*fine) * smoothstep(1.05,.25, uv.x*.6 + (1.-uv.y)*.55);
    vec3 col = blue(.35 + band*.65);
    gl_FragColor = vec4(col * a * .85, a * .85);
  }`,
  // slow vortex of silver-blue arms
  vortex: `void main(){
    vec2 uv = gl_FragCoord.xy / uRes; vec2 c = vec2(.72, .5);
    vec2 p = (uv - c); p.x *= uRes.x/uRes.y;
    float r = length(p); float a = atan(p.y, p.x);
    float t = uTime*.08;
    float arms = sin(a*5.0 + log(r+.02)*6.5 - t*4.0 + fbm(p*3.0+t)*2.2);
    float s = smoothstep(.55, 1.0, arms) * smoothstep(1.2,.05,r) * smoothstep(.0,.12,r);
    float glow = smoothstep(.8,.0,r)*.12;
    vec3 col = blue(.45 + s*.55);
    float alpha = s*.7 + glow;
    gl_FragColor = vec4(col*alpha, alpha);
  }`,
  // dark field with a cold light burst behind the headline
  burst: `void main(){
    vec2 uv = gl_FragCoord.xy / uRes; vec2 p = uv - vec2(.5,.52); p.x *= uRes.x/uRes.y;
    float r = length(p); float a = atan(p.y,p.x);
    float t = uTime*.06;
    float rays = pow(abs(sin(a*7.0 + t + fbm(vec2(a*2.0, t))*2.5)), 18.0);
    rays += .5*pow(abs(sin(a*13.0 - t*1.3)), 30.0);
    float ring = smoothstep(.012,.0, abs(r - .42 - .02*sin(a*3.+t*2.)))*.35;
    float fall = smoothstep(.95,.1,r) * smoothstep(.05,.2,r);
    float v = rays*fall + ring*smoothstep(.0,.6,fbm(vec2(a*3.,t)));
    vec3 col = blue(.4 + clamp(v,0.,1.)*.6);
    col += vec3(.9,.5,.8)*pow(rays*fall, 3.0)*.12;   /* faint prism edge */
    float hole = smoothstep(.06, .5, r);             /* keep the headline area calm */
    float alpha = clamp(v*.62, 0., 1.) * hole;
    gl_FragColor = vec4(col*alpha, alpha);
  }`,
};

function runShader(canvas, body) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, COMMON + body));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, "uRes"), uTime = gl.getUniformLocation(prog, "uTime");
  const scale = 0.5;  // half resolution: soft shapes, cheap on laptops
  const resize = () => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale * Math.min(devicePixelRatio, 2)));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale * Math.min(devicePixelRatio, 2)));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
  let visible = false;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: "100px" }).observe(canvas);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now();
  (function frame() {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, reduce ? 4 : (performance.now() - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  })();
}

document.querySelectorAll("[data-fx]").forEach((c) => SHADERS[c.dataset.fx] && runShader(c, SHADERS[c.dataset.fx]));

// ---- footer mark: the Troya horse (rearing sculpture, /img/hero/horse.glb) in blue chrome, slowly turning ----
const slot = document.querySelector("[data-mark3d]");
if (slot) {
  const io = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    try { await mountMark(slot); } catch (err) { console.warn("mark3d", err); }
  }, { rootMargin: "200px" });
  io.observe(slot);
}

async function mountMark(slot) {
  const THREE = await import("three");
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"), import("/vendor/three/addons/libs/meshopt_decoder.module.js")]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/img/hero/horse.glb?v=light");
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  // environment: same cool studio idea as the hero, smaller
  const env = new THREE.Scene();
  const add = (w, h, c, k, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; env.add(m); };
  add(30, 10, 0xd8f7ff, 1.8, 0, 9, -2); add(6, 20, 0x5fd3ef, 1.6, -10, 0, 2, Math.PI / 2); add(6, 20, 0x8ee6ff, 1.3, 10, 0, 2, -Math.PI / 2); add(10, 4, 0xffffff, 3, 4, 3, 9, -0.5); add(30, 14, 0x2a7487, 0.8, 0, 0, -10); add(30, 10, 0x0a4d5b, 1.0, 0, -9, 0);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.04).texture;
  renderer.toneMappingExposure = 1.5;
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  // centre on the visible part (the clipped base no longer counts)
  const cen = box.getCenter(new THREE.Vector3()); cen.y += size.y * 0.0225;
  root.position.sub(cen);
  const pivot = new THREE.Group();
  pivot.add(root);
  const k = 5.8 / size.y;
  pivot.scale.setScalar(k);
  // the wordmark shows the horse alone: the sculpture's oval base is clipped away (plane in world space, after the move + scale)
  const clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -((box.min.y + size.y * 0.045 - cen.y) * k))];
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xd8f7ff, metalness: 0.92, roughness: 0.2, clearcoat: 1, iridescence: 0.3, envMapIntensity: 2.2, clippingPlanes: clip, side: THREE.DoubleSide });
  root.traverse((o) => { if (o.isMesh) o.material = mat; });
  scene.add(pivot);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 14);
  slot.innerHTML = "";
  slot.append(canvas);
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(canvas);
  resize();
  const clock = new THREE.Clock();
  (function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = clock.getElapsedTime();
    pivot.rotation.y = 1.4 + Math.sin(t * 0.6) * 0.5;   // side view facing right, swaying
    pivot.rotation.x = Math.sin(t * 0.4) * 0.05;
    renderer.render(scene, camera);
  })();
}
