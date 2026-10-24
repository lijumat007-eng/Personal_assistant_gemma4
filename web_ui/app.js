// Jarvis: chat first, tools on demand. All requests use the existing same-origin APIs.
'use strict';
const $ = id => document.getElementById(id);
const drawer = $('tool-drawer');
const menu = $('app-menu');
const input = $('query-input');
const history = $('chat-history');
const scroll = $('chat-scroll');
const emptyState = $('empty-state');
let busy = false;
let pendingApproval = null;
let currentWorkspacePath = '';
let currentFile = null;
let fileReadVersion = 0;
let tree = [];
let expandedFolders = new Set();
let provider = 'ollama';
let reasoningLoading = false, modelsLoading = false, cloudKeyConfigured = false;
let reasoningVersion = 0, modelsVersion = 0, preferredLocalModel = '';
let isMuted = readPreference('jarvis_muted') === 'true';
let recording = null;
let startingRecording = false;
let speaking = false;
let speechPending = false;
let speechTimer;
let speechVersion = 0;
let companionError = false;
let companionModule;
function companionState() {
    return { busy, approval: !!pendingApproval, recording: !!recording, speaking, speechPending, error: companionError };
}
function publishCompanionState() {
    window.dispatchEvent(new CustomEvent('jarvis:state', { detail: companionState() }));
}
function stopSpeech() {
    speechVersion++;
    clearTimeout(speechTimer);
    window.speechSynthesis?.cancel();
    speaking = false;
    speechPending = false;
    publishCompanionState();
}
window.jarvisCompanion = { getState: companionState, stopSpeech,
    getMuted: () => isMuted, setMuted: setMuted,
    openTool: name => { if (['files', 'settings', 'reset'].includes(name)) openDrawer(name); },
    startVoice: () => startRecording(), cancelVoice: () => stopRecording(false),
    reconnect: async () => {
        // Acquire the new session cookie after an explicitly restarted backend.
        const root = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
        if (!root.ok) throw new Error('Assistant is unavailable.');
        await api('/api/agent/status'); companionError = false; publishCompanionState();
    },
    testVoice: () => speakResponse('Hello! I am your little Jarvis companion. Big ideas, tiny robot. Let’s build something fun together.', true) };
function setMuted(value) {
    isMuted = value === true;
    $('voice-output').checked = !isMuted;
    savePreference('jarvis_muted', String(isMuted));
    if (isMuted) stopSpeech();
    window.dispatchEvent(new CustomEvent('jarvis:preferences', { detail: { muted: isMuted } }));
}
async function showRobotPreview(show = true) {
    closeMenu();
    $('robot-stage').hidden = !show;
    document.body.classList.toggle('companion-mode', show);
    const url = new URL(location.href);
    if (show) url.searchParams.set('companion', 'robot'); else url.searchParams.delete('companion');
    window.history.replaceState(null, '', url);
    $('robot-preview-button').textContent = show ? 'Hide robot companion' : 'Robot companion';
    if (!show) { input.focus({ preventScroll: true }); return; }
    $('close-robot').focus({ preventScroll: true });
    try {
        companionModule ||= import('./robot.js?v=1').catch(error => { companionModule = null; throw error; });
        const module = await companionModule;
        await module.initialize();
    } catch (error) {
        $('robot-status').textContent = `Robot preview unavailable. ${error.message} Chat is still available.`;
    }
}
$('robot-preview-button').addEventListener('click', () => showRobotPreview($('robot-stage').hidden));
$('close-robot').addEventListener('click', () => showRobotPreview(false));

function readPreference(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}
function savePreference(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* The UI also works without storage. */ }
}
function setTheme(theme) {
    const known = ['light', 'dark', 'warm'];
    if (['stark', 'obsidian', 'cyberpunk'].includes(theme)) theme = 'dark';
    if (!known.includes(theme)) theme = 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('input[name="theme"]').forEach(radio => { radio.checked = radio.value === theme; });
    savePreference('jarvis_theme', theme);
}
setTheme(readPreference('jarvis_theme'));
$('voice-output').checked = !isMuted;
document.querySelectorAll('input[name="theme"]').forEach(radio => radio.addEventListener('change', () => setTheme(radio.value)));
$('voice-output').addEventListener('change', () => {
    setMuted(!$('voice-output').checked);
});

