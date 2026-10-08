(function () {
  var api = window.agentik;
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
  var viewGuide = document.getElementById('view-guide');
  var tabSettings = document.getElementById('tab-settings');
  var viewSettings = document.getElementById('view-settings');
  var avatarChoices = document.getElementById('avatar-choices');
  var setNotif = document.getElementById('set-notif');
  var setSound = document.getElementById('set-sound');
  var tabModels = document.getElementById('tab-models');
  var viewModels = document.getElementById('view-models');
  var modelList = document.getElementById('model-list');
  var modelChip = document.getElementById('model-chip');
  var mForm = document.getElementById('model-form');
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

  var chatTools = document.getElementById('chat-tools');
  var chatStop = document.getElementById('chat-stop');

  function addMessage(role, text) {
    chatTools.hidden = false; // hay historial: se puede borrar
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
    viewModels.hidden = name !== 'models';
    viewSettings.hidden = name !== 'settings';
    viewGuide.hidden = name !== 'guide';
    tabSettings.classList.toggle('active', name === 'settings');
    tabModels.classList.toggle('active', name === 'models');
    tabChat.classList.toggle('active', name === 'chat');
    tabMemory.classList.toggle('active', name === 'memory');
    tabFiles.classList.toggle('active', name === 'files');
    if (name === 'memory') loadMemories();
    if (name === 'files') { loadFileEdits(); loadFolders(); }
    if (name === 'models') loadModels();
    if (name === 'settings') loadSettings();
    if (name === 'guide') renderGuide();
  }

  function loadMemories() {
    api.invoke(ch.memoryList).then(function (list) {
      memoryList.innerHTML = '';
      var pending = (list || []).filter(function (m) { return m.estado === 'propuesto'; });
      tabMemory.textContent = pending.length > 0 ? 'Memoria (' + pending.length + ')' : 'Memoria';
      tabMemory.classList.toggle('has-badge', pending.length > 0);
      if (!list || list.length === 0) {
        memoryList.innerHTML = '<p class="muted">Sin recuerdos guardados.</p>';
        return;
      }
      if (pending.length > 1) {
        // Aprobar o rechazar todo de una vez (sin ir uno por uno)
        var bar = document.createElement('div');
        bar.className = 'batch-actions';
        var okAll = document.createElement('button');
        okAll.className = 'btn btn-sm btn-ok';
        okAll.textContent = 'Aprobar todo (' + pending.length + ')';
        okAll.onclick = function () {
          okAll.disabled = true;
          Promise.all(pending.map(function (m) { return api.invoke(ch.memoryApprove, m.id); })).then(function () { loadMemories(); });
        };
        var noAll = document.createElement('button');
        noAll.className = 'btn btn-sm btn-danger';
        noAll.textContent = 'Rechazar todo';
        noAll.onclick = function () {
          Promise.all(pending.map(function (m) { return api.invoke(ch.memoryReject, m.id); })).then(function () { loadMemories(); });
        };
        bar.appendChild(okAll);
        bar.appendChild(noAll);
        memoryList.appendChild(bar);
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

  // ── Modelos: elegir el activo, agregar APIs (Anthropic, compatibles con OpenAI) y modelos locales (Ollama)
  var DEFAULT_URL = { openai: 'https://api.openai.com/v1', ollama: 'http://localhost:11434' };
  var PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'API compatible con OpenAI', ollama: 'Ollama (local)' };
  var mf = {
    provider: document.getElementById('mf-provider'),
    label: document.getElementById('mf-label'),
    model: document.getElementById('mf-model'),
    models: document.getElementById('mf-models'),
    detect: document.getElementById('mf-detect'),
    urlRow: document.getElementById('mf-url-row'),
    url: document.getElementById('mf-url'),
    keyRow: document.getElementById('mf-key-row'),
    key: document.getElementById('mf-key'),
    ctxRow: document.getElementById('mf-ctx-row'),
    ctx: document.getElementById('mf-ctx'),
    prices: document.getElementById('mf-prices'),
    pin: document.getElementById('mf-pin'),
    pout: document.getElementById('mf-pout'),
    error: document.getElementById('mf-error'),
  };
  var editing = null; // perfil que se edita (null = nuevo)

  function mfError(text) {
    mf.error.textContent = text || '';
    mf.error.hidden = !text;
  }

  // Muestra solo los campos que aplican al tipo elegido
  function applyProviderUI(keepUrl) {
    var p = mf.provider.value;
    mf.urlRow.hidden = p === 'anthropic';
    mf.keyRow.hidden = p === 'ollama';
    mf.ctxRow.hidden = p !== 'ollama';
    mf.prices.hidden = p === 'anthropic'; // en Ollama solo aplica a modelos -cloud; local = $0
    mf.detect.hidden = p !== 'ollama';
    mf.model.placeholder = p === 'anthropic' ? 'claude-sonnet-5-5' : p === 'ollama' ? 'qwen3:8b' : 'gpt-4o-mini';
    if (!keepUrl) mf.url.value = DEFAULT_URL[p] || '';
    mf.url.placeholder = DEFAULT_URL[p] || '';
  }

  function openModelForm(profile) {
    editing = profile || null;
    mfError('');
    mf.provider.value = profile ? profile.provider : 'ollama';
    mf.provider.disabled = !!profile;
    applyProviderUI(!!profile);
    mf.label.value = profile ? profile.label : '';
    mf.model.value = profile ? profile.model : '';
    mf.url.value = profile && profile.base_url ? profile.base_url : (profile ? '' : DEFAULT_URL.ollama);
    mf.key.value = '';
    mf.key.placeholder = profile && profile.hasKey ? 'Guardada. Déjalo vacío para conservarla' : 'Se guarda cifrada en el Llavero';
    mf.ctx.value = profile && profile.num_ctx ? profile.num_ctx : '';
    mf.pin.value = profile && profile.price_in != null ? profile.price_in : '';
    mf.pout.value = profile && profile.price_out != null ? profile.price_out : '';
    mf.models.innerHTML = '';
    mForm.hidden = false;
    mf.label.focus();
  }

  function renderModels(state) {
    if (!state || state.error) { if (state && state.error) showToast(state.error); return; }
    modelList.innerHTML = '';
    modelChip.textContent = 'Sin modelo';
    modelChip.title = 'No hay modelo configurado (clic para agregar uno)';
    if (state.profiles.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'model-empty';
      empty.textContent = 'No hay ningún modelo. Pulsa "+ Agregar" para configurar uno (necesitas su API key, o un Ollama local).';
      modelList.appendChild(empty);
    }
    state.profiles.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'model-item' + (p.id === state.active ? ' active' : '');

      var main = document.createElement('div');
      main.className = 'model-main';
      var name = document.createElement('div');
      name.className = 'model-name';
      name.textContent = p.label;
      var sub = document.createElement('div');
      sub.className = 'model-sub';
      sub.textContent = PROVIDER_NAME[p.provider] + ' · ' + p.model;
      main.appendChild(name);
      main.appendChild(sub);
      if (p.provider !== 'ollama' && !p.hasKey) {
        var warn = document.createElement('div');
        warn.className = 'model-warn';
        warn.textContent = p.provider === 'anthropic' ? 'Falta la API key' : 'Sin API key (solo si el servidor la pide)';
        main.appendChild(warn);
      }
      item.appendChild(main);

      if (p.id !== state.active) {
        var use = document.createElement('button');
        use.className = 'btn btn-xs btn-ok';
        use.textContent = 'Usar';
        use.onclick = function () {
          api.invoke(ch.modelsSetActive, p.id).then(function (s) { renderModels(s); showToast('Modelo: ' + p.label); });
        };
        item.appendChild(use);
      }
      var edit = document.createElement('button');
      edit.className = 'btn btn-xs';
      edit.textContent = 'Editar';
      edit.onclick = function () { openModelForm(p); };
      item.appendChild(edit);
      var del = document.createElement('button');
      del.className = 'btn btn-xs btn-danger';
      del.textContent = '✗';
      del.title = 'Quitar este modelo';
      del.onclick = function () {
        if (!window.confirm('¿Quitar "' + p.label + '"? También se borra su API key guardada.')) return;
        api.invoke(ch.modelsDelete, p.id).then(renderModels);
      };
      item.appendChild(del);
      modelList.appendChild(item);

      if (p.id === state.active) {
        modelChip.textContent = p.label;
        modelChip.title = 'Modelo activo: ' + p.model + ' (clic para cambiar)';
      }
    });
  }

  function loadModels() {
    api.invoke(ch.modelsList).then(renderModels);
  }

  document.getElementById('model-add').addEventListener('click', function () { openModelForm(null); });
  document.getElementById('mf-cancel').addEventListener('click', function () { mForm.hidden = true; });
  mf.provider.addEventListener('change', function () { applyProviderUI(false); });

  mf.detect.addEventListener('click', function () {
    mfError('');
    api.invoke(ch.modelsDetect, mf.url.value.trim() || undefined).then(function (r) {
      if (r.error) { mfError(r.error); return; }
      mf.models.innerHTML = '';
      r.models.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        mf.models.appendChild(o);
      });
      if (r.models.length === 0) { mfError('Ollama no tiene modelos instalados. Descarga uno con: ollama pull qwen3:8b'); return; }
      if (!mf.model.value) mf.model.value = r.models[0];
      if (!mf.label.value) mf.label.value = r.models[0] + ' (local)';
      showToast(r.models.length + ' modelos encontrados');
    });
  });

  mForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = mf.provider.value;
    var payload = { label: mf.label.value.trim(), provider: p, model: mf.model.value.trim() };
    if (editing) payload.id = editing.id;
    if (p !== 'anthropic' && mf.url.value.trim()) payload.base_url = mf.url.value.trim();
    if (p === 'ollama' && mf.ctx.value) payload.num_ctx = Number(mf.ctx.value);
    if (p !== 'anthropic' && mf.pin.value !== '' && mf.pout.value !== '') {
      payload.price_in = Number(mf.pin.value);
      payload.price_out = Number(mf.pout.value);
    }
    if (p !== 'ollama' && mf.key.value.trim()) payload.api_key = mf.key.value.trim();
    api.invoke(ch.modelsSave, payload).then(function (res) {
      mf.key.value = '';
      if (res && res.error) { mfError(res.error); return; }
      mForm.hidden = true;
      renderModels(res);
      showToast('Modelo guardado');
    });
  });

  // ── Ajustes: avatar (niño o niña), avisos y sonido
  function renderSettings(s) {
    if (!s || s.error) { if (s && s.error) showToast(s.error); return; }
    avatarChoices.innerHTML = '';
    window.AgentikAvatars.IDS.forEach(function (id) {
      var def = window.AgentikAvatars.get(id);
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'avatar-choice' + (s.avatar === id ? ' selected' : '');
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      card.appendChild(svg);
      window.AgentikAvatars.build(svg, id);
      // El mismo motor dibuja la miniatura (cara sonriente), pero quieta: sin animación
      window.AgentikAvatar.mount(svg, { geometry: def.geometry, autoStart: false, random: function () { return 0.5; } });
      var name = document.createElement('span');
      name.textContent = def.label;
      card.appendChild(name);
      card.onclick = function () { api.invoke(ch.settingsSet, { avatar: id }).then(function (r) { renderSettings(r); showToast('Avatar: ' + def.label); }); };
      avatarChoices.appendChild(card);
    });
    setNotif.checked = !!s.notifications;
    setSound.checked = !!s.sounds;
  }

  function loadSettings() {
    api.invoke(ch.settingsGet).then(renderSettings);
  }

  setNotif.addEventListener('change', function () { api.invoke(ch.settingsSet, { notifications: setNotif.checked }); });
  setSound.addEventListener('change', function () { api.invoke(ch.settingsSet, { sounds: setSound.checked }); });
  document.getElementById('set-test').addEventListener('click', function () { window.AgentikSounds.playPop(); });

  // ── Guía de inicio: se abre sola la primera vez; después con el botón "?" o desde Ajustes
  var G = window.AgentikOnboarding;
  var guideIdx = 0;
  var guideState = { hasModel: false, folders: 0, observing: false, chatted: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function guideGo(target) {
    if (target === 'observer') {
      if (!current.enabled) api.invoke(ch.observerSetEnabled, true).then(function (s) { renderStatus(s); renderGuide(); });
      return;
    }
    showTab(target);
  }

  function renderGuide() {
    Promise.all([api.invoke(ch.modelsList), api.invoke(ch.configGetFolders)]).then(function (r) {
      var profiles = (r[0] && r[0].profiles) || [];
      guideState.hasModel = profiles.some(function (p) { return p.provider === 'ollama' || p.hasKey; });
      guideState.folders = (r[1] || []).length;
      guideState.observing = !!current.enabled;
      guideState.chatted = !!messages.querySelector('.msg-user');
      drawGuide();
    });
  }

  function drawGuide() {
    var step = G.STEPS[guideIdx];
    var body = document.getElementById('guide-body');
    body.innerHTML = '';
    body.appendChild(el('h3', 'guide-title', step.title));
    if (!step.checklist && !step.examples) {
      step.body.forEach(function (t) { body.appendChild(el('p', 'guide-text', t)); });
    }
    if (step.checklist) {
      var items = G.checklist(guideState);
      body.appendChild(el('p', 'guide-text', G.progress(items).text + '. ' + step.body[0]));
      items.forEach(function (it) {
        var row = el('div', 'guide-item' + (it.done ? ' done' : ''));
        row.appendChild(el('span', 'guide-check', it.done ? '✓' : '○'));
        var txt = el('div', 'guide-item-text');
        txt.appendChild(el('div', 'guide-item-title', it.title));
        txt.appendChild(el('div', 'muted', it.hint));
        row.appendChild(txt);
        if (!it.done) {
          var go = el('button', 'btn btn-xs btn-ok', it.goLabel);
          go.type = 'button';
          go.onclick = function () { guideGo(it.go); };
          row.appendChild(go);
        }
        body.appendChild(row);
      });
    }
    if (step.examples) {
      body.appendChild(el('p', 'guide-text', step.body[0]));
      G.EXAMPLES.forEach(function (ex) {
        var b = el('button', 'guide-example');
        b.type = 'button';
        b.appendChild(el('span', 'guide-example-text', '«' + ex.text + '»'));
        b.appendChild(el('span', 'muted', ex.note));
        b.onclick = function () { showTab('chat'); chatInput.value = ex.text; chatInput.focus(); };
        body.appendChild(b);
      });
    }
    var last = guideIdx === G.STEPS.length - 1;
    document.getElementById('guide-back').hidden = guideIdx === 0;
    document.getElementById('guide-skip').hidden = last;
    document.getElementById('guide-next').textContent = last ? 'Listo' : 'Siguiente';
    var dots = document.getElementById('guide-dots');
    dots.innerHTML = '';
    G.STEPS.forEach(function (s, i) { dots.appendChild(el('span', 'guide-dot' + (i === guideIdx ? ' on' : ''))); });
  }

  function openGuide() { guideIdx = 0; showTab('guide'); }
  function closeGuide() {
    api.invoke(ch.settingsSet, { onboarding_done: true });
    showTab('chat');
  }
  document.getElementById('guide-open').addEventListener('click', openGuide);
  document.getElementById('set-guide').addEventListener('click', openGuide);
  document.getElementById('guide-skip').addEventListener('click', closeGuide);
  document.getElementById('guide-back').addEventListener('click', function () { guideIdx = Math.max(0, guideIdx - 1); drawGuide(); });
  document.getElementById('guide-next').addEventListener('click', function () {
    if (guideIdx >= G.STEPS.length - 1) { closeGuide(); return; }
    guideIdx++;
    renderGuide();
  });

  // Tabs
  tabChat.addEventListener('click', function () { showTab('chat'); });
  tabMemory.addEventListener('click', function () { showTab('memory'); });
  tabFiles.addEventListener('click', function () { showTab('files'); });
  tabModels.addEventListener('click', function () { showTab('models'); });
  tabSettings.addEventListener('click', function () { showTab('settings'); });
  modelChip.addEventListener('click', function () { showTab('models'); });

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

  // Detener lo que Agentik esté haciendo (también con Esc)
  function stopNow() {
    chatStop.disabled = true;
    api.invoke(ch.chatStop).then(function () { chatStop.disabled = false; });
  }
  chatStop.addEventListener('click', stopNow);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !thinking.hidden) stopNow();
  });

  // Borrar el historial (del chat y del disco)
  function clearHistory() {
    if (!window.confirm('¿Borrar todo el historial del chat? Se elimina de tu Mac y no se puede deshacer.')) return;
    api.invoke(ch.chatClearHistory).then(function () {
      messages.innerHTML = '';
      chatTools.hidden = true;
      showToast('Historial borrado');
    });
  }
  document.getElementById('chat-clear').addEventListener('click', clearHistory);
  document.getElementById('set-clear').addEventListener('click', clearHistory);

  // Al abrir la app, vuelve el historial guardado
  api.invoke(ch.chatHistory).then(function (rows) {
    (rows || []).forEach(function (m) { addMessage(m.role, m.content); });
  });

  // Thinking indicator
  api.on(ch.chatThinking, function (on) {
    thinking.hidden = !on;
    if (on) messages.scrollTop = messages.scrollHeight;
  });

  // Agentik propuso recuerdos por su cuenta (proyectos y hábitos): actualiza la lista y el contador
  api.on(ch.memoryRefresh, function () { loadMemories(); });

  // Mensajes locales (resumen) y chat nuevo desde atajos
  api.on(ch.chatReply, function (text) { showTab('chat'); addMessage('assistant', text); });
  api.on(ch.chatClear, function () { messages.innerHTML = ''; chatTools.hidden = true; showTab('chat'); });

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
  loadModels();
  loadMemories();
  api.invoke(ch.settingsGet).then(function (s) { if (s && !s.onboarding_done) openGuide(); }); // primera vez
  api.on(ch.observerChanged, renderStatus);
  api.invoke(ch.observerStatus).then(renderStatus);
})();
