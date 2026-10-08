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
  var viewFiles = document.getElementById('view-files');
  var tabChat = document.getElementById('tab-chat');
  var tabMemory = document.getElementById('tab-memory');
  var tabFiles = document.getElementById('tab-files');
  var memoryList = document.getElementById('memory-list');
  var fileEditList = document.getElementById('file-edit-list');

  var suggestionBanner = document.getElementById('suggestion-banner');
  var suggestionText = document.getElementById('suggestion-text');
  var suggestionAccept = document.getElementById('suggestion-accept');
  var suggestionDismiss = document.getElementById('suggestion-dismiss');
  var folderListEl = document.getElementById('folder-list');
  var addFolderBtn = document.getElementById('add-folder');

  var costEl = document.getElementById('cost');
  function usd(n) { return n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2); }
  function loadCost() {
    api.invoke(ch.usageGet).then(function (t) {
      if (!t) return;
      costEl.textContent = usd(t.today) + ' hoy';
      costEl.title = 'Últimos 7 días: ' + usd(t.week) + ' · Este mes: ' + usd(t.month) + ' (estimado)';
    });
  }

  var current = { enabled: false, paused: false };
  var pendingMemory = null;
  var pendingSuggestion = null;
  var pendingOpsCount = 0;

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

  function updateFilesBadge(count) {
    pendingOpsCount = count;
    tabFiles.textContent = count > 0 ? 'Archivos (' + count + ')' : 'Archivos';
    tabFiles.classList.toggle('has-badge', count > 0);
  }

  function showTab(name) {
    viewChat.hidden = name !== 'chat';
    viewMemory.hidden = name !== 'memory';
    viewFiles.hidden = name !== 'files';
    tabChat.classList.toggle('active', name === 'chat');
    tabMemory.classList.toggle('active', name === 'memory');
    tabFiles.classList.toggle('active', name === 'files');
    if (name === 'memory') loadMemories();
    if (name === 'files') { loadFileEdits(); loadFolders(); }
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

  function renderDiff(diffText) {
    var container = document.createElement('div');
    container.className = 'diff-preview';
    if (!diffText) { container.textContent = '(sin diff)'; return container; }
    var lines = diffText.split('\n');
    lines.forEach(function (line) {
      var span = document.createElement('span');
      if (line.startsWith('+ ')) {
        span.className = 'diff-add';
      } else if (line.startsWith('- ')) {
        span.className = 'diff-del';
      }
      span.textContent = line + '\n';
      container.appendChild(span);
    });
    return container;
  }

  function loadFileEdits() {
    api.invoke(ch.fileEditList).then(function (list) {
      fileEditList.innerHTML = '';
      if (!list || list.length === 0) {
        fileEditList.innerHTML = '<p class="muted">Sin operaciones pendientes.</p>';
        updateFilesBadge(0);
        return;
      }
      var pending = list.filter(function (e) { return e.status === 'propuesto'; }).length;
      updateFilesBadge(pending);
      if (pending > 1) {
        var batchBar = document.createElement('div');
        batchBar.className = 'batch-actions';
        var approveAllBtn = document.createElement('button');
        approveAllBtn.className = 'btn btn-sm btn-ok';
        approveAllBtn.textContent = 'Aprobar todo (' + pending + ')';
        approveAllBtn.onclick = function () {
          approveAllBtn.disabled = true;
          api.invoke(ch.fileEditApproveAll).then(function (res) {
            showToast(res.applied + ' aplicadas' + (res.failed.length ? ', ' + res.failed.length + ' fallidas' : ''));
            loadFileEdits();
          });
        };
        var rejectAllBtn = document.createElement('button');
        rejectAllBtn.className = 'btn btn-sm btn-danger';
        rejectAllBtn.textContent = 'Rechazar todo';
        rejectAllBtn.onclick = function () {
          api.invoke(ch.fileEditRejectAll).then(function () {
            showToast('Todas rechazadas');
            loadFileEdits();
          });
        };
        batchBar.appendChild(approveAllBtn);
        batchBar.appendChild(rejectAllBtn);
        fileEditList.appendChild(batchBar);
      }

      list.forEach(function (edit) {
        var item = document.createElement('div');
        item.className = 'file-edit-item';

        var header = document.createElement('div');
        var pathSpan = document.createElement('span');
        pathSpan.className = 'file-edit-path';
        pathSpan.textContent = edit.path.split('/').slice(-2).join('/');
        pathSpan.title = edit.path;
        header.appendChild(pathSpan);

        var statusSpan = document.createElement('span');
        statusSpan.className = 'file-edit-status file-edit-status-' + edit.status;
        statusSpan.textContent = edit.status;
        header.appendChild(statusSpan);
        item.appendChild(header);

        var opLabel = '';
        if (edit.diff && edit.diff.startsWith('mover:')) opLabel = 'MOVER';
        else if (edit.diff && edit.diff.startsWith('copiar:')) opLabel = 'COPIAR';
        else if (edit.diff && edit.diff.startsWith('crear carpeta:')) opLabel = 'MKDIR';
        else opLabel = 'EDITAR';
        var opSpan = document.createElement('span');
        opSpan.className = 'file-edit-op file-edit-op-' + opLabel.toLowerCase();
        opSpan.textContent = opLabel;
        header.insertBefore(opSpan, statusSpan);

        if (edit.diff) {
          item.appendChild(renderDiff(edit.diff));
        }

        if (edit.status === 'propuesto') {
          var actions = document.createElement('div');
          actions.className = 'file-edit-actions';
          var approveBtn = document.createElement('button');
          approveBtn.className = 'btn btn-sm btn-ok';
          approveBtn.textContent = 'Aprobar';
          approveBtn.onclick = function () {
            api.invoke(ch.fileEditApprove, edit.id).then(function () { loadFileEdits(); });
          };
          var rejectBtn = document.createElement('button');
          rejectBtn.className = 'btn btn-sm btn-danger';
          rejectBtn.textContent = 'Rechazar';
          rejectBtn.onclick = function () {
            api.invoke(ch.fileEditReject, edit.id).then(function () { loadFileEdits(); });
          };
          actions.appendChild(approveBtn);
          actions.appendChild(rejectBtn);
          item.appendChild(actions);
        }

        fileEditList.appendChild(item);
      });
    });
  }

  // Folders management
  function loadFolders() {
    api.invoke(ch.configGetFolders).then(function (folders) {
      folderListEl.innerHTML = '';
      if (!folders || folders.length === 0) {
        folderListEl.innerHTML = '<p class="muted">Sin carpetas configuradas. Agrega una para habilitar operaciones de archivos.</p>';
        return;
      }
      folders.forEach(function (f) {
        var item = document.createElement('div');
        item.className = 'folder-item';
        var path = document.createElement('span');
        path.className = 'folder-path';
        path.textContent = f.replace(/^\/Users\/[^/]+/, '~');
        path.title = f;
        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-xs btn-danger';
        removeBtn.textContent = '✗';
        removeBtn.onclick = function () {
          api.invoke(ch.configRemoveFolder, f).then(function () { loadFolders(); });
        };
        item.appendChild(path);
        item.appendChild(removeBtn);
        folderListEl.appendChild(item);
      });
    });
  }

  addFolderBtn.addEventListener('click', function () {
    api.invoke(ch.configAddFolder).then(function () { loadFolders(); });
  });

  window.showToast = showToast;
  function showToast(text) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  }

  // Tabs
  tabChat.addEventListener('click', function () { showTab('chat'); });
  tabMemory.addEventListener('click', function () { showTab('memory'); });
  tabFiles.addEventListener('click', function () { showTab('files'); });

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
      loadCost();
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

  // Mensajes locales (resumen) y chat nuevo desde atajos
  api.on(ch.chatReply, function (text) { showTab('chat'); addMessage('assistant', text); });
  api.on(ch.chatClear, function () { messages.innerHTML = ''; showTab('chat'); });

  // File edit proposed from AI
  api.on(ch.fileEditProposed, function (edit) {
    updateFilesBadge(pendingOpsCount + 1);
    loadFileEdits();
    showToast('Nueva operación propuesta — revisa en Archivos');
  });

  // Suggestions
  api.on(ch.suggestionShow, function (s) {
    pendingSuggestion = s;
    suggestionText.textContent = '💡 ' + s.text;
    suggestionBanner.hidden = false;
    showTab('chat');
  });

  suggestionAccept.addEventListener('click', function () {
    if (!pendingSuggestion) return;
    var id = pendingSuggestion.id;
    var text = pendingSuggestion.text;
    pendingSuggestion = null;
    suggestionBanner.hidden = true;
    addMessage('assistant', text);
    chatInput.disabled = true;
    api.invoke(ch.suggestionAccept, id).then(function (result) {
      chatInput.disabled = false;
      chatInput.focus();
      loadCost();
      if (result && result.reply) {
        addMessage('assistant', result.reply);
      }
    });
  });

  suggestionDismiss.addEventListener('click', function () {
    if (!pendingSuggestion) return;
    api.invoke(ch.suggestionDismiss, pendingSuggestion.id);
    pendingSuggestion = null;
    suggestionBanner.hidden = true;
  });

  loadCost();
  api.on(ch.observerChanged, renderStatus);
  api.invoke(ch.observerStatus).then(renderStatus);
})();