async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.response || `Request failed (${response.status}).`);
    return data;
}
function post(path, data) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
function syncControls() {
    $('send-btn').disabled = busy || !!recording || startingRecording || !input.value.trim();
    $('send-btn').hidden = !!recording;
    $('voice-input-button').disabled = busy || !!pendingApproval || !!recording || startingRecording;
    document.querySelectorAll('[data-mutation]').forEach(button => { button.disabled = busy || !!pendingApproval || !!recording || startingRecording; });
    $('settings-lock').hidden = !pendingApproval;
    syncReasoningControls();
    if (pendingApproval) pendingApproval.card.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    publishCompanionState();
}
function setBusy(value, label = 'Working…') {
    busy = value;
    if (value) { companionError = false; stopSpeech(); }
    $('working-status').textContent = label;
    $('working-status').hidden = !value;
    history.setAttribute('aria-busy', String(value));
    syncControls();
}
function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    syncControls();
}
input.addEventListener('input', resizeInput);

function closeMenu(restoreFocus = false) {
    menu.hidden = true;
    $('menu-button').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('menu-button').focus({ preventScroll: true });
}
function toggleMenu() {
    if (drawer.open) return;
    const opening = menu.hidden;
    closeMenu();
    if (opening) {
        menu.hidden = false;
        $('menu-button').setAttribute('aria-expanded', 'true');
        menu.querySelector('button').focus({ preventScroll: true });
    }
}
$('menu-button').addEventListener('click', toggleMenu);
document.addEventListener('click', event => {
    if (!event.target.closest('.menu-anchor')) closeMenu();
});
menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    let index = buttons.indexOf(document.activeElement);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
});
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggleMenu();
    } else if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        closeMenu(true);
    }
});
menu.addEventListener('focusout', event => {
    if (!event.relatedTarget?.closest('.menu-anchor')) closeMenu();
});
function clearDrawerError() {
    $('drawer-error').textContent = '';
    $('drawer-error').hidden = true;
}
function showDrawerError(error) {
    $('drawer-error').textContent = error.message;
    $('drawer-error').hidden = false;
    appendMessage('assistant', error.message, [], true, false);
}
function openDrawer(view) {
    closeMenu();
    clearDrawerError();
    ['files', 'settings', 'reasoning', 'reset'].forEach(name => { $(`${name}-view`).hidden = name !== view; });
    $('drawer-title').textContent = { files: 'Files', settings: 'Settings', reasoning: 'Choose reasoning', reset: 'Reset conversation' }[view];
    if (view === 'files') {
        showFileBrowser();
        loadFiles();
    } else if (view === 'settings') loadAgentStatus();
    else if (view === 'reasoning') loadReasoning();
    if (!drawer.open) drawer.showModal();
    $('close-drawer').focus({ preventScroll: true });
    syncControls();
}
document.querySelectorAll('[data-drawer]').forEach(button => button.addEventListener('click', () => openDrawer(button.dataset.drawer)));
$('close-drawer').addEventListener('click', () => drawer.close());
$('cancel-reset').addEventListener('click', () => drawer.close());
drawer.addEventListener('close', () => (document.body.classList.contains('desktop-mode') ? input : $('menu-button')).focus({ preventScroll: true }));
drawer.addEventListener('close', () => { $('cloud-key-input').value = ''; reasoningVersion++; });
drawer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drawer.close(); }
});
drawer.addEventListener('click', event => {
    if (event.target !== drawer) return;
    const bounds = drawer.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) drawer.close();
});

