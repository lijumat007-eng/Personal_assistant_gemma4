'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('jarvisDesktop', Object.freeze({
    getSettings: () => ipcRenderer.invoke('desktop:settings'),
    setPanelOpen: open => ipcRenderer.invoke('desktop:panel', open),
    reportHit: (token, hit) => ipcRenderer.send('desktop:hit', token, hit),
    beginDrag: () => ipcRenderer.send('desktop:drag-start'),
    moveDrag: () => ipcRenderer.send('desktop:drag-move'),
    endDrag: () => ipcRenderer.send('desktop:drag-end'),
    showMenu: () => ipcRenderer.send('desktop:menu'),
    setMuted: muted => ipcRenderer.send('desktop:mute', muted),
    retry: () => ipcRenderer.send('desktop:retry'),
    quit: () => ipcRenderer.send('desktop:quit'),
    onCommand: callback => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, command) => callback(command);
        ipcRenderer.on('desktop:command', listener);
        return () => ipcRenderer.removeListener('desktop:command', listener);
    }
}));
