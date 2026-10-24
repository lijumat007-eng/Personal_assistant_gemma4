const host = window.jarvisDesktop;
const companion = window.jarvisCompanion;
const $ = id => document.getElementById(id);
document.body.classList.add('desktop-mode');
$('desktop-controls').hidden = false;
let panelOpen = false, drag = null;
const settings = await host.getSettings();
if (settings) companion.setMuted(settings.muted);
document.body.dataset.desktopHidden = String(settings?.visible === false);

function setPanel(open) {
    panelOpen = open;
    document.body.classList.toggle('desktop-panel-open', open);
    $('desktop-chat-heading').hidden = !open;
    $('desktop-chat-toggle').setAttribute('aria-expanded', String(open));
    $('desktop-chat-toggle').textContent = open ? 'Close chat' : 'Chat';
    if (!open) {
        if ($('tool-drawer').open) $('tool-drawer').close();
        companion.cancelVoice();
    }
}
async function toggleChat(open = !panelOpen) {
    if (await host.setPanelOpen(open)) setPanel(open);
    if (open) $('query-input').focus({ preventScroll: true });
}
function hitTest(x, y) {
    const element = document.elementFromPoint(x, y);
    if (element?.closest('.desktop-controls, .chat-workspace, #tool-drawer, #robot-options')) return true;
    // The status badge is useful feedback but should not consume desktop clicks.
    return window.jarvisRobot?.hitTest(x, y) || false;
}
function updateHit(x, y) {
    $('robot-viewport').classList.toggle('robot-hover', !drag && !!window.jarvisRobot?.hitTest(x, y));
}
function cancelDrag() {
    drag = null; $('robot-viewport').classList.remove('robot-dragging');
}
// Mouse moves serve gestures only; native cursor probes own click-through state.
window.addEventListener('mousemove', event => {
    if (drag && event.buttons === 0) { cancelDrag(); host.endDrag(); }
    if (drag) {
        if (!drag.moved && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) >= 5) {
            drag.moved = true; $('robot-viewport').classList.add('robot-dragging');
        }
        if (drag.moved) host.moveDrag();
    }
    updateHit(event.clientX, event.clientY);
});
$('robot-viewport').addEventListener('mousedown', event => {
    if (event.button !== 0 || !window.jarvisRobot?.hitTest(event.clientX, event.clientY)) return;
    event.preventDefault();
    drag = { x: event.screenX, y: event.screenY, moved: false };
    host.beginDrag();
});
window.addEventListener('mouseup', event => {
    if (!drag) return;
    const moved = drag.moved; cancelDrag();
    host.endDrag(); $('robot-viewport').classList.remove('robot-dragging');
    if (!moved) { window.jarvisRobot?.play('Wave'); toggleChat(); }
    updateHit(event.clientX, event.clientY);
});
window.addEventListener('blur', () => {
    if (drag) { drag = null; host.endDrag(); $('robot-viewport').classList.remove('robot-dragging'); }
});
$('desktop-chat-toggle').addEventListener('click', () => toggleChat());
$('desktop-close-chat').addEventListener('click', () => toggleChat(false));
$('desktop-menu-button').addEventListener('click', () => host.showMenu());
$('desktop-quit-button').addEventListener('click', () => host.quit());
$('desktop-stop-voice').addEventListener('click', () => companion.stopSpeech());
$('robot-options').addEventListener('toggle', () => {
    if (!$('robot-options').open) document.body.classList.remove('desktop-character-controls');
});
window.addEventListener('jarvis:state', event => { $('desktop-stop-voice').hidden = !event.detail.speaking && !event.detail.speechPending; });
window.addEventListener('jarvis:preferences', event => host.setMuted(event.detail.muted));
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopImmediatePropagation(); host.showMenu(); return;
    }
    if (event.key !== 'Escape' || $('tool-drawer').open || event.defaultPrevented) return;
    if (document.body.classList.contains('desktop-character-controls')) {
        $('robot-options').open = false; document.body.classList.remove('desktop-character-controls');
        event.preventDefault();
    } else if (panelOpen) { event.preventDefault(); toggleChat(false); }
}, true);
host.onCommand(async command => {
    switch (command.name) {
        case 'cursor': {
            let hit = false;
            try { hit = hitTest(command.x, command.y); updateHit(command.x, command.y); } catch (_) { /* Release capture if the renderer cannot test the point. */ }
            host.reportHit(command.token, hit);
            break;
        }
        case 'drag-cancelled': cancelDrag(); break;
        case 'panel': setPanel(command.open === true); break;
        case 'focus-chat': $('query-input').focus({ preventScroll: true }); break;
        case 'mute': companion.setMuted(command.muted === true); break;
        case 'gesture': window.jarvisRobot?.play(command.gesture); break;
        case 'character-controls':
            document.body.classList.toggle('desktop-character-controls');
            $('robot-options').open = document.body.classList.contains('desktop-character-controls');
            break;
        case 'tool': if (['files', 'settings', 'reset'].includes(command.tool)) companion.openTool(command.tool); break;
        case 'voice': companion.startVoice(); break;
        case 'hidden': document.body.dataset.desktopHidden = 'true'; companion.stopSpeech(); companion.cancelVoice(); break;
        case 'shown': document.body.dataset.desktopHidden = 'false'; break;
        case 'connection-start': $('robot-status').textContent = 'Connecting to assistant…'; break;
        case 'connection-error': $('robot-status').textContent = command.message; break;
        case 'reconnected':
            try { await companion.reconnect(); }
            catch (error) { $('robot-status').textContent = error.message; }
            break;
    }
});
setPanel(settings?.panelOpen === true);
