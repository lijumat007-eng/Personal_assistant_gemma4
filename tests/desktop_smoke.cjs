// Windows/Electron integration checks. Requires the installed runtime and Playwright.
// Assistant replies are mocked; existing personal chat history is untouched.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '..');
const artifacts = process.env.JARVIS_UI_ARTIFACTS || path.join(ROOT, 'desktop-companion', '.user-data-test', 'screenshots');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(75); }
    throw new Error('Timed out waiting for desktop state');
}
function native(hwnd, x = 0, y = 0, mode = 'style') {
    const script = `import ctypes,sys,time,json
u=ctypes.windll.user32
u.SetProcessDPIAware()
u.GetWindowLongPtrW.argtypes=[ctypes.c_void_p,ctypes.c_int]
u.GetWindowLongPtrW.restype=ctypes.c_ssize_t
u.WindowFromPoint.argtypes=[ctypes.wintypes.POINT]
u.WindowFromPoint.restype=ctypes.c_void_p
u.GetAncestor.argtypes=[ctypes.c_void_p,ctypes.c_uint]
u.GetAncestor.restype=ctypes.c_void_p
h=int(sys.argv[1]); x=int(sys.argv[2]); y=int(sys.argv[3]); mode=sys.argv[4]
p=ctypes.wintypes.POINT();u.GetCursorPos(ctypes.byref(p))
try:
 if mode=='style': print(json.dumps({'clickThrough': bool(u.GetWindowLongPtrW(h,-20)&32)}))
 else:
  u.SetCursorPos(x,y);time.sleep(.35)
  root=u.GetAncestor(u.WindowFromPoint(ctypes.wintypes.POINT(x,y)),2)
  if mode=='drag':
   if root!=h: raise RuntimeError('Refusing to click: the cursor is not over the test companion')
   u.mouse_event(2,0,0,0,0);time.sleep(.12)
   for i in range(1,11):
    u.SetCursorPos(x-i*5,y-i*3);time.sleep(.055)
   u.mouse_event(4,0,0,0,0);time.sleep(.25)
  print(json.dumps({'root':root,'clickThrough': bool(u.GetWindowLongPtrW(h,-20)&32)}))
finally:
 if mode!='style': u.SetCursorPos(p.x,p.y)
`;
    // import ctypes.wintypes explicitly because it is not lazily available everywhere.
    return JSON.parse(execFileSync(process.env.JARVIS_PYTHON || 'python', ['-c', script.replace('import ctypes,sys,time,json', 'import ctypes,ctypes.wintypes,sys,time,json'), String(hwnd), String(x), String(y), mode], { windowsHide: true, encoding: 'utf8' }));
}

