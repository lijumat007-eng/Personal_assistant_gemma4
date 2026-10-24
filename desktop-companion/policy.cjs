'use strict';
const SIZES = { small: { width: 280, height: 380 }, medium: { width: 340, height: 460 }, large: { width: 400, height: 540 } };
const finite = n => typeof n === 'number' && Number.isFinite(n);
function clampBounds(bounds, area) {
    const width = Math.min(Math.max(200, Math.round(bounds.width)), area.width);
    const height = Math.min(Math.max(240, Math.round(bounds.height)), area.height);
    return { width, height,
        x: Math.max(area.x, Math.min(Math.round(bounds.x), area.x + area.width - width)),
        y: Math.max(area.y, Math.min(Math.round(bounds.y), area.y + area.height - height)) };
}
function sanitizeSettings(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    return { size: Object.hasOwn(SIZES, raw.size) ? raw.size : 'medium',
        muted: raw.muted === true, onTop: raw.onTop !== false,
        shortcut: typeof raw.shortcut === 'string' && /^(CommandOrControl|Ctrl|Control)\+Alt\+[A-Z0-9]$/.test(raw.shortcut) && !raw.shortcut.endsWith('+Q') ? raw.shortcut : 'CommandOrControl+Alt+J',
        position: raw.position && finite(raw.position.x) && finite(raw.position.y) ? { x: Math.round(raw.position.x), y: Math.round(raw.position.y) } : null };
}
function trustedPage(url, base) {
    try { const parsed = new URL(url); return parsed.origin === new URL(base).origin && parsed.pathname === '/' && parsed.searchParams.get('desktop') === '1'; }
    catch (_) { return false; }
}
module.exports = { SIZES, clampBounds, sanitizeSettings, trustedPage };
