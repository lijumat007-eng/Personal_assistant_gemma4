// Regression tests for the Windows mouse-blocking/close report. Only clicks
// this test's own windows; never an unrelated application underneath Jarvis.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 10000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await fn()) return; await sleep(50); }
    throw new Error('Timed out waiting for desktop regression state');
}
function native(input) {
    const script = `import ctypes,ctypes.wintypes,sys,time,json
u=ctypes.windll.user32
u.SetProcessDPIAware()
u.GetWindowLongPtrW.argtypes=[ctypes.c_void_p,ctypes.c_int]
u.GetWindowLongPtrW.restype=ctypes.c_ssize_t
u.WindowFromPoint.argtypes=[ctypes.wintypes.POINT]
u.WindowFromPoint.restype=ctypes.c_void_p
u.GetAncestor.argtypes=[ctypes.c_void_p,ctypes.c_uint]
u.GetAncestor.restype=ctypes.c_void_p
u.GetForegroundWindow.restype=ctypes.c_void_p
u.GetWindowThreadProcessId.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.wintypes.DWORD)]
p=ctypes.wintypes.POINT();u.GetCursorPos(ctypes.byref(p))
a=json.loads(sys.argv[1]);held=False
try:
 if a['mode'] in ['quit','escape','altf4']:
  foreground=u.GetForegroundWindow();pid=ctypes.wintypes.DWORD();u.GetWindowThreadProcessId(foreground,ctypes.byref(pid))
  ownMenu=a['mode']=='escape' and pid.value==a.get('pid')
  if a['mode']!='quit' and foreground!=int(a['hwnd']) and not ownMenu: raise RuntimeError('Refusing to send keys to an unrelated foreground window: '+json.dumps({'foreground':foreground,'pid':pid.value,**a}))
  keys={'quit':[17,18,81],'escape':[27],'altf4':[18,115]}[a['mode']]
  for k in keys: u.keybd_event(k,0,0,0)
  for k in reversed(keys): u.keybd_event(k,0,2,0)
  print('{}')
 else:
  u.SetCursorPos(a['x'],a['y']);time.sleep(.35)
  before=bool(u.GetWindowLongPtrW(int(a['companion']),-20)&32)
  if a.get('stall'): time.sleep(.95)
  through=bool(u.GetWindowLongPtrW(int(a['companion']),-20)&32)
  root=u.GetAncestor(u.WindowFromPoint(ctypes.wintypes.POINT(a['x'],a['y'])),2)
  if a['mode']=='click':
   if root!=int(a['hwnd']): raise RuntimeError('Refusing to click outside the expected test window: '+json.dumps({'root':root,**a,'through':through}))
   u.mouse_event(2,0,0,0,0);held=True;time.sleep(.08)
   u.mouse_event(4,0,0,0,0);held=False;time.sleep(.12)
  print(json.dumps({'root':str(root),'clickThrough':through,'initialClickThrough':before}))
finally:
 if held: u.mouse_event(4,0,0,0,0)
 if a['mode'] not in ['quit','escape','altf4']: u.SetCursorPos(p.x,p.y)
`;
    return JSON.parse(execFileSync(process.env.JARVIS_PYTHON || 'python', ['-c', script, JSON.stringify(input)], { encoding: 'utf8', windowsHide: true }));
}
async function launch() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
    const app = await _electron.launch({ executablePath: path.join(ROOT, 'desktop-companion/runtime/electron.exe'), args: [path.join(ROOT, 'desktop-companion'), '--smoke-test'], env });
    const electronProcess = app.process();
    const page = await app.firstWindow();
    await page.route('**/api/agent/options', route => route.fulfill({ json: { provider: 'ollama', model_name: 'qwen2.5:3b', local_model: 'qwen2.5:3b', cloud_model: 'gemini-2.5-flash', cloud_key_configured: false } }));
    await page.route('**/api/agent/models', route => route.fulfill({ json: { models: [{ name: 'qwen2.5:3b' }] } }));
    const parserPath = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
    await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(parserPath, 'utf8') }));
    await page.waitForURL('**/?companion=robot&desktop=1', { timeout: 100000 });
    await page.waitForFunction(() => document.body.classList.contains('desktop-mode') && window.jarvisRobot);
    await page.locator('#cancel-reasoning').waitFor({ state: 'visible' });
    await page.locator('#cancel-reasoning').click();
    await page.evaluate(async () => {
        await window.jarvisDesktop.setPanelOpen(false);
        document.getElementById('robot-quiet').checked = true;
        window.jarvisCompanion.setMuted(true);
    });
    const info = await app.evaluate(({ BrowserWindow, globalShortcut }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 150, y: 100, width: 340, height: 460 }); win.setAlwaysOnTop(true);
        return { id: win.id, hwnd: win.getNativeWindowHandle().readBigUInt64LE().toString(), emergency: globalShortcut.isRegistered('CommandOrControl+Alt+Q') };
    });
    assert(info.emergency, 'Emergency quit must be registered independently of the renderer');
    return { app, page, info, process: electronProcess };
}
async function physical(app, id, point) {
    return app.evaluate(({ BrowserWindow, screen }, { id, point }) => {
        const bounds = BrowserWindow.fromId(id).getBounds();
        return screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) });
    }, { id, point });
}
async function stop(app, process) {
    if (process.exitCode !== null) return;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await waitFor(() => process.exitCode !== null).catch(() => process.kill());
}
(async () => {
    let current;
    try {
        current = await launch();
        const { app, page, info } = current;
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const underlayPromise = app.waitForEvent('window');
        const underlayInfo = await app.evaluate(async ({ BrowserWindow }, id) => {
            const companion = BrowserWindow.fromId(id);
            const underlay = new BrowserWindow({ ...companion.getBounds(), frame: false, resizable: false, show: false, alwaysOnTop: true, backgroundColor: '#e8edf2', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
            await underlay.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;height:100vh"><button style="width:100%;height:100%;font-size:20px">Jarvis click-through test</button><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++);</script></body></html>'));
            underlay.show(); companion.moveTop();
            return { id: underlay.id, hwnd: underlay.getNativeWindowHandle().readBigUInt64LE().toString() };
        }, info.id);
        const underlay = await underlayPromise;
        await underlay.waitForFunction(() => window.clicks === 0);
        const blank = await physical(app, info.id, { x: 20, y: 20 });
        const passed = native({ mode: 'click', companion: info.hwnd, hwnd: underlayInfo.hwnd, ...blank });
        assert(passed.clickThrough);
        await waitFor(() => underlay.evaluate(() => window.clicks === 1));
        await app.evaluate(({ BrowserWindow }, { id, underlayId }) => {
            BrowserWindow.fromId(underlayId).setAlwaysOnTop(false);
            BrowserWindow.fromId(id).moveTop();
        }, { id: info.id, underlayId: underlayInfo.id });
        // A visible control must capture a real Windows click and open chat.
        const chat = await page.locator('#desktop-chat-toggle').boundingBox();
        const chatPoint = await physical(app, info.id, { x: chat.x + chat.width / 2, y: chat.y + chat.height / 2 });
        assert(!native({ mode: 'click', companion: info.hwnd, hwnd: info.hwnd, ...chatPoint }).clickThrough);
        await waitFor(() => page.locator('.chat-workspace').isVisible());
        await page.locator('#query-input').fill('Draft survives pointer recovery');
        await page.locator('#desktop-close-chat').click();
        await waitFor(() => page.locator('.chat-workspace').isHidden());
        await page.evaluate(async () => {
            document.getElementById('robot-options').open = false;
            document.body.classList.remove('desktop-character-controls');
        });
        const robot = await page.evaluate(() => {
            const b = document.getElementById('robot-viewport').getBoundingClientRect();
            for (let y = b.top + b.height * .5; y < b.top + b.height * .7; y += 5)
                for (const x of [b.left + b.width * .5, b.left + b.width * .45, b.left + b.width * .55])
                    if (window.jarvisRobot.hitTest(x, y)) return { x, y };
        });
        assert(robot);
        // Place the test underlay behind the resized compact window again.
        await app.evaluate(({ BrowserWindow }, { id, underlayId }) => BrowserWindow.fromId(underlayId).setBounds(BrowserWindow.fromId(id).getBounds()), { id: info.id, underlayId: underlayInfo.id });
        const robotPoint = await physical(app, info.id, robot);
        // Stop the renderer after the native hit has been acknowledged. While
        // it is unresponsive, the main process must release mouse capture.
        await page.evaluate(() => { setTimeout(() => { const until = performance.now() + 2000; while (performance.now() < until) {} }, 750); });
        const recovered = native({ mode: 'click', companion: info.hwnd, hwnd: underlayInfo.hwnd, ...robotPoint, stall: true });
        assert(!recovered.initialClickThrough, 'Robot was interactive before the simulated renderer stall');
        assert(recovered.clickThrough, 'Renderer stall must release native mouse capture');
        await waitFor(() => underlay.evaluate(() => window.clicks === 2));
        await page.waitForFunction(() => document.readyState === 'complete');
        const freshChat = await page.locator('#desktop-chat-toggle').boundingBox();
        native({ mode: 'click', companion: info.hwnd, hwnd: info.hwnd, ...await physical(app, info.id, { x: freshChat.x + freshChat.width / 2, y: freshChat.y + freshChat.height / 2 }) });
        await waitFor(() => page.locator('.chat-workspace').isVisible());
        assert.equal(await page.locator('#query-input').inputValue(), 'Draft survives pointer recovery');
        assert.deepEqual(errors, []);
        // The actual close event must exit, instead of invisibly retaining the
        // tray and transparent window. It also closes our own underlay fixture.
        await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), info.id).catch(() => {});
        await waitFor(() => current.process.exitCode !== null);
        console.log('PASS: real Windows clicks pass to an underlying test window; chat is clickable; renderer stalls release capture and recover; draft preserved; window close terminates the companion.');
        current = await launch();
        // Emergency shortcut is handled by the main process even if the
        // renderer cannot receive the normal close button.
        await current.page.evaluate(() => { setTimeout(() => { const until = performance.now() + 4000; while (performance.now() < until) {} }, 0); });
        await sleep(200);
        native({ mode: 'quit' });
        await waitFor(() => current.process.exitCode !== null, 1500);
        console.log('PASS: Ctrl+Alt+Q quits independently of a stalled renderer.');
        current = await launch();
        const focusChat = await current.page.locator('#desktop-chat-toggle').boundingBox();
        native({ mode: 'click', companion: current.info.hwnd, hwnd: current.info.hwnd, ...await physical(current.app, current.info.id, { x: focusChat.x + focusChat.width / 2, y: focusChat.y + focusChat.height / 2 }) });
        await waitFor(() => current.page.locator('.chat-workspace').isVisible());
        const menu = await current.page.locator('#desktop-menu-button').boundingBox();
        native({ mode: 'click', companion: current.info.hwnd, hwnd: current.info.hwnd, ...await physical(current.app, current.info.id, { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 }) });
        await sleep(250);
        const menuProbe = native({ mode: 'hover', companion: current.info.hwnd, ...await physical(current.app, current.info.id, { x: 20, y: 20 }) });
        assert(!menuProbe.clickThrough, 'Native popup must retain mouse interaction until dismissed');
        native({ mode: 'escape', hwnd: current.info.hwnd, pid: current.process.pid });
        await sleep(150);
        // Quit button remains a direct, visible escape from compact mode.
        const quit = await current.page.locator('#desktop-quit-button').boundingBox();
        native({ mode: 'click', companion: current.info.hwnd, hwnd: current.info.hwnd, ...await physical(current.app, current.info.id, { x: quit.x + quit.width / 2, y: quit.y + quit.height / 2 }) });
        await waitFor(() => current.process.exitCode !== null);
        console.log('PASS: native menu keeps capture until Escape; visible × button quits with a real Windows click.');
        current = await launch();
        const altChat = await current.page.locator('#desktop-chat-toggle').boundingBox();
        native({ mode: 'click', companion: current.info.hwnd, hwnd: current.info.hwnd, ...await physical(current.app, current.info.id, { x: altChat.x + altChat.width / 2, y: altChat.y + altChat.height / 2 }) });
        await sleep(200);
        native({ mode: 'altf4', hwnd: current.info.hwnd });
        await waitFor(() => current.process.exitCode !== null, 1500);
        console.log('PASS: real Windows Alt+F4 exits the focused companion.');
    } finally { if (current) await stop(current.app, current.process); }
})().catch(error => { console.error(error); process.exitCode = 1; });
