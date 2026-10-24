'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { SIZES, clampBounds, sanitizeSettings, trustedPage } = require('./policy.cjs');
const { PointerLease } = require('./pointer-lease.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8000';
const PAGE = BASE + '/?companion=robot&desktop=1';
const OFFLINE = pathToFileURL(path.join(__dirname, 'offline.html')).href;
const DATA = path.join(__dirname, process.argv.includes('--smoke-test') ? '.user-data-test' : '.user-data');
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);
app.setName('Jarvis Companion');
const settingsFile = path.join(DATA, 'desktop-settings.json');
let settings;
try { settings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (_) { settings = sanitizeSettings(); }
let win, tray, backend, logStream, connecting = false, panelOpen = false, quitting = false, interactive = true, dragging = null, persistTimer;
let pointerTimer, popupMenu, quitTimer;
const pointerLease = new PointerLease();
function applyInteractive(value) {
    if (!win || win.isDestroyed() || interactive === value) return;
    interactive = value; win.setIgnoreMouseEvents(!value, { forward: true });
}
function endDrag() {
    if (!dragging) return;
    dragging = null; rememberPosition(); command('drag-cancelled');
}
function closePopup() {
    const active = popupMenu; popupMenu = null;
    active?.closePopup(win);
}
function quitCompanion() {
    closePopup(); pointerLease.clear(); endDrag(); app.quit();
}
function moveDrag(point = screen.getCursorScreenPoint()) {
    if (!dragging) return;
    if (!dragging.active && Math.hypot(point.x - dragging.cursor.x, point.y - dragging.cursor.y) < 5) return;
    dragging.active = true;
    if (point.x === dragging.last.x && point.y === dragging.last.y) return;
    dragging.last = point; dragging.time = Date.now();
    const moved = { ...dragging.bounds, x: dragging.bounds.x + point.x - dragging.cursor.x, y: dragging.bounds.y + point.y - dragging.cursor.y };
    win.setBounds(clampBounds(moved, areaFor(moved)));
}
function updatePointer() {
    if (!win || win.isDestroyed() || quitting) return;
    if (popupMenu) { applyInteractive(true); return; }
    if (!win.isVisible()) { pointerLease.clear(); applyInteractive(false); return; }
    if (!trustedPage(win.webContents.getURL(), BASE)) { applyInteractive(true); return; }
    const point = screen.getCursorScreenPoint(), bounds = win.getBounds(), now = Date.now();
    const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    if (dragging && (!inside || !pointerLease.fresh(now) || now - dragging.time > 1500)) endDrag();
    if (dragging) moveDrag(point);
    applyInteractive(!!dragging || (inside && pointerLease.captures(point, bounds, now)));
    if (inside) {
        const current = win.getBounds();
        command('cursor', { token: pointerLease.request(point, current, now), x: point.x - current.x, y: point.y - current.y });
    } else pointerLease.clear();
}
function showPopup() {
    closePopup(); endDrag(); applyInteractive(true);
    const menu = Menu.buildFromTemplate(menuTemplate()); popupMenu = menu;
    menu.popup({ window: win, callback: () => { if (popupMenu === menu) popupMenu = null; pointerLease.clear(); updatePointer(); } });
}

function persist() {
    try {
        const temporary = settingsFile + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(settings, null, 2));
        fs.renameSync(temporary, settingsFile);
    } catch (error) { console.error('Could not save desktop preferences:', error.message); }
}
function command(name, detail = {}) {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:command', { name, ...detail });
}
function trusted(event, allowOffline = false) {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
    return trustedPage(event.senderFrame.url, BASE) || (allowOffline && event.senderFrame.url === OFFLINE);
}
function areaFor(bounds) { return screen.getDisplayMatching(bounds).workArea; }
function compactPosition() {
    const size = SIZES[settings.size];
    const area = settings.position ? areaFor({ ...settings.position, ...size }) : screen.getPrimaryDisplay().workArea;
    return clampBounds({ ...size, ...(settings.position || { x: area.x + area.width - size.width - 24, y: area.y + area.height - size.height - 24 }) }, area);
}
function rememberPosition() {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds(), compact = SIZES[settings.size];
    settings.position = panelOpen ? { x: bounds.x + bounds.width - compact.width, y: bounds.y + bounds.height - compact.height } : { x: bounds.x, y: bounds.y };
    clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300);
}
function setPanel(open, focus = false) {
    if (!win || win.isDestroyed() || !trustedPage(win.webContents.getURL(), BASE)) return false;
    if (panelOpen !== open) {
        rememberPosition();
        panelOpen = open;
        const compact = compactPosition();
        const bounds = open ? { x: compact.x + compact.width - 860, y: compact.y + compact.height - 640, width: 860, height: 640 } : compact;
        win.setBounds(clampBounds(bounds, areaFor(compact)));
        pointerLease.clear(); updatePointer();
    }
    command('panel', { open });
    if (focus) { win.show(); win.focus(); command('focus-chat'); }
    return true;
}
function show(focus = false) {
    if (!win) return;
    if (focus) { win.show(); setPanel(true, true); } else win.showInactive();
    command('shown'); updateMenu();
}
function hide() {
    closePopup(); pointerLease.clear(); endDrag(); applyInteractive(false);
    command('hidden');
    win?.hide(); updateMenu();
}
function setMuted(muted) {
    settings.muted = muted; persist(); command('mute', { muted }); updateMenu();
}
function setSize(size) {
    rememberPosition(); settings.size = size;
    if (panelOpen) {
        const bounds = win.getBounds(); win.setBounds(clampBounds(bounds, areaFor(bounds)));
    } else win.setBounds(compactPosition());
    persist(); updateMenu();
}
function trayIcon() {
    const width = 32, bytes = Buffer.alloc(width * width * 4);
    function rect(x, y, w, h, r, g, b) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            const offset = (yy * width + xx) * 4;
            bytes[offset] = b; bytes[offset + 1] = g; bytes[offset + 2] = r; bytes[offset + 3] = 255;
        }
    }
    rect(7, 5, 18, 15, 225, 172, 59); rect(10, 9, 4, 5, 40, 45, 52); rect(18, 9, 4, 5, 40, 45, 52);
    rect(11, 22, 10, 7, 225, 172, 59); rect(5, 23, 4, 6, 110, 120, 130); rect(23, 23, 4, 6, 110, 120, 130);
    return nativeImage.createFromBitmap(bytes, { width, height: width, scaleFactor: 1 });
}
function tool(name) { show(true); command('tool', { tool: name }); }
function menuTemplate() {
    return [
        { label: 'Open chat · Ctrl+Alt+J', click: () => show(true) },
        { label: win?.isVisible() ? 'Hide companion' : 'Show companion', click: () => win?.isVisible() ? hide() : show() },
        { type: 'separator' },
        { label: 'Wave', click: () => { show(); command('gesture', { gesture: 'Wave' }); } },
        { label: 'Dance', click: () => { show(); command('gesture', { gesture: 'Dance' }); } },
        { label: 'Voice input', click: () => { show(true); command('voice'); } },
        { label: 'Mute voice', type: 'checkbox', checked: settings.muted, click: item => setMuted(item.checked) },
        { label: 'Files', click: () => tool('files') },
        { label: 'Settings', click: () => tool('settings') },
        { label: 'Character controls', click: () => { show(); command('character-controls'); } },
        { label: 'Reset conversation…', click: () => tool('reset') },
        { label: 'Character size', submenu: Object.keys(SIZES).map(size => ({ label: size[0].toUpperCase() + size.slice(1), type: 'radio', checked: settings.size === size, click: () => setSize(size) })) },
        { label: 'Always on top', type: 'checkbox', checked: settings.onTop, click: item => { settings.onTop = item.checked; win.setAlwaysOnTop(settings.onTop); persist(); updateMenu(); } },
        { label: 'Reconnect assistant', click: () => connect() },
        { type: 'separator' },
        { label: 'Quit Jarvis companion · Ctrl+Alt+Q', click: quitCompanion }
    ];
}
function updateMenu() { tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate())); }