function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; }
function scrollToBottom() { scroll.scrollTop = scroll.scrollHeight; }
function appendMessage(sender, text, steps = [], error = false, forceScroll = true) {
    if (error) { companionError = true; publishCompanionState(); }
    const follow = forceScroll || nearBottom();
    emptyState.remove();
    const message = document.createElement('article');
    message.className = `message ${sender === 'user' ? 'user-message' : 'assistant-message'}${error ? ' error-message' : ''}`;
    message.setAttribute('aria-label', sender === 'user' ? 'You' : 'Jarvis');
    if (sender === 'user') message.textContent = text;
    else {
        const body = document.createElement('div');
        body.className = 'message-body';
        // Keep the established allowlist sanitizer; degrade safely if the Markdown CDN is offline.
        if (typeof marked !== 'undefined') body.innerHTML = renderSafeMarkdown(text);
        else { body.textContent = text; body.style.whiteSpace = 'pre-wrap'; }
        message.append(body);
        if (text) {
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const copy = document.createElement('button');
            copy.className = 'copy-button';
            copy.textContent = 'Copy';
            copy.setAttribute('aria-label', 'Copy response');
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    copy.textContent = 'Copied';
                } catch (_) { copy.textContent = 'Could not copy'; }
                setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
            });
            actions.append(copy);
            message.append(actions);
        }
        appendActivity(message, steps);
    }
    history.append(message);
    if (follow) scrollToBottom();
    return message;
}
function appendActivity(container, steps) {
    if (!steps?.length) return;
    const details = document.createElement('details');
    details.className = 'activity';
    const summary = document.createElement('summary');
    summary.textContent = `View activity · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
    const list = document.createElement('ol');
    steps.forEach(step => {
        const item = document.createElement('li');
        const label = document.createElement('div');
        label.className = 'step-label';
        const state = step.status || (String(step.result || '').includes('[BLOCKED') ? 'blocked' : 'success');
        label.textContent = `${step.tool || 'Action'} · ${state}`;
        const content = document.createElement('pre');
        content.textContent = `${JSON.stringify(step.args || {}, null, 2)}\n${step.result || ''}`;
        item.append(label, content);
        list.append(item);
    });
    details.append(summary, list);
    container.append(details);
}
function speakResponse(text, force = false) {
    if ((isMuted && !force) || !window.speechSynthesis) return;
    stopSpeech();
    const spoken = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken.length > 230 ? `${spoken.slice(0, 200)}. Details displayed on screen.` : spoken);
    utterance.rate = 1.05;
    utterance.lang = 'en-US';
    const version = speechVersion;
    speechPending = true;
    publishCompanionState();
    utterance.onstart = () => { if (version === speechVersion) { clearTimeout(speechTimer); speechPending = false; speaking = true; publishCompanionState(); } };
    const finished = () => { if (version === speechVersion) { clearTimeout(speechTimer); speechPending = false; speaking = false; publishCompanionState(); } };
    utterance.onend = finished;
    utterance.onerror = () => {
        if (version !== speechVersion) return;
        finished();
        window.dispatchEvent(new CustomEvent('jarvis:speech-error'));
    };
    // Keep the utterance alive until its browser callbacks finish.
    window.jarvisCompanion.utterance = utterance;
    speechTimer = setTimeout(() => {
        if (version !== speechVersion || !speechPending) return;
        stopSpeech();
        window.dispatchEvent(new CustomEvent('jarvis:speech-error'));
    }, 10000);
    try { window.speechSynthesis.speak(utterance); } catch (_) { utterance.onerror(); }
}
function showApproval(data) {
    emptyState.remove();
    const follow = nearBottom();
    const card = document.createElement('article');
    card.className = 'approval-card';
    card.setAttribute('aria-label', 'Approval required');
    const title = document.createElement('h3');
    title.textContent = 'Approval required';
    const description = document.createElement('p');
    description.textContent = data.description || 'Review this action before continuing.';
    const actions = document.createElement('div');
    actions.className = 'button-row';
    const approve = document.createElement('button');
    approve.className = 'primary-button';
    approve.textContent = 'Approve';
    const deny = document.createElement('button');
    deny.className = 'secondary-button';
    deny.textContent = 'Cancel';
    approve.addEventListener('click', () => submitApproval(true));
    deny.addEventListener('click', () => submitApproval(false));
    actions.append(approve, deny);
    card.append(title, description, actions);
    appendActivity(card, data.steps || []);
    history.append(card);
    pendingApproval = { id: data.approval_id, card, actions };
    syncControls();
    if (follow) scrollToBottom();
    speakResponse(`Approval required. ${description.textContent}`);
}
function handleResult(data) {
    companionError = data.status === 'error' || data.status === 'blocked';
    if (data.status === 'pending_approval') showApproval(data);
    else {
        appendMessage('assistant', data.response || 'Done.', data.steps || [], data.status === 'error' || data.status === 'blocked', false);
        if (data.status !== 'error') speakResponse(data.response);
        if (data.status === 'success') window.dispatchEvent(new CustomEvent('jarvis:reaction', { detail: 'ThumbsUp' }));
    }
    // Refresh an open explorer without moving the conversation or opening tools.
    if (drawer.open && !$('files-view').hidden) loadFiles();
}
async function submitQuery() {
    const query = input.value.trim();
    if (!query || busy || recording || startingRecording) return;
    if (pendingApproval) {
        const answer = query.toLowerCase();
        if (['yes', 'proceed', 'approve', 'ok', 'go ahead', 'confirm', 'y'].includes(answer)) {
            input.value = ''; resizeInput(); await submitApproval(true);
        } else if (['no', 'deny', 'cancel', 'stop', 'n'].includes(answer)) {
            input.value = ''; resizeInput(); await submitApproval(false);
        } else appendMessage('assistant', 'Approve or cancel the pending action before sending another message.', [], true);
        return;
    }
    appendMessage('user', query);
    input.value = ''; resizeInput();
    setBusy(true);
    try { handleResult(await post('/api/query', { query })); }
    catch (error) { appendMessage('assistant', `Could not send your message. ${error.message}`, [], true, false); }
    finally { setBusy(false); }
}
$('composer').addEventListener('submit', event => { event.preventDefault(); submitQuery(); });
input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitQuery(); }
});
async function submitApproval(approved) {
    if (!pendingApproval || busy) return;
    const active = pendingApproval;
    setBusy(true);
    try {
        const data = await post('/api/approve', { approval_id: active.id, approved });
        // An error without executed steps leaves the decision unresolved and retryable.
        if (data.status === 'error' && !data.steps?.length) throw new Error(data.response || 'Please try again.');
        active.actions.replaceChildren();
        const result = document.createElement('span');
        result.className = 'approval-result';
        result.textContent = approved ? 'Approved' : 'Cancelled';
        active.actions.append(result);
        pendingApproval = null;
        handleResult(data);
    } catch (error) {
        appendMessage('assistant', `Approval could not be completed. ${error.message} You can retry the decision above.`, [], true, false);
    } finally { setBusy(false); }
}

async function mutate(action, onSuccess) {
    if (busy || pendingApproval || recording || startingRecording) return;
    clearDrawerError();
    setBusy(true);
    try {
        const data = await action();
        if (data.status === 'error') throw new Error(data.response || data.detail || 'The operation failed.');
        if (onSuccess) await onSuccess(data);
    } catch (error) { showDrawerError(error); }
    finally { setBusy(false); }
}
async function loadAgentStatus() {
    try {
        const data = await api('/api/agent/status');
        provider = data.provider || 'ollama';
        $('active-provider-label').textContent = provider === 'ollama' ? 'Local · Ollama' : 'Cloud · Gemini';
        $('agent-model-name').textContent = data.model_name || 'Unavailable';
    } catch (error) { $('agent-model-name').textContent = 'Unavailable'; showDrawerError(error); }
}
function syncReasoningControls() {
    const local = $('provider-select').value === 'ollama';
    $('local-reasoning-fields').hidden = !local;
    $('cloud-reasoning-fields').hidden = local;
    const locked = busy || !!pendingApproval || !!recording || startingRecording;
    $('provider-select').disabled = locked || reasoningLoading;
    $('refresh-models').disabled = locked || modelsLoading;
    $('local-model-select').disabled = locked || modelsLoading;
    $('save-reasoning').disabled = locked || reasoningLoading || (local ? modelsLoading || !$('local-model-select').value : !$('cloud-model-input').value.trim() || (!cloudKeyConfigured && !$('cloud-key-input').value.trim()));
}
async function loadLocalModels() {
    const version = ++modelsVersion;
    const selected = $('local-model-select').value || preferredLocalModel;
    modelsLoading = true; syncReasoningControls();
    $('local-model-status').textContent = 'Loading installed models…';
    try {
        const data = await api('/api/agent/models');
        if (version !== modelsVersion) return;
        const models = data.models || [];
        $('local-model-select').replaceChildren(new Option('Choose a model…', ''));
        models.forEach(model => $('local-model-select').add(new Option(model.name, model.name)));
        $('local-model-select').value = selected;
        $('local-model-status').textContent = models.length ? `${models.length} installed model${models.length === 1 ? '' : 's'}.` : 'No models installed. Install a model in Ollama, then refresh.';
    } catch (error) {
        if (version !== modelsVersion) return;
        $('local-model-select').replaceChildren(new Option('Models unavailable', ''));
        $('local-model-status').textContent = error.message;
    } finally { if (version === modelsVersion) { modelsLoading = false; syncReasoningControls(); } }
}
async function loadReasoning() {
    const version = ++reasoningVersion;
    reasoningLoading = true; $('reasoning-status').textContent = 'Loading settings…';
    $('cloud-key-input').value = ''; syncReasoningControls();
    try {
        const data = await api('/api/agent/options');
        if (version !== reasoningVersion) return;
        provider = data.provider || 'ollama';
        $('provider-select').value = provider;
        preferredLocalModel = data.local_model || '';
        $('local-model-select').replaceChildren(new Option('Choose a model…', ''));
        $('cloud-model-input').value = data.cloud_model || 'gemini-2.5-flash';
        cloudKeyConfigured = data.cloud_key_configured === true;
        $('cloud-key-status').textContent = cloudKeyConfigured ? 'A key is configured. Leave blank to keep it, or enter a replacement.' : 'Enter your Gemini API key to use Cloud.';
        $('reasoning-status').textContent = `Current: ${provider === 'ollama' ? 'Local' : 'Cloud'} · ${data.model_name || 'Not configured'}`;
        if (provider === 'ollama') await loadLocalModels();
    } catch (error) { if (version === reasoningVersion) $('reasoning-status').textContent = error.message; }
    finally { if (version === reasoningVersion) { reasoningLoading = false; syncReasoningControls(); } }
}
$('provider-select').addEventListener('change', () => {
    syncReasoningControls();
    if ($('provider-select').value === 'ollama') loadLocalModels();
});
['local-model-select', 'cloud-model-input', 'cloud-key-input'].forEach(id => $(id).addEventListener('input', syncReasoningControls));
$('refresh-models').addEventListener('click', loadLocalModels);
$('cancel-reasoning').addEventListener('click', () => drawer.close());
$('reasoning-form').addEventListener('submit', async event => {
    event.preventDefault();
    if ($('save-reasoning').disabled) return;
    const local = $('provider-select').value === 'ollama';
    const payload = { provider: local ? 'ollama' : 'gemini', model_name: local ? $('local-model-select').value : $('cloud-model-input').value.trim() };
    if (!local && $('cloud-key-input').value.trim()) payload.api_key = $('cloud-key-input').value.trim();
    setBusy(true, 'Updating reasoning…');
    try {
        const data = await post('/api/agent/config', payload);
        if (data.status === 'error') throw new Error(data.detail || 'Could not change reasoning settings.');
        provider = data.provider;
        $('agent-model-name').textContent = data.model_name;
        drawer.close();
    } catch (error) { $('reasoning-status').textContent = error.message; }
    finally { setBusy(false); }
});
$('confirm-reset').addEventListener('click', () => mutate(() => post('/api/agent/clear', {}), () => {
    history.replaceChildren(emptyState);
    input.value = ''; resizeInput();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    drawer.close();
    scrollToBottom();
}));

async function loadFiles() {
    try {
        const workspace = await api('/api/workspace');
        currentWorkspacePath = workspace.working_dir || '';
        $('workspace-path').textContent = currentWorkspacePath || workspace.root_name || 'Workspace';
        const data = await api('/api/explorer');
        tree = data.tree || [];
        renderTree();
    } catch (error) { showDrawerError(error); }
}
function renderTree() {
    const query = $('explorer-search').value.trim().toLowerCase();
    const root = $('explorer-tree');
    root.replaceChildren();
    function matches(item) { return item.name.toLowerCase().includes(query) || (item.children || []).some(matches); }
    function render(items, container, showAll = false) {
        items.filter(item => !query || showAll || matches(item)).forEach(item => {
            const row = document.createElement('button');
            row.className = 'tree-row';
            const key = item.path || item.name;
            const expanded = !!query || expandedFolders.has(key);
            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.setAttribute('aria-hidden', 'true');
            marker.textContent = item.is_dir ? (expanded ? '⌄' : '›') : '·';
            const name = document.createElement('span');
            name.className = 'tree-name'; name.textContent = item.name;
            row.append(marker, name);
            if (item.is_dir) {
                row.setAttribute('aria-expanded', String(expanded));
                row.setAttribute('aria-label', `${item.name}, folder`);
                row.addEventListener('click', () => {
                    // Exit search before toggling a folder; searches expand matching ancestors.
                    if (query) $('explorer-search').value = '';
                    if (expandedFolders.has(key)) expandedFolders.delete(key); else expandedFolders.add(key);
                    renderTree();
                });
                container.append(row);
                if (expanded) {
                    const children = document.createElement('div'); children.className = 'tree-children';
                    render(item.children || [], children, showAll || (!!query && item.name.toLowerCase().includes(query)));
                    if (!children.childElementCount) children.textContent = 'Empty folder';
                    container.append(children);
                }
            } else {
                row.addEventListener('click', () => openFile(key));
                container.append(row);
            }
        });
    }
    render(tree, root);
    if (!root.childElementCount) {
        const note = document.createElement('p'); note.className = 'muted';
        note.textContent = query ? 'No matching files.' : 'This workspace is empty.';
        root.append(note);
    }
}
function showFileBrowser() {
    fileReadVersion++;
    $('file-browser').hidden = false;
    $('create-form').hidden = true;
    $('file-viewer').hidden = true;
    $('workspace-form').hidden = true;
    currentFile = null;
}
$('explorer-search').addEventListener('input', renderTree);
$('refresh-files').addEventListener('click', () => { clearDrawerError(); loadFiles(); });
$('change-workspace').addEventListener('click', () => {
    $('workspace-form').hidden = false;
    $('workspace-input').value = currentWorkspacePath;
    $('workspace-input').focus();
});
$('cancel-workspace').addEventListener('click', () => { $('workspace-form').hidden = true; $('change-workspace').focus(); });
$('workspace-form').addEventListener('submit', event => {
    event.preventDefault();
    const path = $('workspace-input').value.trim();
    if (!path) return;
    mutate(() => post('/api/workspace', { path }), async () => {
        expandedFolders.clear(); $('explorer-search').value = '';
        $('workspace-form').hidden = true; await loadFiles(); $('change-workspace').focus();
    });
});
let creatingFolder = false;
function openCreate(folder) {
    clearDrawerError(); creatingFolder = folder;
    $('file-browser').hidden = true; $('file-viewer').hidden = true; $('create-form').hidden = false;
    $('create-form').reset();
    $('create-title').textContent = folder ? 'New folder' : 'New file';
    $('file-content-field').hidden = folder;
    $('item-name').placeholder = folder ? 'research or docs/plans' : 'notes.txt';
    $('item-name').focus();
}
$('new-file').addEventListener('click', () => openCreate(false));
$('new-folder').addEventListener('click', () => openCreate(true));
$('cancel-create').addEventListener('click', () => { showFileBrowser(); $('new-file').focus(); });
$('create-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('item-name').value.trim();
    if (!name) return;
    mutate(() => creatingFolder ? post('/api/explorer/create_folder', { path: name }) : post('/api/explorer/create_note', { filename: name, content: $('item-content').value }), async () => {
        showFileBrowser(); await loadFiles(); $('explorer-search').focus();
    });
});
async function openFile(path) {
    const version = ++fileReadVersion;
    currentFile = path; clearDrawerError();
    $('file-browser').hidden = true; $('create-form').hidden = true; $('file-viewer').hidden = false;
    $('delete-confirmation').hidden = true;
    $('file-title').textContent = path; $('file-body').textContent = 'Loading…';
    $('back-to-files').focus();
    try {
        const data = await api(`/api/notes/${encodeURIComponent(path)}`);
        if (version !== fileReadVersion) return;
        $('file-body').textContent = String(data.content || '').replace(/^Here is '[^']+':\s*/, '');
    } catch (error) {
        if (version !== fileReadVersion) return;
        $('file-body').textContent = 'Could not open this file.'; showDrawerError(error);
    }
}
$('back-to-files').addEventListener('click', () => { showFileBrowser(); $('explorer-search').focus(); });
$('delete-file').addEventListener('click', () => { $('delete-confirmation').hidden = false; $('cancel-delete').focus(); });
$('cancel-delete').addEventListener('click', () => { $('delete-confirmation').hidden = true; $('delete-file').focus(); });
$('confirm-delete').addEventListener('click', () => {
    if (!currentFile) return;
    const path = currentFile;
    mutate(() => api(`/api/notes/${encodeURIComponent(path)}`, { method: 'DELETE' }), async () => {
        showFileBrowser(); await loadFiles(); $('explorer-search').focus();
    });
});

// Preserve the 16 kHz PCM WAV upload expected by /api/voice_query.
async function startRecording() {
    if (busy || pendingApproval || recording || startingRecording) return;
    closeMenu(true);
    startingRecording = true; syncControls();
    let stream, context;
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Voice input is unavailable in this browser.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await context.resume();
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(2048, 1, 1);
        const analyser = context.createAnalyser(); analyser.fftSize = 256;
        const silentGain = context.createGain(); silentGain.gain.value = 0;
        const chunks = [];
        processor.onaudioprocess = event => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
        source.connect(analyser); source.connect(processor); processor.connect(silentGain); silentGain.connect(context.destination);
        recording = { stream, context, source, processor, analyser, silentGain, chunks, frame: null };
        input.hidden = true; $('recording-controls').hidden = false;
        drawWaveform(); $('finish-recording').focus();
    } catch (error) {
        stream?.getTracks().forEach(track => track.stop());
        if (context && context.state !== 'closed') await context.close().catch(() => {});
        appendMessage('assistant', `Could not start voice input. ${error.message}`, [], true);
    } finally { startingRecording = false; syncControls(); }
}
function drawWaveform() {
    if (!recording) return;
    const canvas = $('visualizer-canvas');
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(recording.analyser.fftSize);
    recording.analyser.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    ctx.lineWidth = 1.5; ctx.beginPath();
    data.forEach((value, i) => {
        const x = i / (data.length - 1) * canvas.width;
        const y = value / 255 * canvas.height;
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    recording.frame = requestAnimationFrame(drawWaveform);
}
function bufferToWav(buffer, sampleRate) {
    const wav = new ArrayBuffer(44 + buffer.length * 2);
    const view = new DataView(wav);
    const write = (offset, value) => { [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0))); };
    write(0, 'RIFF'); view.setUint32(4, 36 + buffer.length * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, buffer.length * 2, true);
    buffer.forEach((value, i) => { const s = Math.max(-1, Math.min(1, value)); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); });
    return new Blob([view], { type: 'audio/wav' });
}
function stopRecording(upload = false) {
    if (!recording) return;
    const active = recording; recording = null;
    cancelAnimationFrame(active.frame);
    active.processor.onaudioprocess = null;
    active.processor.disconnect(); active.source.disconnect(); active.analyser.disconnect(); active.silentGain.disconnect();
    active.stream.getTracks().forEach(track => track.stop());
    active.context.close().catch(() => {});
    input.hidden = false; $('recording-controls').hidden = true; resizeInput(); input.focus({ preventScroll: true });
    if (upload) {
        const buffer = new Float32Array(active.chunks.reduce((count, chunk) => count + chunk.length, 0));
        let offset = 0; active.chunks.forEach(chunk => { buffer.set(chunk, offset); offset += chunk.length; });
        if (!buffer.length) { appendMessage('assistant', 'No audio was recorded. Please try again.', [], true); return; }
        // Resample if a browser ignores the requested context sample rate.
        const rate = active.context.sampleRate;
        let samples = buffer;
        if (rate !== 16000) {
            samples = new Float32Array(Math.floor(buffer.length * 16000 / rate));
            samples.forEach((_, i) => {
                const position = i * rate / 16000, left = Math.floor(position), mix = position - left;
                samples[i] = buffer[left] * (1 - mix) + buffer[Math.min(left + 1, buffer.length - 1)] * mix;
            });
        }
        uploadVoice(bufferToWav(samples, 16000));
    }
}
async function uploadVoice(blob) {
    setBusy(true);
    const form = new FormData(); form.append('file', blob, 'query.wav');
    try {
        const data = await api('/api/voice_query', { method: 'POST', body: form });
        if (data.transcription) appendMessage('user', data.transcription);
        handleResult(data);
    } catch (error) { appendMessage('assistant', `Voice input failed. ${error.message}`, [], true); }
    finally { setBusy(false); }
}
$('voice-input-button').addEventListener('click', startRecording);
$('finish-recording').addEventListener('click', () => stopRecording(true));
$('cancel-recording').addEventListener('click', () => stopRecording(false));
window.addEventListener('pagehide', () => { stopRecording(false); stopSpeech(); });
// Startup asks for reasoning without scanning the workspace.
resizeInput();
if (new URLSearchParams(location.search).get('companion') === 'robot') showRobotPreview();
async function startupReasoning() {
    if (window.jarvisDesktop && new URLSearchParams(location.search).get('desktop') === '1') {
        await import('./desktop.js?v=1');
        await window.jarvisDesktop.setPanelOpen(true);
    }
    openDrawer('reasoning');
}
startupReasoning().catch(error => { $('robot-status').textContent = `Startup settings unavailable. ${error.message}`; });
