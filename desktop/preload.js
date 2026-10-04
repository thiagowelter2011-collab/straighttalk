// Ponte segura entre as páginas do app (seletor de tela e configuração) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('straighttalkDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  saveServer: (url) => ipcRenderer.invoke('setup:save', url),
  pickerSources: () => ipcRenderer.invoke('picker:sources'),
  pickerChoose: (choice) => ipcRenderer.send('picker:choose', choice),
  // Avisos: trazer a janela para frente, piscar na barra de tarefas e número de novidades no ícone
  focus: () => ipcRenderer.send('win:focus'),
  attention: () => ipcRenderer.send('win:attention'),
  setBadge: (dataUrl, text) => ipcRenderer.send('win:badge', dataUrl, text),
});
