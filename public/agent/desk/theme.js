// Applies the saved Desk theme (dark by default, or light) before the page paints, so it never flashes.
// Two backgrounds only (23 Nov 2026): black, or white. The browser bar follows.
try { if (localStorage.getItem("troya.theme") === "light") { document.documentElement.dataset.theme = "light"; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#ffffff"); } } catch (e) { /* storage blocked: stay dark */ }
