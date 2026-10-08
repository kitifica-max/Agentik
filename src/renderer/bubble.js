(function () {
  var api = window.agetik;
  var ch = api.channels;

  var status = document.getElementById('status');
  var perm = document.getElementById('perm');
  var toggle = document.getElementById('toggle');
  var pause = document.getElementById('pause');
  var messages = document.getElementById('messages');
  var thinking = document.getElementById('thinking');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var memoryProposal = document.getElementById('memory-proposal');
  var proposalText = document.getElementById('proposal-text');
  var proposalApprove = document.getElementById('proposal-approve');
  var proposalReject = document.getElementById('proposal-reject');
  var viewChat = document.getElementById('view-chat');
  var viewMemory = document.getElementById('view-memory');
  var tabChat = document.getElementById('tab-chat');
  var tabMemory = document.getElementById('tab-memory');
  var memoryList = document.getElementById('memory-list');

  var current = { enabled: false, paused: false };
  var pendingMemory = null;

  function renderStatus(s) {
    current = s;
    if (!s.enabled) {
      status.textContent = 'Reposo';
    } else if (s.paused) {
      status.textContent = 'Pausado';
    } else {
      status.textContent = 'Observando';
    }
    perm.hidden = s.permissionsOk !== false || !s.enabled;
    toggle.textContent = s.enabled ? 'Desactivar' : 'Activar';
    pause.hidden = !s.enabled;
    pause.textContent = s.paused ? 'Reanudar' : 'Pausar';
  }

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'msg msg-' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function showTab(name) {
    viewChat.hidden = name !== 'chat';
    viewMemory.hidden = name !== 'memory';
    tabChat.classList.toggle('active', name === 'chat');
    tabMemory.classList.toggle('active', name === 'memory');
    if (name === 'memory') loadMemories();
  }

  function loadMemories() {
    api.invoke(ch.memoryList).then(function (list) {
      memoryList.innerHTML = '';
      if (!list || list.length === 0) {
        memoryList.innerHTML = '<p class="muted">Sin recuerdos guardados.</p>';
        return;
      }
      list.forEach(function (m) {
        var item = document.createElement('div');
        item.className = 'memory-item memory-' + m.estado;
        var label = document.createElement('span');
        label.className = 'memory-label';
        label.textContent = '[' + m.tipo + '] ';
        var content = document.createElement('span');
        content.textContent = m.contenido;
        item.appendChild(label);
        item.appendChild(content);

        if (m.estado === 'propuesto') {
          var approveBtn = document.createElement('button');
          approveBtn.className = 'btn btn-xs btn-ok';
          approveBtn.textContent = '✓';
          approveBtn.onclick = function () {
            api.invoke(ch.memoryApprove, m.id).then(function () { loadMemories(); });
          };
          var rejectBtn = document.createElement('button');
          rejectBtn.className = 'btn btn-xs';
          rejectBtn.textContent = '✗';
          rejectBtn.onclick = function () {
            api.invoke(ch.memoryReject, m.id).then(function () { loadMemories(); });
          };
          item.appendChild(approveBtn);
          item.appendChild(rejectBtn);
        } else if (m.estado === 'aprobado') {
          var delBtn = document.createElement('button');
          delBtn.className = 'btn btn-xs btn-danger';
          delBtn.textContent = '🗑';
          delBtn.onclick = function () {
            api.invoke(ch.memoryDelete, m.id).then(function () { loadMemories(); });
          };
          item.appendChild(delBtn);
        }

        memoryList.appendChild(item);
      });
    });
  }

  // Tabs
  tabChat.addEventListener('click', function () { showTab('chat'); });
  tabMemory.addEventListener('click', function () { showTab('memory'); });

  // Observer controls
  toggle.addEventListener('click', function () {
    api.invoke(ch.observerSetEnabled, !current.enabled).then(renderStatus);
  });
  pause.addEventListener('click', function () {
    api.invoke(ch.observerTogglePause).then(renderStatus);
  });
  document.getElementById('quit').addEventListener('click', function () {
    api.send(ch.appQuit);
  });

  // Chat
  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    addMessage('user', text);
    chatInput.disabled = true;
    api.invoke(ch.chatSend, text).then(function (result) {
      chatInput.disabled = false;
      chatInput.focus();
      if (result && result.reply) {
        addMessage('assistant', result.reply);
      } else if (result && result.error) {
        addMessage('assistant', '⚠ ' + result.error);
      }
    });
  });

  // Memory proposal from chat
  api.on(ch.memoryProposed, function (mem) {
    pendingMemory = mem;
    proposalText.textContent = '💡 Recuerdo propuesto: [' + mem.tipo + '] ' + mem.contenido;
    memoryProposal.hidden = false;
  });

  proposalApprove.addEventListener('click', function () {
    if (pendingMemory) {
      api.invoke(ch.memoryApprove, pendingMemory.id);
      pendingMemory = null;
      memoryProposal.hidden = true;
    }
  });

  proposalReject.addEventListener('click', function () {
    if (pendingMemory) {
      api.invoke(ch.memoryReject, pendingMemory.id);
      pendingMemory = null;
      memoryProposal.hidden = true;
    }
  });

  // Thinking indicator
  api.on(ch.chatThinking, function (on) {
    thinking.hidden = !on;
    if (on) messages.scrollTop = messages.scrollHeight;
  });

  api.on(ch.observerChanged, renderStatus);
  api.invoke(ch.observerStatus).then(renderStatus);
})();
