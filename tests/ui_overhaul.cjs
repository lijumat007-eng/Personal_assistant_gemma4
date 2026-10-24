// Browser regression checks. Run with `node tests/ui_overhaul.cjs` when playwright
// and marked are available in NODE_PATH. All assistant/file mutations are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
    const uiRoot = path.resolve(__dirname, '../web_ui');
    const server = http.createServer((req, res) => {
        const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
        const file = path.resolve(uiRoot, name);
        if (!file.startsWith(uiRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.glb') ? 'model/gltf-binary' : 'text/html');
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    const artifacts = process.env.JARVIS_UI_ARTIFACTS || path.join(os.tmpdir(), 'jarvis-ui-overhaul');
    fs.mkdirSync(artifacts, { recursive: true });
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'] });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
        await context.addInitScript(() => localStorage.setItem('jarvis_muted', 'true'));
        // Use the installed Markdown parser offline; the production URL remains unchanged.
        const parserPath = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
        await context.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(parserPath, 'utf8') }));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let requests = [], queryCount = 0, approvalFails = 0, chainApproval = false, nextApproval = false, queryFail = false, providerFail = false;
        let activeProvider = 'ollama', workspace = 'C:/Projects/Jarvis', files = { 'docs/note.txt': 'Original content' };
        let activeModel = 'local-model', modelsOffline = false, modelsEmpty = false;
        let voiceBytes = 0;
        const steps = [{ tool: 'read_note', args: { filename: 'note.txt' }, result: '<script>unsafe</script>', status: 'success' }];
        await page.route('**/api/**', async route => {
            const req = route.request(), endpoint = new URL(req.url()).pathname;
            const data = req.method() === 'POST' && !endpoint.endsWith('voice_query') ? req.postDataJSON() : {};
            requests.push({ endpoint, method: req.method(), data });
            let result = { status: 'success' }, code = 200;
            if (endpoint === '/api/query') {
                queryCount++;
                await new Promise(resolve => setTimeout(resolve, 80));
                if (queryFail) { code = 503; result = { detail: 'Assistant unavailable' }; queryFail = false; }
                else if (nextApproval) { result = { status: 'pending_approval', approval_id: 'approval-1', description: 'Delete old note?', steps }; nextApproval = false; }
                else result = { status: 'success', response: '**Hello.**\n\n```js\n' + 'const example = "' + 'x'.repeat(250) + '";\n```\n\n<img src=x onerror=alert(1)>[unsafe](javascript:alert(1))', steps };
            } else if (endpoint === '/api/approve') {
                if (approvalFails-- > 0) result = { status: 'error', response: 'Temporary approval failure', steps: [] };
                else if (chainApproval) { result = { status: 'pending_approval', approval_id: 'approval-2', description: 'A second action needs approval.', steps }; chainApproval = false; }
                else result = { status: 'success', response: data.approved ? 'Action approved.' : 'Action cancelled.', steps };
            } else if (endpoint === '/api/workspace') {
                if (req.method() === 'POST') workspace = data.path;
                result = { status: 'success', working_dir: workspace, root_name: 'Jarvis' };
            } else if (endpoint === '/api/explorer') result = { tree: [{ name: 'docs', path: 'docs', is_dir: true, children: Object.keys(files).filter(p => p.startsWith('docs/')).map(p => ({ name: p.split('/').pop(), path: p, is_dir: false })) }, ...Object.keys(files).filter(p => !p.includes('/')).map(p => ({ name: p, path: p, is_dir: false }))] };
            else if (endpoint === '/api/explorer/create_note') {
                if (Object.hasOwn(files, data.filename)) { code = 409; result = { detail: 'File already exists' }; }
                else files[data.filename] = data.content;
            } else if (endpoint === '/api/explorer/create_folder') result = { status: 'success' };
            else if (endpoint.startsWith('/api/notes/')) {
                const file = decodeURIComponent(endpoint.slice('/api/notes/'.length));
                if (req.method() === 'DELETE') delete files[file];
                else result = { content: files[file] };
            } else if (endpoint === '/api/agent/status') result = { provider: activeProvider, model_name: activeModel };
            else if (endpoint === '/api/agent/options') result = { provider: activeProvider, model_name: activeModel, local_model: 'local-model', cloud_model: 'cloud-model', cloud_key_configured: false };
            else if (endpoint === '/api/agent/models') {
                if (modelsOffline) { code = 503; result = { detail: 'Start Ollama, then refresh.' }; }
                else result = { models: modelsEmpty ? [] : [{ name: 'local-model' }, { name: 'qwen2.5:1.5b' }] };
            }
            else if (endpoint === '/api/agent/config') {
                if (providerFail) { code = 500; result = { detail: 'Provider unavailable' }; providerFail = false; }
                else { activeProvider = data.provider; activeModel = data.model_name; result = { provider: activeProvider, model_name: activeModel }; }
            } else if (endpoint === '/api/voice_query') {
                voiceBytes = req.postDataBuffer().length;
                result = { status: 'success', transcription: 'Voice message', response: 'Heard you.', steps };
            }
            await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(result) });
        });
        const url = `http://127.0.0.1:${server.address().port}/`;
        const waitFor = async fn => {
            for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
            await page.screenshot({ path: path.join(artifacts, 'failure.png') });
            throw new Error(`Timed out waiting for UI state. Browser errors: ${JSON.stringify(errors)}. Requests: ${JSON.stringify(requests)}. Page: ${await page.locator('body').innerText()}`);
        };
        const open = async view => {
            await page.locator('#menu-button').click();
            await page.locator(`[data-drawer="${view}"]`).click();
        };
        const close = async () => { await page.keyboard.press('Escape'); assert.equal(await page.locator('#tool-drawer').evaluate(el => el.open), false); };
        const send = async message => { await page.locator('#query-input').fill(message); await page.keyboard.press('Enter'); await waitFor(() => page.locator('#working-status').isHidden()); };
        const dismissStartup = async () => { await page.locator('#cancel-reasoning').waitFor({ state: 'visible' }); await page.locator('#cancel-reasoning').click(); };
        await page.goto(url);
        await waitFor(() => page.locator('#save-reasoning').isEnabled());
        assert.equal(await page.locator('#drawer-title').textContent(), 'Choose reasoning');
        await page.locator('#local-model-select').selectOption('qwen2.5:1.5b');
        await page.screenshot({ path: path.join(artifacts, 'reasoning-local.png') });
        await page.locator('#save-reasoning').click();
        await waitFor(() => page.locator('#tool-drawer').isHidden());
        assert.equal(activeModel, 'qwen2.5:1.5b');
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
        assert.equal(await page.locator('#tool-drawer').evaluate(el => el.open), false);
        assert(!requests.some(request => request.endpoint === '/api/workspace'), 'Startup must not scan the workspace');
        assert.equal(await page.locator('button:visible').count(), 2);
        await page.screenshot({ path: path.join(artifacts, 'light-empty.png') });

        await page.locator('#query-input').fill('Keep this draft');
        await page.keyboard.press('Control+k');
        assert.equal(await page.locator('#app-menu').isVisible(), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#menu-button').evaluate(el => el === document.activeElement), true);
        await open('settings');
        await waitFor(async () => await page.locator('#agent-model-name').textContent() === 'qwen2.5:1.5b');
        for (const theme of ['dark', 'warm', 'light']) {
            await page.locator(`input[name="theme"][value="${theme}"]`).check();
            assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
            await page.screenshot({ path: path.join(artifacts, `${theme}-settings.png`) });
        }
        await page.locator('input[value="warm"]').check();
        await close();
        assert.equal(await page.locator('#query-input').inputValue(), 'Keep this draft');
        assert.equal(await page.locator('#menu-button').evaluate(el => el === document.activeElement), true);
        await page.reload(); await dismissStartup();
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'warm');
        for (const legacy of ['stark', 'obsidian', 'cyberpunk']) {
            await page.evaluate(value => localStorage.setItem('jarvis_theme', value), legacy);
            await page.reload(); await dismissStartup();
            assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        }
        await page.evaluate(() => localStorage.setItem('jarvis_theme', 'light')); await page.reload(); await dismissStartup();

        await page.locator('#query-input').fill('First line');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('Second line');
        assert.equal(queryCount, 0);
        await page.keyboard.press('Enter');
        await waitFor(async () => await page.locator('.assistant-message').count() === 1);
        assert.equal(requests.find(r => r.endpoint === '/api/query').data.query, 'First line\nSecond line');
        assert.equal(await page.locator('.activity').evaluate(el => el.open), false);
        assert.equal(await page.locator('.message-body strong').textContent(), 'Hello.');
        assert.equal(await page.locator('.message-body img, .message-body script, .message-body a[href^="javascript:"]').count(), 0);
        await page.locator('.activity summary').click();
        assert.equal(await page.locator('.activity').evaluate(el => el.open), true);
        await page.locator('.copy-button').first().click();
        assert.equal(await page.locator('.copy-button').first().textContent(), 'Copied');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(artifacts, 'chat.png') });

        // Opening tools must not move a reader away from older messages or clear their draft.
        await page.evaluate(() => { for (let i = 0; i < 12; i++) appendMessage('assistant', 'Older response '.repeat(40)); document.getElementById('chat-scroll').scrollTop = 120; });
        await page.locator('#query-input').fill('Draft stays');
        const scrollTop = await page.locator('#chat-scroll').evaluate(el => el.scrollTop);
        await open('files'); await close();
        assert.equal(await page.locator('#chat-scroll').evaluate(el => el.scrollTop), scrollTop);
        assert.equal(await page.locator('#query-input').inputValue(), 'Draft stays');
        await open('files');
        await waitFor(async () => await page.locator('.tree-row').count() > 0);
        await page.locator('#explorer-search').fill('note.txt');
        await page.getByRole('button', { name: 'note.txt', exact: true }).click();
        await waitFor(async () => await page.locator('#file-body').textContent() === 'Original content');
        assert.equal(await page.locator('#tool-drawer').evaluate(el => el.open), true);
        await page.locator('#back-to-files').click();
        await page.locator('#new-file').click();
        await page.locator('#item-name').fill('fresh.txt');
        await page.locator('#item-content').fill('  keep whitespace\n');
        await page.locator('#create-form button[type="submit"]').click();
        await waitFor(() => page.locator('#file-browser').isVisible());
        assert.equal(files['fresh.txt'], '  keep whitespace\n');
        await page.locator('#new-file').click(); await page.locator('#item-name').fill('fresh.txt');
        await page.locator('#create-form button[type="submit"]').click();
        await waitFor(() => page.locator('#drawer-error').isVisible());
        assert.equal(await page.locator('#drawer-error').textContent(), 'File already exists');
        await page.locator('#cancel-create').click();
        await page.locator('#new-folder').click(); await page.locator('#item-name').fill('new-folder');
        assert.equal(await page.locator('#file-content-field').isHidden(), true);
        await page.locator('#create-form button[type="submit"]').click(); await waitFor(() => page.locator('#file-browser').isVisible());
        await page.locator('#change-workspace').click(); await page.locator('#workspace-input').fill('C:/NewWorkspace');
        await page.locator('#workspace-form button[type="submit"]').click();
        await waitFor(async () => await page.locator('#workspace-path').textContent() === 'C:/NewWorkspace');
        await page.locator('#explorer-search').fill('fresh.txt');
        await page.getByRole('button', { name: 'fresh.txt', exact: true }).click();
        await page.locator('#delete-file').click();
        assert.equal(Object.hasOwn(files, 'fresh.txt'), true, 'Delete must require confirmation');
        await page.locator('#confirm-delete').click(); await waitFor(() => page.locator('#file-browser').isVisible());
        assert.equal(Object.hasOwn(files, 'fresh.txt'), false);
        await close();

        await open('settings'); await page.locator('[data-drawer="reasoning"]').click();
        await waitFor(() => page.locator('#provider-select').isEnabled());
        modelsOffline = true; await page.locator('#refresh-models').click();
        await waitFor(async () => (await page.locator('#local-model-status').textContent()).includes('Start Ollama'));
        assert(await page.locator('#save-reasoning').isDisabled());
        modelsOffline = false; modelsEmpty = true; await page.locator('#refresh-models').click();
        await waitFor(async () => (await page.locator('#local-model-status').textContent()).includes('No models'));
        modelsEmpty = false;
        await page.locator('#provider-select').selectOption('gemini');
        assert(await page.locator('#save-reasoning').isDisabled());
        await page.locator('#cloud-key-input').fill('test-browser-secret');
        await page.screenshot({ path: path.join(artifacts, 'reasoning-cloud.png') });
        await page.locator('#save-reasoning').click();
        await waitFor(() => page.locator('#tool-drawer').isHidden());
        assert.equal(activeProvider, 'gemini');
        assert.equal(await page.locator('#cloud-key-input').inputValue(), '');
        assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('test-browser-secret'));
        await open('settings'); await page.locator('[data-drawer="reasoning"]').click();
        await waitFor(() => page.locator('#provider-select').isEnabled());
        await page.locator('#provider-select').selectOption('ollama');
        await waitFor(() => page.locator('#save-reasoning').isEnabled());
        providerFail = true; await page.locator('#save-reasoning').click();
        await waitFor(async () => (await page.locator('#reasoning-status').textContent()).includes('Provider unavailable'));
        assert.equal(activeProvider, 'gemini');
        await close(); await open('settings');
        await page.locator('#voice-output').check();
        assert.equal(await page.evaluate(() => localStorage.getItem('jarvis_muted')), 'false');
        await page.locator('#voice-output').uncheck(); await close();

        queryFail = true; await send('Fail this request');
        await waitFor(async () => (await page.locator('#chat-history').textContent()).includes('Assistant unavailable'));
        nextApproval = true; approvalFails = 1; await send('Needs approval');
        await waitFor(async () => await page.locator('.approval-card').count() === 1);
        assert.equal(await page.locator('.approval-card button').count(), 2);
        await open('settings'); assert.equal(await page.locator('#provider-select').isDisabled(), true); await close();
        await page.locator('.approval-card button').first().click();
        await waitFor(() => page.locator('#working-status').isHidden());
        assert.equal(await page.locator('.approval-card button').count(), 2, 'Failed approval must remain retryable');
        assert.equal(await page.locator('.approval-card button').first().isEnabled(), true);
        await page.locator('.approval-card button').first().click();
        await waitFor(async () => await page.locator('.approval-card button').count() === 0);
        nextApproval = true; await send('Needs denial');
        await page.locator('.approval-card').last().getByRole('button', { name: 'Cancel', exact: true }).click();
        await waitFor(async () => (await page.locator('#chat-history').textContent()).includes('Action cancelled.'));
        nextApproval = true; chainApproval = true; await send('Two approvals');
        await page.locator('.approval-card').last().getByRole('button', { name: 'Approve', exact: true }).click();
        await waitFor(async () => (await page.locator('.approval-card').last().textContent()).includes('A second action'));
        await waitFor(() => page.locator('#working-status').isHidden());
        assert.equal(await page.locator('.approval-card button').count(), 2, 'Only the newest pending decision should remain active');
        await send('no');
        assert.equal(requests.filter(r => r.endpoint === '/api/approve').at(-1).data.approval_id, 'approval-2');

        await open('reset'); assert.equal(requests.filter(r => r.endpoint === '/api/agent/clear').length, 0);
        await page.locator('#confirm-reset').click(); await waitFor(() => page.locator('#empty-state').isVisible());
        assert.equal(await page.locator('.message').count(), 0);
        // Fake audio devices exercise capture, cancellation, upload and transcription without hardware.
        await page.locator('#query-input').fill('Voice draft');
        await page.locator('#menu-button').click(); await page.locator('#voice-input-button').click();
        await waitFor(() => page.locator('#recording-controls').isVisible());
        await page.locator('#cancel-recording').click();
        assert.equal(await page.locator('#query-input').inputValue(), 'Voice draft');
        await page.locator('#menu-button').click(); await page.locator('#voice-input-button').click();
        await waitFor(() => page.locator('#recording-controls').isVisible());
        await new Promise(resolve => setTimeout(resolve, 300));
        await page.locator('#finish-recording').click();
        await waitFor(async () => (await page.locator('#chat-history').textContent()).includes('Heard you.'));
        assert(voiceBytes > 1000, 'A WAV payload should be uploaded');
        assert.equal(await page.locator('#recording-controls').isHidden(), true);
        assert.equal(await page.locator('#query-input').inputValue(), 'Voice draft');

        await page.setViewportSize({ width: 390, height: 844 });
        await open('settings');
        assert.equal(Math.round((await page.locator('#tool-drawer').boundingBox()).width), 390);
        await page.screenshot({ path: path.join(artifacts, 'mobile-settings.png') });
        // Native dialog traps Tab focus and Escape returns it to the menu trigger.
        for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.closest('#tool-drawer') !== null), true);
        await close();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(artifacts, 'mobile-chat.png') });
        // An unavailable CDN must still leave a usable plain-text chat.
        await page.route('https://cdnjs.cloudflare.com/**', route => route.abort());
        await page.reload(); await dismissStartup();
        await send('Offline Markdown');
        await waitFor(async () => await page.locator('.assistant-message').count() === 1);
        assert.equal(await page.locator('.message-body img, .message-body script').count(), 0);
        assert((await page.locator('.message-body').textContent()).includes('**Hello.**'));
        // The optional character must use the real GLB and leave the chat draft intact.
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator('#query-input').fill('Keep my robot draft');
        await page.locator('#menu-button').click(); await page.locator('#robot-preview-button').click();
        await page.waitForFunction(() => document.querySelector('#robot-status').textContent === 'Ready when you are', { timeout: 20000 });
        assert.equal(await page.locator('#robot-viewport canvas').count(), 1);
        const still = await page.locator('#robot-viewport').screenshot();
        await page.locator('[data-robot-animation="Wave"]').click();
        await page.waitForTimeout(700);
        const waving = await page.locator('#robot-viewport').screenshot();
        assert.notDeepEqual(still, waving, 'The real character should visibly animate');
        await page.locator('[data-robot-animation="Dance"]').click();
        await page.waitForFunction(() => document.querySelector('#robot-motion').value === 'Idle', { timeout: 6000 });
        await page.locator('#robot-options summary').click();
        await page.locator('#robot-expression').selectOption('Surprised');
        await page.locator('#robot-color').selectOption('blue');
        await page.locator('#robot-options summary').click();
        await page.screenshot({ path: path.join(artifacts, 'robot-desktop.png') });
        // Deterministic speech lifecycle checks do not require a system voice in CI.
        await page.evaluate(() => {
            window.speechSynthesis.speak = utterance => { window.robotTestUtterance = utterance; utterance.onstart(); };
            window.speechSynthesis.cancel = () => {};
        });
        await page.locator('#robot-voice-test').click();
        assert.equal(await page.locator('#robot-status').textContent(), 'Speaking…');
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(artifacts, 'robot-speaking.png') });
        await page.locator('#robot-stop-voice').click();
        assert.equal(await page.locator('#robot-status').textContent(), 'Ready when you are');
        await page.evaluate(() => window.robotTestUtterance.onstart());
        assert.equal(await page.locator('#robot-status').textContent(), 'Ready when you are', 'Late speech callbacks must not restart the mouth');
        await page.locator('#robot-voice-test').click();
        await page.evaluate(() => window.robotTestUtterance.onerror());
        assert((await page.locator('#robot-status').textContent()).includes('Voice playback unavailable'));
        queryFail = true; await send('Robot error');
        await waitFor(async () => (await page.locator('#robot-status').textContent()).includes('Something went wrong'));
        nextApproval = true; await send('Robot approval');
        await waitFor(async () => (await page.locator('#robot-status').textContent()).includes('Waiting for your approval'));
        await page.locator('.approval-card').last().getByRole('button', { name: 'Cancel', exact: true }).click();
        await waitFor(() => page.locator('#working-status').isHidden());
        await page.locator('#menu-button').click(); await page.locator('#voice-input-button').click();
        await waitFor(async () => (await page.locator('#robot-status').textContent()) === 'Listening…');
        await page.locator('#cancel-recording').click();
        await page.locator('#query-input').fill('Keep my robot draft');
        await page.locator('#close-robot').click();
        assert.equal(await page.locator('#robot-stage').isHidden(), true);
        assert.equal(await page.locator('#query-input').inputValue(), 'Keep my robot draft');
        assert.equal(await page.locator('#query-input').evaluate(el => el === document.activeElement), true);
        await page.locator('#menu-button').click(); await page.locator('#robot-preview-button').click();
        assert.equal(await page.locator('#robot-viewport canvas').count(), 1, 'Reopening must reuse the renderer');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const composerBox = await page.locator('#composer').boundingBox();
        assert(composerBox.y + composerBox.height <= 844, 'Mobile composer must remain onscreen');
        await page.screenshot({ path: path.join(artifacts, 'robot-mobile.png') });
        await page.reload(); await dismissStartup();
        await page.waitForFunction(() => document.querySelector('#robot-status').textContent === 'Ready when you are', { timeout: 20000 });
        assert.equal(await page.locator('#robot-color').inputValue(), 'blue');
        await page.locator('#close-robot').click();
        await page.route('**/RobotExpressive.glb', route => route.abort());
        await page.reload(); await dismissStartup();
        await page.locator('#menu-button').click(); await page.locator('#robot-preview-button').click();
        await waitFor(async () => (await page.locator('#robot-status').textContent()).includes('unavailable'));
        await send('Chat survives missing robot');
        await waitFor(async () => await page.locator('.assistant-message').count() === 1);
        await page.unroute('**/RobotExpressive.glb');
        await page.locator('#close-robot').click();
        await page.locator('#menu-button').click(); await page.locator('#robot-preview-button').click();
        await page.waitForFunction(() => document.querySelector('#robot-status').textContent === 'Ready when you are', { timeout: 20000 });
        assert.deepEqual(errors, []);
        console.log('PASS: minimal layout, themes/migration, keyboard/focus, messaging/Markdown, activity, copy, draft/scroll, files, provider rollback, reset, approval retry/denial, voice capture/upload, and mobile layout.');
        console.log(`Screenshots: ${artifacts}`);
        console.log('PASS: real robot rendering/gestures, expression/colour controls, saved colour, speech cancellation, approval/error/listening reactions, draft/focus preservation, mobile composer, and asset failure/retry.');
        await context.close();
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
