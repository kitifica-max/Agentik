// Personaje: estado visual, arrastre y clic. Sin imports: el renderer corre como script clásico.
(function () {
  var api = window.agetik;
  var agent = document.getElementById('agent');
  var badge = agent.querySelector('.badge');

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
    else api.send(api.channels.bubbleToggle);
    last = null;
  });
})();
