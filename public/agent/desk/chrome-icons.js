// Troya chrome icons for the Desk: filled glyphs in the horse's chrome, cut by the same horizontal slices as the logo.
// The gradients (#tc dark theme, #tcl light theme) and the slice mask (#ts) live once in the page; every icon points
// at them. On a light chrome button the CSS turns the fill to dark ink so the icon stays readable.
const NS = "http://www.w3.org/2000/svg";

const G = {
  desk: `<rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2.2"/><rect x="3" y="13" width="8" height="8" rx="2.2"/>`,
  swap: `<path d="M8 2.5 3 7.5h3.4V17h3.2V7.5H13z"/><path d="M16 21.5l5-5h-3.4V7h-3.2v9.5H11z"/>`,
  perps: `<path d="M2.5 17.2l6.2-6.2 4 4 5.3-5.3H14.6V6.5H22v7.4h-3.2v-3.4L12.7 16.6l-4-4-4.1 4.1z"/>`,
  spot: `<circle cx="9" cy="12" r="6.6"/><path d="M14.6 5.4a6.6 6.6 0 1 1 0 13.2 8.6 8.6 0 0 0 0-13.2z"/>`,
  lighter: `<path d="M13.6 2 4.6 13.4h6.1L9.4 22l9-11.4h-6.1z"/>`,
  stocks: `<rect x="3" y="13" width="4.4" height="8" rx="1.3"/><rect x="9.8" y="8" width="4.4" height="13" rx="1.3"/><rect x="16.6" y="3" width="4.4" height="18" rx="1.3"/>`,
  liquidity: `<path d="M12 2.2c3.7 4.4 6.7 8.2 6.7 11.8a6.7 6.7 0 0 1-13.4 0C5.3 10.4 8.3 6.6 12 2.2z"/>`,
  bridge: `<rect x="2" y="17" width="20" height="3" rx="1"/><rect x="4" y="10.5" width="2.2" height="7"/><rect x="17.8" y="10.5" width="2.2" height="7"/><path d="M2 9.6c4.2 0 6-3.8 10-3.8s5.8 3.8 10 3.8v2.4c-4.2 0-6-3.8-10-3.8S6.2 12 2 12z"/>`,
  gate: `<path d="M3 21V10.2L12 3l9 7.2V21h-6v-5.2a3 3 0 0 0-6 0V21z"/>`,
  market: `<rect x="5.3" y="4.5" width="1.4" height="15.5" rx=".7"/><rect x="3.8" y="7.5" width="4.4" height="9" rx="1.2"/><rect x="11.3" y="2.5" width="1.4" height="14" rx=".7"/><rect x="9.8" y="5" width="4.4" height="8" rx="1.2"/><rect x="17.3" y="7" width="1.4" height="14" rx=".7"/><rect x="15.8" y="10" width="4.4" height="7.5" rx="1.2"/>`,
  launch: `<path d="M14.6 2.4c3.7.4 6.6 3.3 7 7l-7.1 7.1-7-7z"/><path d="M6.6 10.6l6.8 6.8-2.2 2.2-2.6-.5L4.9 15.4l-.5-2.6z"/><path d="M4.6 16.4l3 3c-1.2 1.4-3.3 2.1-5.4 2.4.3-2.1 1-4.2 2.4-5.4z"/>`,
  create: `<path fill-rule="evenodd" d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm4.6 4v3.6H7v2.8h3.6V17h2.8v-3.6H17v-2.8h-3.6V7z"/>`,
  hippodrome: `<path d="M6.5 21.5h11.8v-2.6H6.5z"/><path fill-rule="evenodd" d="M8 17.8h9.3c.4-3.6-.7-6.3-2.8-8.6l2.1-1.6c.7-.5.7-1.5 0-2L12.4 3V1.6L9.9 3.3C7 5.2 5.4 8.3 5.9 11.6l3.6-1.6c.5 1.5-.1 2.8-1 4-.7 1-1.1 2.3-.5 3.8zM13.2 6.3a.9.9 0 1 0-1.8 0 .9.9 0 0 0 1.8 0z"/>`,
  creator: `<path d="M11 2.5h2v7.1l2.6-2.6 1.4 1.4-5 5-5-5 1.4-1.4 2.6 2.6z"/><path d="M3.5 13.5h4.6l1.6 2.6h4.6l1.6-2.6h4.6v5.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/>`,
  agent: `<circle cx="12" cy="2.9" r="1.6"/><rect x="11.1" y="3.8" width="1.8" height="2.8"/><path fill-rule="evenodd" d="M7 6.4h10a3.6 3.6 0 0 1 3.6 3.6v7.4A3.6 3.6 0 0 1 17 21H7a3.6 3.6 0 0 1-3.6-3.6V10A3.6 3.6 0 0 1 7 6.4zm2 4.4a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zm6 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM9 16.3V18h6v-1.7z"/><rect x="1" y="11.2" width="1.6" height="4.4" rx=".8"/><rect x="21.4" y="11.2" width="1.6" height="4.4" rx=".8"/>`,
  herald: `<rect x="1.8" y="10.3" width="2.4" height="3.4" rx=".8"/><path d="M4.2 11.1h9.2l6.6-4.9c.6-.4 1.4 0 1.4.7v10.2c0 .7-.8 1.1-1.4.7l-6.6-4.9H4.2z"/><path d="M6.2 13.8h6.2v5.8l-3.1-1.9-3.1 1.9z"/>`,   // V8 F42: a herald's trumpet with its banner
  leaderboard: `<rect x="2.5" y="12" width="6" height="9" rx="1.2"/><rect x="9" y="5.5" width="6" height="15.5" rx="1.2"/><rect x="15.5" y="9" width="6" height="12" rx="1.2"/>`,
  chat: `<path d="M12 3c5 0 9 3.6 9 8s-4 8-9 8c-1 0-2-.1-2.9-.4L4 20.6l1.4-4.3C4 14.9 3 13 3 11c0-4.4 4-8 9-8z"/>`,
  wallet: `<path d="M4 6.8A2.8 2.8 0 0 1 6.8 4H17v2.6H6.8a.6.6 0 0 0 0 1.2H19.2A1.8 1.8 0 0 1 21 9.6v8.6A1.8 1.8 0 0 1 19.2 20H6.8A2.8 2.8 0 0 1 4 17.2z"/>`,
  autopilot: `<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zm0 3.2a6.3 6.3 0 0 0-6.2 5.2h3.4a3 3 0 0 1 5.6 0h3.4A6.3 6.3 0 0 0 12 5.7zm-1.6 9.2-3.4 2.6a6.3 6.3 0 0 0 3.4 1.6zm3.2 0v4.2a6.3 6.3 0 0 0 3.4-1.6z"/>`,
  sentry: `<path fill-rule="evenodd" d="M12 5c5 0 8.6 3.6 10 7-1.4 3.4-5 7-10 7S3.4 15.4 2 12c1.4-3.4 5-7 10-7zm0 3.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/>`,
  aegis: `<path fill-rule="evenodd" d="M12 2l8.2 3.1v6.6c0 5-3.5 9.2-8.2 10.6-4.7-1.4-8.2-5.6-8.2-10.6V5.1zM7.4 12.1l1.6-1.6 2 2 4.1-4.1 1.6 1.6-5.7 5.7z"/>`,
  scepter: `<path d="M12 1.6l2 3.6 3.6-1.6-1.9 5.4H8.3L6.4 3.6 10 5.2zM8.6 10.4h6.8v1.8H8.6zM11 13.2h2v9.2h-2z"/>`,
  treasury: `<path d="M12 2.4l10 5.6v2.2H2V8zM4 11.6h2.6v7.2H4zM10.7 11.6h2.6v7.2h-2.6zM17.4 11.6H20v7.2h-2.6zM2.6 20.2h18.8v2H2.6z"/>`,
  arena: `<path d="M21 3l-1.45 3.35-10 10-1.9-1.9 10-10z"/><path d="M5.1 13.7l1.2-1.2 5.2 5.2-1.2 1.2z"/><path d="M8.9 16.3 5.2 20 4 18.8l3.7-3.7z"/><circle cx="4" cy="20" r="1.5"/><path d="M3 3l1.45 3.35 10 10 1.9-1.9-10-10z"/><path d="M18.9 13.7l-1.2-1.2-5.2 5.2 1.2 1.2z"/><path d="M15.1 16.3l3.7 3.7 1.2-1.2-3.7-3.7z"/><circle cx="20" cy="20" r="1.5"/>`,
  playbooks: `<path d="M5 3.5A1.5 1.5 0 0 1 6.5 2H16a3 3 0 0 1 3 3v17H8a3 3 0 0 1-3-3z"/>`,
  portfolio: `<path d="M10.8 3.1V13.2h10.1A9.1 9.1 0 1 1 10.8 3.1z"/><path d="M13 2a9 9 0 0 1 9 9h-9z"/>`,
  inbox: `<path d="M12 2a6 6 0 0 1 6 6v5.2l2.2 3.1V17.5H3.8v-1.2L6 13.2V8a6 6 0 0 1 6-6z"/><path d="M9.4 19h5.2a2.6 2.6 0 0 1-5.2 0z"/>`,
  history: `<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zM11 6.5v6.4l4.6 2.7 1-1.7-3.6-2.1V6.5z"/>`,
  social: `<path d="M4.2 3.5h11.6a2.2 2.2 0 0 1 2.2 2.2v7.1a2.2 2.2 0 0 1-2.2 2.2H9.2L5 18.6V15H4.2A2.2 2.2 0 0 1 2 12.8V5.7a2.2 2.2 0 0 1 2.2-2.2z"/><path d="M20 8h.4A1.6 1.6 0 0 1 22 9.6v6.3a1.6 1.6 0 0 1-1.6 1.6H20V20l-3.2-2.5H13l2.2-2.2H18a2 2 0 0 0 2-2z"/>`,
  start: `<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zM10 7.8v8.4l6.4-4.2z"/>`,
  docs: `<path fill-rule="evenodd" d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.6V8h4.4zM8 12v1.8h8V12zm0 4v1.8h6V16z"/>`,
  verify: `<path d="M12 2l8.2 3.1v6.6c0 5-3.5 9.2-8.2 10.6-4.7-1.4-8.2-5.6-8.2-10.6V5.1z"/>`,   // the shield: "Is it safe?" and the Gate tag
  proof: `<path fill-rule="evenodd" d="M12 2.8l2.7 2.7h3.8v3.8l2.7 2.7-2.7 2.7v3.8h-3.8L12 21.2l-2.7-2.7H5.5v-3.8L2.8 12l2.7-2.7V5.5h3.8zM7.4 12.1l1.6-1.6 2 2 4.1-4.1 1.6 1.6-5.7 5.7z"/>`,   // Verify: a seal with a tick, not the safety shield
  news: `<rect x="4" y="2.5" width="2.2" height="19" rx="1.1"/><path d="M7.2 3.6h12.6l-3 4.7 3 4.7H7.2z"/>`,   // What's new: the milestone flag on the roadmap
  plans: `<path d="M12 2.5l10 5.1-10 5.1-10-5.1z"/><path d="M4.4 11l7.6 3.9 7.6-3.9 2.4 1.2-10 5.1-10-5.1z"/><path d="M4.4 15.6l7.6 3.9 7.6-3.9 2.4 1.2-10 5.1-10-5.1z"/>`,   // Plans and tiers: three stacked tiers
  bug: `<path d="M8.4 9.4a3.6 3.6 0 0 1 7.2 0z"/><path d="M8.3 3.3l2.3 2.6-1.2 1-2.3-2.6zM15.7 3.3l-2.3 2.6 1.2 1 2.3-2.6z"/><path fill-rule="evenodd" d="M7 10.6h10v4.2a5 5 0 0 1-10 0zm4.5 1.2v6.6h1v-6.6z"/><rect x="2.4" y="12" width="3.8" height="1.8" rx=".9"/><rect x="17.8" y="12" width="3.8" height="1.8" rx=".9"/><rect x="2.4" y="15.3" width="3.8" height="1.8" rx=".9"/><rect x="17.8" y="15.3" width="3.8" height="1.8" rx=".9"/>`,   // Report a bug: legs sit between the chrome slices so they stay whole
  rail: `<path d="M9.2 2h1.6L6.4 22H3.6z"/><path d="M13.2 2h1.6l5.6 20h-2.8z"/><rect x="8" y="5.6" width="8" height="1.8" rx=".6"/><rect x="6.6" y="10.9" width="10.8" height="2.2" rx=".7"/><rect x="5" y="16.6" width="14" height="2.6" rx=".8"/>`,
  record: `<rect x="3.5" y="2" width="3" height="20" rx="1.2"/><path fill-rule="evenodd" d="M8 2h10.5a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8zm2.6 5v1.8h6.8V7zm0 4.2V13h6.8v-1.8zm0 4.2v1.8h4.4v-1.8z"/>`,
  flywheel: `<path d="M12 3a9 9 0 0 1 8.4 5.8h-2.6A6.6 6.6 0 0 0 5.4 12H3a9 9 0 0 1 9-9z"/><path d="M21 3.4V10h-6.6z"/><path d="M12 21a9 9 0 0 1-8.4-5.8h2.6A6.6 6.6 0 0 0 18.6 12H21a9 9 0 0 1-9 9z"/><path d="M3 20.6V14h6.6z"/>`,
  search: `<path fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 0 1 6.1 11.8l4.6 4.6-2 2-4.6-4.6A7.5 7.5 0 1 1 10.5 3zm0 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/>`,
  spark: `<path d="M11 2l2.3 6.6 6.7 2.4-6.7 2.4L11 20l-2.3-6.6L2 11l6.7-2.4z"/><path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>`,
  sun: `<circle cx="12" cy="12" r="4.6"/><rect x="11" y="1.5" width="2" height="3.4" rx="1"/><rect x="11" y="19.1" width="2" height="3.4" rx="1"/><rect x="1.5" y="11" width="3.4" height="2" rx="1"/><rect x="19.1" y="11" width="3.4" height="2" rx="1"/><path d="M4.6 3.2l2.4 2.4-1.4 1.4-2.4-2.4zM17 17l2.4 2.4-1.4 1.4-2.4-2.4zM3.2 19.4 5.6 17 7 18.4l-2.4 2.4zM17 5.6l2.4-2.4 1.4 1.4L18.4 7z"/>`,
  moon: `<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>`,
  menu: `<rect x="3" y="5" width="18" height="2.4" rx="1.2"/><rect x="3" y="10.8" width="18" height="2.4" rx="1.2"/><rect x="3" y="16.6" width="18" height="2.4" rx="1.2"/>`,
  close: `<path d="M5.6 4.2 12 10.6l6.4-6.4 1.4 1.4-6.4 6.4 6.4 6.4-1.4 1.4-6.4-6.4-6.4 6.4-1.4-1.4 6.4-6.4-6.4-6.4z"/>`,
  send: `<path d="M2.5 10.7 21.5 2.5l-8.2 19-2.6-7.9z"/>`,
  gear: `<path fill-rule="evenodd" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>`,
  expand: `<path d="M14 3h7v7h-2.4V7.1l-4.4 4.4-1.7-1.7 4.4-4.4H14zM10 21H3v-7h2.4v2.9l4.4-4.4 1.7 1.7-4.4 4.4H10z"/>`,
};
export const has = (k) => k in G;
const SOLID = new Set(["gear"]);

