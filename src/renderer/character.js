// Personaje: estado visual, arrastre y clic. Sin imports: el renderer corre como script clásico.
(function () {
  var api = window.agentik;
  var agent = document.getElementById('agent');
  var badge = agent.querySelector('.badge');

  // Estados de la app → estados del avatar (avatar-engine.js)
  var AVATAR_STATE = {
    reposo: 'idle',
    observando: 'idle',
    pensando: 'thinking',
    'con-sugerencia': 'success',
    'esperando-aprobacion': 'listening',
    pausado: 'sleeping',
    exito: 'success',
    confuso: 'confusion',
    pendiente: 'calling', // respuesta sin leer: salta en bucle hasta que abras el chat
  };

  var BADGES = {
    pensando: '…',
    'con-sugerencia': '!',
    'esperando-aprobacion': '?',
    pendiente: '1',
    pausado: 'zz',
  };

  // El personaje (niño o niña) se arma según lo elegido en Ajustes; cambiarlo no requiere reiniciar.
  var svg = agent.querySelector('.body');
  var avatar = null;
  var avatarId = null;
  var current = 'reposo';

  function useAvatar(id) {
    var def = window.AgentikAvatars.get(id);
    if (avatar && avatarId === def.id) return;
    if (avatar) avatar.destroy();
    window.AgentikAvatars.build(svg, def.id);
    avatar = window.AgentikAvatar.mount(svg, { geometry: def.geometry });
    avatarId = def.id;
    avatar.setAvatarState(AVATAR_STATE[current] || 'idle');
  }

  function render(payload) {
    var entering = payload.state === 'pendiente' && current !== 'pendiente';
    current = payload.state;
    agent.dataset.state = payload.state;
    agent.dataset.observing = String(!!payload.observing);
    var text = BADGES[payload.state] || '';
    badge.textContent = text;
    badge.dataset.kind = payload.state;
    badge.classList.toggle('show', !!text);
    if (avatar) avatar.setAvatarState(AVATAR_STATE[payload.state] || 'idle');
    if (entering && payload.sound !== false) window.AgentikSounds.playPop(); // un "pop" al llegar la respuesta
  }

  api.on(api.channels.characterState, render);
  api.on(api.channels.avatarChanged, useAvatar);
  api.invoke(api.channels.settingsGet).then(
    function (s) { useAvatar(s && s.avatar); },
    function () { useAvatar('nino'); },
  );

  // Arrastre manual: mueve la ventana con deltas. Clic corto abre la burbuja.
  var last = null;
  var travelled = 0;
  var dragging = false;

  agent.addEventListener('pointerdown', function (e) {
    last = { x: e.screenX, y: e.screenY };
    travelled = 0;
    dragging = false;
    agent.setPointerCapture(e.pointerId);
  });

  agent.addEventListener('pointermove', function (e) {
    if (!last) return;
    var dx = e.screenX - last.x;
    var dy = e.screenY - last.y;
    travelled += Math.abs(dx) + Math.abs(dy);
    last = { x: e.screenX, y: e.screenY };
    if (travelled > 4) dragging = true;
    if (dragging && (dx || dy)) api.send(api.channels.windowMoveBy, { dx: dx, dy: dy });
  });

  agent.addEventListener('pointerup', function () {
    if (!last) return;
    if (dragging) api.send(api.channels.windowDragEnd);
    else {
      api.send(api.channels.bubbleToggle);
      if (avatar) avatar.triggerGesture('smile_pop');
    }
    last = null;
  });
})();
