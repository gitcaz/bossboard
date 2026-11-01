// Classic (non-module) script loaded before app.js: makes every failure visible, even when app.js cannot load.
(function () {
  function show(msg) {
    var b = document.getElementById("banner"); if (!b) return;
    b.style.display = "block"; b.textContent = msg;
  }
  window.bbShowError = show;
  window.addEventListener("error", function (e) { show("App error: " + (e.message || e) + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")); });
  window.addEventListener("unhandledrejection", function (e) { var r = e.reason; show("App error: " + (r && r.message ? r.message : String(r))); });
  setTimeout(function () {
    if (!window.__bbReady) show("BossBoard did not finish starting. Close other BossBoard tabs and hard-refresh (Ctrl+Shift+R / Cmd+Shift+R).");
  }, 12000);
})();
