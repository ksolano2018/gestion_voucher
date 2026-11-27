(function(){
  // Ruta relativa (mismo origen), igual que app.js. NO usar REACT_APP_API_URL del contenedor:
  // en PD vale http://localhost:8080 y el navegador del usuario no puede alcanzarlo.
  var API_URL = '';
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var subEl = document.getElementById('sp-sub');
  var form = document.getElementById('sp-form');
  var msgEl = document.getElementById('sp-msg');
  // Enlace del correo de bienvenida: es la primera contraseña, no un "restablecer".
  var isWelcome = params.get('welcome') === '1';
  if(isWelcome){
    document.getElementById('sp-title').textContent = 'Crea tu contraseña';
    document.getElementById('sp-submit').textContent = 'Crear contraseña';
    document.title = 'Crea tu contraseña · CertJoin';
  }
  var ERRORS = {
    same_password: 'La nueva contraseña no puede ser igual a la actual. Elige una diferente.'
  };

  function showMsg(text, type){
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + (type || '');
  }

  if(!token){
    subEl.textContent = 'Enlace inválido: falta el token.';
    return;
  }

  fetch(API_URL + '/oauth/reset-password/' + encodeURIComponent(token))
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
    .then(function(res){
      if(!res.ok){
        var reasons = {
          invalid_token: 'Este enlace no es válido.',
          token_already_used: 'Este enlace ya fue usado. Si lo necesitas, solicita uno nuevo desde «¿Olvidaste tu contraseña?».',
          token_expired: 'Este enlace ya expiró. Solicita uno nuevo desde «¿Olvidaste tu contraseña?» en el inicio de sesión.'
        };
        subEl.textContent = reasons[res.data.error] || 'No se pudo validar el enlace.';
        return;
      }
      subEl.textContent = isWelcome
        ? 'Hola, crea la contraseña de tu cuenta ' + res.data.email + '.'
        : 'Hola, estás restableciendo la contraseña de ' + res.data.email + '.';
      form.classList.remove('hidden');
    })
    .catch(function(){ subEl.textContent = 'No se pudo validar el enlace. Intenta de nuevo más tarde.'; });

  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var p1 = document.getElementById('sp-password').value;
    var p2 = document.getElementById('sp-password2').value;
    if(p1 !== p2){ showMsg('Las contraseñas no coinciden.', 'error'); return; }

    var btn = document.getElementById('sp-submit');
    btn.disabled = true;
    fetch(API_URL + '/oauth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, password: p1 })
    })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
      .then(function(res){
        btn.disabled = false;
        if(!res.ok){
          var detail = Array.isArray(res.data.details) && res.data.details.length ? res.data.details[0].msg : '';
          showMsg(detail || ERRORS[res.data.error] || res.data.error || 'No se pudo crear la contraseña.', 'error');
          return;
        }
        showMsg(res.data.message || 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.', 'success');
        form.classList.add('hidden');
        document.getElementById('sp-login').classList.remove('hidden');
      })
      .catch(function(){ btn.disabled = false; showMsg('Error de conexión. Intenta de nuevo.', 'error'); });
  });
})();