let injected = false;
export function injectDefs() {
  if (injected) return;
  injected = true;
  const box = document.createElementNS(NS, "svg");
  box.setAttribute("width", "0"); box.setAttribute("height", "0"); box.setAttribute("aria-hidden", "true");
  box.style.position = "absolute";
  box.innerHTML = `<defs>
    <linearGradient id="tc" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#f7fdff"/><stop offset=".38" stop-color="#bff0fd"/><stop offset=".7" stop-color="#6fc9e2"/><stop offset="1" stop-color="#2f7d96"/></linearGradient>
    <linearGradient id="tcl" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#4bb7d8"/><stop offset=".5" stop-color="#16789a"/><stop offset="1" stop-color="#0a4a60"/></linearGradient>
    <mask id="ts" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/>${[4.6, 7.9, 11.2, 14.5, 17.8].map((y) => `<rect x="0" y="${y}" width="24" height=".62" fill="#000"/>`).join("")}</mask>
  </defs>`;
  document.body.prepend(box);
}

/** A chrome icon element, or null when there is no chrome glyph for that name. */
export function chromeIcon(k, cls = "") {
  if (!G[k]) return null;
  injectDefs();
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", `ci${cls ? " " + cls : ""}`);
  // the scanlines are left off a few small glyphs so the shape reads at a glance (Settings must look like a plain cog)
  el.innerHTML = `<g fill="url(#tc)"${SOLID.has(k) ? "" : ' mask="url(#ts)"'}>${G[k]}</g>`;
  return el;
}
