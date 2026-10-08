// Personaje: estado visual, arrastre y clic. Sin imports: el renderer corre como script clásico.
(function () {
  var api = window.agentik;
  var agent = document.getElementById('agent');
  var badge = agent.querySelector('.badge');

  // Motor de animación del personaje (avatar-engine.js). Estados de la app → estados del avatar.
  var avatar = window.AgentikAvatar.mount(agent.querySelector('.body'));
  var AVATAR_STATE = {
    reposo: 'idle',
    observando: 'idle',
    pensando: 'thinking',
    'con-sugerencia': 'success',
    'esperando-aprobacion': 'listening',
    pausado: 'sleeping',
    exito: 'success',
    confuso: 'confusion',
  };

  var BADGES = {
    pensando: '…',
    'con-sugerencia': '!',
    'esperando-aprobacion': '?',
    pausado: 'zz',
  };

  function render(payload) {
    agent.dataset.state = payload.state;
    agent.dataset.observing = String(!!payload.observing);
    var text = BADGES[payload.state] || '';
    badge.textContent = text;
    badge.dataset.kind = payload.state;
    badge.classList.toggle('show', !!text);
    avatar.setAvatarState(AVATAR_STATE[payload.state] || 'idle');
  }

  api.on(api.channels.characterState, render);

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
      avatar.triggerGesture('smile_pop');
    }
    last = null;
  });
})();
