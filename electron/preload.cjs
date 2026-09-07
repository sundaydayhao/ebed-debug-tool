const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("probeAPI", {
  list: () => ipcRenderer.invoke("probe:list"),
  status: () => ipcRenderer.invoke("probe:status"),
  connect: (request) => ipcRenderer.invoke("probe:connect", request),
  disconnect: () => ipcRenderer.invoke("probe:disconnect"),
  command: (command, config) =>
    ipcRenderer.invoke("probe:command", { command, config }),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("probe:event", listener);
    return () => ipcRenderer.removeListener("probe:event", listener);
  },
});

contextBridge.exposeInMainWorld("desktopAPI", {
  capabilities: () => ipcRenderer.invoke("native:capabilities"),
  listSerialPorts: () => ipcRenderer.invoke("serial:list"),
  listConnections: () => ipcRenderer.invoke("connection:list"),
  openConnection: (request) => ipcRenderer.invoke("connection:open", request),
  sendConnection: (request) => ipcRenderer.invoke("connection:send", request),
  closeConnection: (id) => ipcRenderer.invoke("connection:close", id),
  saveFile: (request) => ipcRenderer.invoke("file:save", request),
  onNativeEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    const batch = (_event, payload) => payload.events.forEach(callback);
    ipcRenderer.on("native:event", listener);
    ipcRenderer.on("native:batch", batch);
    return () => {
      ipcRenderer.removeListener("native:event", listener);
      ipcRenderer.removeListener("native:batch", batch);
    };
  },
  onConnectionEvents: (callback) => {
    const listener = (_event, payload) => callback([payload]);
    const batch = (_event, payload) => callback(payload.events);
    ipcRenderer.on("native:event", listener);
    ipcRenderer.on("native:batch", batch);
    return () => {
      ipcRenderer.removeListener("native:event", listener);
      ipcRenderer.removeListener("native:batch", batch);
    };
  },
});