async function probe() {
    let response;
    try { response = await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) }); }
    catch (error) { return false; }
    const text = await response.text();
    if (!response.ok || !text.includes('id="composer"') || !text.includes('id="robot-stage"')) throw new Error('Port 8000 is occupied by a different service. Close it and retry.');
    return true;
}
async function connect() {
    if (connecting || quitting) return;
    connecting = true;
    command('connection-start');
    try {
        if (!await probe()) {
            let startupError;
            if (!backend || backend.exitCode !== null) {
                logStream ||= fs.createWriteStream(path.join(__dirname, 'backend.log'), { flags: 'a' });
                const python = process.env.JARVIS_PYTHON || 'python';
                backend = spawn(python, ['-m', 'uvicorn', 'web_server:app', '--host', '127.0.0.1', '--port', '8000'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
                backend.stdout.pipe(logStream, { end: false }); backend.stderr.pipe(logStream, { end: false });
                backend.on('error', error => { startupError = error; });
                backend.on('exit', () => { if (!quitting) command('connection-error', { message: 'Assistant stopped. Choose Reconnect assistant from the menu.' }); });
            }
            let ready = false;
            const deadline = Date.now() + 90000;
            while (Date.now() < deadline && !quitting) {
                if (startupError) throw new Error(`Could not start Python: ${startupError.message}`);
                if (await probe()) { ready = true; break; }
                if (backend.exitCode !== null) throw new Error('Assistant startup failed. See desktop-companion/backend.log, then retry.');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (!ready) throw new Error('Assistant is still unavailable. Check Python dependencies and retry.');
        }
        if (quitting) return;
        if (!trustedPage(win.webContents.getURL(), BASE)) await win.loadURL(PAGE);
        else command('reconnected');
    } catch (error) { command('connection-error', { message: error.message }); }
    finally { connecting = false; }
}

function installIPC() {
    ipcMain.handle('desktop:settings', event => trusted(event) ? { muted: settings.muted, panelOpen, size: settings.size, visible: win.isVisible() } : null);
    ipcMain.handle('desktop:panel', (event, open) => trusted(event) && typeof open === 'boolean' ? setPanel(open) : false);
    ipcMain.on('desktop:hit', (event, token, value) => {
        if (!trusted(event) || !Number.isSafeInteger(token) || typeof value !== 'boolean') return;
        if (pointerLease.reply(token, value, Date.now())) {
            const point = screen.getCursorScreenPoint();
            if (!popupMenu) applyInteractive(!!dragging || pointerLease.captures(point, win.getBounds(), Date.now()));
        }
    });
    ipcMain.on('desktop:drag-start', event => {
        if (!trusted(event) || !interactive) return;
        const point = screen.getCursorScreenPoint();
        dragging = { cursor: point, last: point, bounds: win.getBounds(), time: Date.now(), active: false };
        applyInteractive(true);
    });
    ipcMain.on('desktop:drag-move', event => {
        if (!trusted(event) || !dragging) return;
        moveDrag();
    });
    ipcMain.on('desktop:drag-end', event => { if (trusted(event)) { endDrag(); updatePointer(); } });
    ipcMain.on('desktop:menu', event => { if (trusted(event, true)) showPopup(); });
    ipcMain.on('desktop:quit', event => { if (trusted(event, true)) quitCompanion(); });
    ipcMain.on('desktop:mute', (event, muted) => { if (trusted(event) && typeof muted === 'boolean' && muted !== settings.muted) setMuted(muted); });
    ipcMain.on('desktop:retry', event => { if (trusted(event, true)) connect(); });
}
function createWindow() {
    const bounds = compactPosition(); settings.position = { x: bounds.x, y: bounds.y };
    win = new BrowserWindow({ ...bounds, title: 'Jarvis Companion', frame: false, transparent: true, backgroundColor: '#00000000',
        resizable: false, maximizable: false, fullscreenable: false, hasShadow: false, show: false, skipTaskbar: true, alwaysOnTop: settings.onTop,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
            webSecurity: true, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('will-prevent-unload', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
        if (trustedPage(win.webContents.getURL(), BASE)) {
            pointerLease.clear(); applyInteractive(false);
            command('mute', { muted: settings.muted }); command('panel', { open: panelOpen });
        }
    });
    // Close/Alt+F4 means quit; hiding is an explicit tray action.
    win.on('close', event => { if (!quitting) { event.preventDefault(); quitCompanion(); } });
    win.on('hide', () => command('hidden'));
    win.on('show', () => command('shown'));
    win.on('blur', () => { endDrag(); pointerLease.clear(); updatePointer(); });
    win.webContents.on('render-process-gone', () => { endDrag(); pointerLease.clear(); applyInteractive(false); });
    pointerTimer = setInterval(updatePointer, 50);
    win.loadFile(path.join(__dirname, 'offline.html')).then(() => { win.showInactive(); connect(); });
    tray = new Tray(trayIcon()); tray.setToolTip('Jarvis · Ctrl+Alt+J opens chat');
    tray.on('double-click', () => show(true)); updateMenu();
    if (!globalShortcut.register(settings.shortcut, () => show(true))) console.warn('Shortcut is already in use; the tray can still open chat.');
    if (!globalShortcut.register('CommandOrControl+Alt+Q', quitCompanion)) console.warn('Emergency quit shortcut is in use; stop_companion.bat remains available.');
    const relocate = () => {
        const current = win.getBounds(); win.setBounds(clampBounds(current, areaFor(current))); rememberPosition();
    };
    ['display-added', 'display-removed', 'display-metrics-changed'].forEach(event => screen.on(event, relocate));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => show(true));
    app.whenReady().then(() => {
        const ses = session.defaultSession;
        ses.setPermissionRequestHandler((contents, permission, callback, details) => {
            const trustedOrigin = contents === win?.webContents && trustedPage(contents.getURL(), BASE) && new URL(details.requestingUrl || BASE).origin === BASE;
            callback(trustedOrigin && ((permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio') || permission === 'clipboard-sanitized-write'));
        });
        ses.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win?.webContents && trustedPage(contents.getURL(), BASE) &&
            ((permission === 'media' && details.mediaType === 'audio') || permission === 'clipboard-sanitized-write'));
        ses.on('will-download', event => event.preventDefault());
        ses.webRequest.onBeforeRequest((details, callback) => {
            const url = new URL(details.url);
            const allowed = url.protocol === 'file:' || url.protocol === 'data:' || url.origin === BASE || details.url === 'https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js';
            callback({ cancel: !allowed });
        });
        installIPC(); createWindow();
    }).catch(error => { dialog.showErrorBox('Jarvis companion could not start', error.message); app.quit(); });
    app.on('before-quit', () => {
        quitting = true; clearInterval(pointerTimer); closePopup(); clearTimeout(persistTimer); persist(); globalShortcut.unregisterAll(); tray?.destroy();
        // A server that was already running belongs to its original launcher.
        if (backend && backend.exitCode === null) backend.kill();
        logStream?.end();
        // A stuck renderer must not keep an invisible overlay alive while quit
        // waits for unload. Normal shutdown gets a short grace period; cleanup
        // above has already run before this main-process fallback exits.
        clearTimeout(quitTimer); quitTimer = setTimeout(() => app.exit(0), 750);
    });
    app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
