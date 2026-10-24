'use strict';
document.getElementById('retry').onclick = () => window.jarvisDesktop.retry();
document.getElementById('menu').onclick = () => window.jarvisDesktop.showMenu();
window.jarvisDesktop.onCommand(command => {
    if (command.name === 'connection-error') document.getElementById('connection-status').textContent = command.message;
});
