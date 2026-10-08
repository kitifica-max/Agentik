// Burbuja Fase 1: estado del observador, activar/pausar, salir. El chat llega en Fase 2.
(function () {
  var api = window.agetik;
  var status = document.getElementById('status');
  var hint = document.getElementById('hint');
  var perm = document.getElementById('perm');
  var toggle = document.getElementById('toggle');
  var pause = document.getElementById('pause');

  var current = { enabled: false, paused: false };

  function render(s) {
    current = s;
    if (!s.enabled) {
      status.textContent = 'Reposo';
      hint.textContent = 'Observador apagado. Actívalo para empezar a registrar tu actividad.';
    } else if (s.paused) {
      status.textContent = 'Pausado';
      hint.textContent = 'Pausa activa. No se registra nada hasta que la reanudes.';
    } else {
      status.textContent = 'Observando';
      hint.textContent = 'Registro: app en primer plano y título de ventana. Nunca teclado ni capturas.';
    }
    perm.hidden = s.permissionsOk !== false || !s.enabled;
    toggle.textContent = s.enabled ? 'Desactivar observador' : 'Activar observador';
    pause.hidden = !s.enabled;
    pause.textContent = s.paused ? 'Reanudar' : 'Pausar';
  }

  toggle.addEventListener('click', function () {
    api.invoke(api.channels.observerSetEnabled, !current.enabled).then(render);
  });

  pause.addEventListener('click', function () {
    api.invoke(api.channels.observerTogglePause).then(render);
  });

  document.getElementById('quit').addEventListener('click', function () {
    api.send(api.channels.appQuit);
  });

  api.on(api.channels.observerChanged, render);
  api.invoke(api.channels.observerStatus).then(render);
})();
