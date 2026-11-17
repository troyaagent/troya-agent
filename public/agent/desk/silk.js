// The Desk's room light: chrome-blue satin folds drifting like slow waves behind every page. One fragment shader at
// half resolution (the light is soft, so nobody sees the pixels), stopped when the tab is hidden, when the canvas is
// hidden (light theme) and drawn once for people who ask for reduced motion.
const FRAG = `precision mediump float;
uniform vec2 r; uniform float t; uniform vec2 m;
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * r) / r.y;
  float s = t * 0.045;
  p += (m - 0.5) * vec2(0.08, -0.05);
  vec2 q = p * 1.35;
  q += 0.42 * vec2(sin(q.y * 1.15 + s * 1.6), cos(q.x * 0.95 - s * 1.2));
  q += 0.22 * vec2(sin(q.y * 2.3 - s * 1.1), cos(q.x * 2.1 + s * 0.9));
  float w = sin(q.x * 1.7 + q.y * 0.65 + s * 1.8) + 0.55 * sin(-q.x * 1.05 + q.y * 1.9 - s * 1.3) + 0.25 * sin(q.x * 3.1 - q.y * 1.4 + s * 2.2);
  float fold = 0.5 + 0.5 * sin(w * 1.25);
  float sheen = pow(fold, 7.0);
  float glow = pow(fold, 2.2);
  vec2 c = p - vec2(0.55, 0.28);
  float vig = exp(-dot(c, c) * 1.25);
  float low = exp(-dot(p + vec2(0.9, 0.7), p + vec2(0.9, 0.7)) * 1.8);
  vec3 col = vec3(0.008, 0.013, 0.022);
  col += vec3(0.030, 0.072, 0.105) * glow * (0.35 + 0.85 * vig);
  col += vec3(0.42, 0.74, 0.86) * sheen * 0.22 * vig;
  col += vec3(0.04, 0.08, 0.14) * low * glow * 0.8;
  gl_FragColor = vec4(col, 1.0);
}`;
const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

export function mountSilk(canvas, scale = 0.5) {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "low-power" });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(pr, "a"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pr, "r"), uT = gl.getUniformLocation(pr, "t"), uM = gl.getUniformLocation(pr, "m");
  // phones and tablets get the light drawn once (no animation loop): same look, no battery drain or heat
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches || matchMedia("(pointer: coarse)").matches || innerWidth < 860;
  let tx = 0.5, ty = 0.5, mx = 0.5, my = 0.5, raf = 0, last = performance.now(), time = 8;
  addEventListener("pointermove", (e) => { tx = e.clientX / innerWidth; ty = e.clientY / innerHeight; }, { passive: true });
  const fit = () => { canvas.width = Math.max(2, Math.round(innerWidth * scale)); canvas.height = Math.max(2, Math.round(innerHeight * scale)); gl.viewport(0, 0, canvas.width, canvas.height); draw(); };
  const visible = () => !document.hidden && canvas.offsetParent !== null;
  function draw() { gl.uniform2f(uR, canvas.width, canvas.height); gl.uniform1f(uT, time); gl.uniform2f(uM, mx, my); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  function frame(now) {
    raf = 0;
    if (!visible()) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
    const k = 1 - Math.exp(-dt * 1.6);              // the light follows the pointer slowly
    mx += (tx - mx) * k; my += (ty - my) * k;
    draw();
    raf = requestAnimationFrame(frame);
  }
  const resume = () => { if (still) { if (visible()) draw(); return; } if (!raf && visible()) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  fit(); addEventListener("resize", fit);
  document.addEventListener("visibilitychange", resume);
  resume();
  return { resume };
}
