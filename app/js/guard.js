// Classic (non-module) script loaded before app.js: makes every failure visible, even when app.js cannot load.
(function () {
  if (window.top !== window.self) {
    window.__bbFramed = true;
    window.__bbReady = true;
    function notice() {
      document.body.innerHTML = '<main style="padding:2rem;max-width:36rem;margin:10vh auto;font:16px/1.5 system-ui,sans-serif"><h1>BossBoard (by Grok)</h1><p>This app cannot run inside another site. Open it at its own address.</p></main>';
    }
    if (document.body) notice(); else document.addEventListener("DOMContentLoaded", notice);
    return;
  }
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
