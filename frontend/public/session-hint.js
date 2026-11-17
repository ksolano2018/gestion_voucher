(function () {
  var has = false;
  try { has = !!localStorage.getItem('session_claims'); } catch (e) {}
  if (!has) document.documentElement.classList.add('no-session');

  // Fallback del logo (antes onerror= inline; la CSP ya no permite handlers inline).
  // 'error' no burbujea, por eso se escucha en fase de captura.
  document.addEventListener('error', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'IMG' || (t.getAttribute('src') || '').indexOf('certjoin-logo') === -1) return;
    t.style.display = 'none';
    if (t.classList.contains('login-logo-img')) {
      var txt = document.querySelector('.login-logo-text');
      if (txt) txt.style.display = 'block';
    }
  }, true);
}());
