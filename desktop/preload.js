// Ponte segura entre as páginas do app (seletor de tela e configuração) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('straighttalkDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  saveServer: (url) => ipcRenderer.invoke('setup:save', url),
  pickerSources: () => ipcRenderer.invoke('picker:sources'),
  pickerChoose: (choice) => ipcRenderer.send('picker:choose', choice),
});
