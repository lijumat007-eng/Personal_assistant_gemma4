const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampBounds, sanitizeSettings, trustedPage } = require('../desktop-companion/policy.cjs');
const { PointerLease } = require('../desktop-companion/pointer-lease.cjs');

test('restores an offscreen companion into a monitor work area, including negative coordinates', () => {
    assert.deepEqual(clampBounds({ x: 2000, y: 2000, width: 340, height: 460 }, { x: 0, y: 0, width: 1366, height: 728 }), { x: 1026, y: 268, width: 340, height: 460 });
    assert.deepEqual(clampBounds({ x: -3000, y: -900, width: 860, height: 640 }, { x: -1280, y: 0, width: 1280, height: 720 }), { x: -1280, y: 0, width: 860, height: 640 });
    assert.deepEqual(clampBounds({ x: 0, y: 0, width: 860, height: 640 }, { x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
});

test('emergency quit shortcut cannot be assigned to open chat', () => {
    for (const shortcut of ['Ctrl+Alt+Q', 'CommandOrControl+Alt+Q', 'Control+Alt+Q'])
        assert.equal(sanitizeSettings({ shortcut }).shortcut, 'CommandOrControl+Alt+J');
});

test('native capture expires after a stalled renderer and rejects stale or reordered replies', () => {
    const lease = new PointerLease(350), point = { x: 100, y: 200 }, bounds = { x: 0, y: 0, width: 340, height: 460 };
    const first = lease.request(point, bounds, 0), second = lease.request(point, bounds, 50);
    assert(lease.reply(second, true, 80));
    assert(!lease.reply(first, true, 90));
    assert(lease.captures(point, bounds, 399));
    assert(!lease.captures(point, bounds, 400));
    const stale = lease.request(point, bounds, 500);
    assert(!lease.reply(stale, true, 850));
    assert(!lease.captures(point, bounds, 850));
});

test('native capture belongs to the current point and window bounds, and resets on hide/reload', () => {
    const lease = new PointerLease(), point = { x: 100, y: 200 }, bounds = { x: 0, y: 0, width: 340, height: 460 };
    const token = lease.request(point, bounds, 0);
    assert(lease.reply(token, true, 20));
    assert(lease.captures(point, bounds, 30));
    assert(!lease.captures({ x: 104, y: 200 }, bounds, 30));
    assert(!lease.captures(point, { ...bounds, width: 860 }, 30));
    const pending = lease.request(point, bounds, 30);
    lease.clear();
    assert(!lease.reply(pending, true, 40));
    assert(!lease.captures(point, bounds, 40));
    const miss = lease.request(point, bounds, 50);
    assert(lease.reply(miss, false, 60));
    assert(!lease.captures(point, bounds, 70));
});
test('invalid saved preferences fall back without accepting arbitrary sizes/accelerators', () => {
    for (const value of [null, [], 'bad', { size: 'gigantic', position: { x: Infinity, y: 4 }, shortcut: 'Alt+F4' }]) {
        const settings = sanitizeSettings(value);
        assert.equal(settings.size, 'medium'); assert.equal(settings.position, null);
        assert.equal(settings.shortcut, 'CommandOrControl+Alt+J');
    }
    assert.deepEqual(sanitizeSettings({ size: 'small', position: { x: -500.5, y: 30.7 }, muted: true, onTop: false, shortcut: 'Ctrl+Alt+K' }),
        { size: 'small', position: { x: -500, y: 31 }, muted: true, onTop: false, shortcut: 'Ctrl+Alt+K' });
});
test('privileged bridge accepts only the local desktop page', () => {
    const base = 'http://127.0.0.1:8000';
    assert.equal(trustedPage(base + '/?companion=robot&desktop=1', base), true);
    for (const url of [base + '/', base + '/notes?desktop=1', base + '.evil.example/?desktop=1', 'https://127.0.0.1:8000/?desktop=1', 'file:///tmp/desktop=1', 'invalid']) assert.equal(trustedPage(url, base), false);
});