(async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    const electronEnv = { ...process.env, JARVIS_PYTHON: process.env.JARVIS_PYTHON || 'python' };
    for (const key of Object.keys(electronEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete electronEnv[key];
    const app = await _electron.launch({ executablePath: path.join(ROOT, 'desktop-companion/runtime/electron.exe'), args: [path.join(ROOT, 'desktop-companion'), '--smoke-test'], env: electronEnv });
    try {
        const page = await app.firstWindow();
        await page.route('**/api/agent/options', route => route.fulfill({ json: { provider: 'ollama', model_name: 'qwen2.5:3b', local_model: 'qwen2.5:3b', cloud_model: 'gemini-2.5-flash', cloud_key_configured: false } }));
        await page.route('**/api/agent/models', route => route.fulfill({ json: { models: [{ name: 'qwen2.5:3b' }] } }));
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Deterministic Markdown availability in the desktop test, without network.
        const parserPath = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
        await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(parserPath, 'utf8') }));
        await page.waitForURL('**/?companion=robot&desktop=1', { timeout: 100000 });
        await page.waitForFunction(() => document.body.classList.contains('desktop-mode') && window.jarvisRobot);
        await page.locator('#cancel-reasoning').waitFor({ state: 'visible' });
        assert(await page.locator('.chat-workspace').isVisible(), 'Native startup must expand to fit reasoning settings');
        await page.locator('#cancel-reasoning').click();
        await page.locator('#desktop-close-chat').click();
        await page.evaluate(() => { document.getElementById('robot-quiet').checked = true; window.jarvisCompanion.setMuted(true); });
        assert.equal(await page.locator('.chat-workspace').isVisible(), false);
        const nativeState = await app.evaluate(({ BrowserWindow, globalShortcut }) => {
            const win = BrowserWindow.getAllWindows()[0];
            return { hwnd: win.getNativeWindowHandle().readBigUInt64LE().toString(), bounds: win.getBounds(), onTop: win.isAlwaysOnTop(), resizable: win.isResizable(), background: win.getBackgroundColor(), preferences: win.webContents.getLastWebPreferences(), shortcut: globalShortcut.isRegistered('CommandOrControl+Alt+J') };
        });
        assert(nativeState.onTop); assert(!nativeState.resizable); assert(nativeState.shortcut);
        // Electron's Windows getter reports RGB; verify alpha from the actual surface below.
        assert.equal(nativeState.background.slice(0, 7), '#000000');
        assert(nativeState.preferences.contextIsolation); assert(nativeState.preferences.sandbox); assert(!nativeState.preferences.nodeIntegration);
        const png = await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png'), omitBackground: true });
        const pixels = PNG.sync.read(png).data;
        let clear = 0, opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) clear++; if (pixels[i] > 240) opaque++; }
        assert(clear > pixels.length / 16 && opaque > 1000, 'Native scene should include transparent pixels and a visible character');
        const hit = await page.evaluate(() => {
            const box = document.getElementById('robot-viewport').getBoundingClientRect();
            for (let y = box.top + box.height * .50; y < box.top + box.height * .7; y += 5)
                for (const x of [box.left + box.width * .5, box.left + box.width * .45, box.left + box.width * .55])
                    if ([-5, 0, 5].every(dx => [-5, 0, 5].every(dy => window.jarvisRobot.hitTest(x + dx, y + dy)))) return { x, y };
        });
        assert(hit, 'A character hit target should be available');
        const empty = await app.evaluate(({ BrowserWindow, screen }) => {
            const bounds = BrowserWindow.getAllWindows()[0].getBounds();
            return screen.dipToScreenPoint({ x: bounds.x + 2, y: bounds.y + 2 });
        });
        assert(native(nativeState.hwnd, empty.x, empty.y, 'hover').clickThrough);
        const physical = await app.evaluate(({ BrowserWindow, screen }, point) => {
            const bounds = BrowserWindow.getAllWindows()[0].getBounds();
            return screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) });
        }, hit);
        const hovered = native(nativeState.hwnd, physical.x, physical.y, 'hover');
        assert(!hovered.clickThrough);
        assert.equal(String(hovered.root), nativeState.hwnd, JSON.stringify({ bounds: nativeState.bounds, hit, physical, hovered }));
        native(nativeState.hwnd, physical.x, physical.y, 'drag');
        const moved = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
        assert(moved.x < nativeState.bounds.x - 15 && moved.y < nativeState.bounds.y, 'Real Windows dragging should move the native window');
        await page.locator('#desktop-chat-toggle').click();
        await waitFor(() => page.locator('.chat-workspace').isVisible());
        await page.locator('#query-input').fill('Keep this desktop draft');
        await page.locator('#desktop-close-chat').click();
        await waitFor(() => page.locator('.chat-workspace').isHidden());
        await page.locator('#desktop-chat-toggle').click();
        assert.equal(await page.locator('#query-input').inputValue(), 'Keep this desktop draft');
        if (process.env.JARVIS_DESKTOP_LIVE === '1') {
            const liveResponse = page.waitForResponse(response => response.url().endsWith('/api/query') && response.request().method() === 'POST', { timeout: 120000 });
            await page.locator('#query-input').fill('Say hello in one short sentence. This is a desktop companion connection check. Do not use tools or modify files.');
            await page.locator('#query-input').press('Enter');
            const result = await (await liveResponse).json();
            assert.equal(result.status, 'success'); assert(result.response?.trim());
            await waitFor(() => page.locator('#working-status').isHidden());
            await page.screenshot({ path: path.join(artifacts, 'desktop-live-chat.png'), omitBackground: true });
            console.log('PASS: actual assistant reply through the native chat:', result.response);
        }
        await page.route('**/api/query', async route => {
            await sleep(180);
            const query = route.request().postDataJSON().query;
            if (query === 'Network failure') { await route.abort(); return; }
            const result = query === 'Approve something' ? { status: 'pending_approval', approval_id: 'desktop-test', description: 'A test action needs approval.', steps: [] } : { status: 'success', response: 'Hello from the desktop test.', steps: [] };
            await route.fulfill({ json: result });
        });
        await page.route('**/api/approve', route => route.fulfill({ json: { status: 'success', response: 'Test action cancelled.', steps: [] } }));
        await page.locator('#query-input').fill('Desktop chat'); await page.locator('#query-input').press('Enter');
        await waitFor(async () => (await page.locator('#chat-history').textContent()).includes('Hello from the desktop test.'));
        await page.locator('#query-input').fill('Approve something'); await page.locator('#query-input').press('Enter');
        await waitFor(async () => (await page.locator('#robot-status').textContent()).includes('Waiting for your approval'));
        await page.locator('#desktop-close-chat').click();
        await page.locator('#desktop-chat-toggle').click();
        assert.equal(await page.locator('.approval-card button').count(), 2);
        await page.locator('.approval-card').getByRole('button', { name: 'Cancel', exact: true }).click();
        await waitFor(async () => (await page.locator('#chat-history').textContent()).includes('Test action cancelled.'));
        await page.screenshot({ path: path.join(artifacts, 'desktop-chat.png'), omitBackground: true });
        await page.evaluate(() => window.jarvisCompanion.openTool('settings'));
        await page.locator('input[name="theme"][value="dark"]').check();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.chat-workspace').isVisible(), true, 'Drawer Escape must preserve the open chat');
        await waitFor(() => page.locator('#query-input').evaluate(element => element === document.activeElement));
        await page.screenshot({ path: path.join(artifacts, 'desktop-dark.png'), omitBackground: true });
        await page.locator('#query-input').fill('Network failure'); await page.locator('#query-input').press('Enter');
        await waitFor(async () => (await page.locator('#robot-status').textContent()).includes('Something went wrong'));
        await page.evaluate(() => window.jarvisDesktop.retry());
        await waitFor(async () => (await page.locator('#robot-status').textContent()) === 'Ready when you are');
        await page.keyboard.press('Escape');
        await waitFor(() => page.locator('.chat-workspace').isHidden());
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('desktop:command', { name: 'character-controls' }));
        await waitFor(() => page.locator('#robot-color').isVisible());
        await page.locator('#robot-color').selectOption('mint');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#robot-viewport').isVisible(), true);
        await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            win.hide();
        });
        await waitFor(() => page.evaluate(() => document.body.dataset.desktopHidden === 'true'));
        assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
        await waitFor(() => page.evaluate(() => document.body.dataset.desktopHidden === 'false'));
        assert.equal(await page.locator('#robot-viewport canvas').count(), 1);
        // Check protocol validation without granting file or command access to the page.
        assert.equal(await page.evaluate(() => window.jarvisDesktop.setPanelOpen('invalid')), false);
        assert.equal(await page.evaluate(() => typeof require), 'undefined');
        assert.deepEqual(errors, []);
        const memory = await app.evaluate(({ app }) => app.getAppMetrics().reduce((total, process) => total + process.memory.workingSetSize, 0));
        console.log(`PASS: native transparency/click-through flags, Windows character hit and dragging, tray shortcut registration, sandbox, compact/expanded chat, draft preservation, approvals, themes, drawer focus/Escape, hide/show, character controls, reconnect, and bridge validation. Electron working set: ${Math.round(memory / 1024)} MB.`);
        console.log('Screenshots:', artifacts);
    } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
