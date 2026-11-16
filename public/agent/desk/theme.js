// Applies the saved Desk theme (dark by default, or light) before the page paints, so it never flashes.
try { if (localStorage.getItem("troya.theme") === "light") document.documentElement.dataset.theme = "light"; } catch (e) { /* storage blocked: stay dark */ }
