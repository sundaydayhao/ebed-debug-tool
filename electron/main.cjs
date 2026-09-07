const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DeviceHub } = require("./device-hub.cjs");
const { ConnectionManager } = require("./connection-manager.cjs");

let mqtt = null;
try {
  mqtt = require("mqtt");
} catch {
  mqtt = null;
}

let SerialPort = null;
try {
  const serialport = require("serialport");
  SerialPort = serialport.SerialPort || serialport;
} catch {
  SerialPort = null;
}

let connections;
let mainWindow = null;
const smokeOutput = process.argv
  .find((arg) => arg.startsWith("--ebed-smoke-test="))
  ?.split("=")
  .slice(1)
  .join("=");
const probe = new DeviceHub(
  SerialPort,
  (event) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("probe:event", event);
  },
  (devicePath) => connections?.uses(devicePath),
);
connections = new ConnectionManager({
  SerialPort,
  mqtt,
  isPortUsed: (devicePath) => probe.uses(devicePath),
  emit: (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(
      event.type === "batch" ? "native:batch" : "native:event",
      event,
    );
  },
});
ipcMain.handle("probe:list", () => probe.list());
ipcMain.handle("probe:status", () => probe.snapshot());
ipcMain.handle("probe:connect", (_event, request) => probe.connect(request));
ipcMain.handle("probe:disconnect", () => probe.disconnect());
ipcMain.handle("probe:command", (_event, { command, config }) =>
  probe.command(command, config),
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 720,
    title: "EBED Studio · 嵌入式无线工作台",
    backgroundColor: "#f5f6f8",
    autoHideMenuBar: true,
    show: !smokeOutput,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });

  if (smokeOutput) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const page = await mainWindow.webContents
          .executeJavaScript(`(async () => ({
          title: document.title,
          pageProtocol: location.protocol,
          hasWorkspace: document.body.innerText.includes('从信号，到答案。'),
          native: await window.desktopAPI.capabilities(),
          probe: await window.probeAPI.status(),
          serialPorts: (await window.probeAPI.list()).length
        }))()`);
        const ok =
          page.hasWorkspace &&
          page.pageProtocol === "file:" &&
          page.native.serialAvailable &&
          !page.probe.connected;
        await fs.writeFile(
          smokeOutput,
          JSON.stringify({ ok, ...page }, null, 2),
        );
        app.exit(ok ? 0 : 1);
      } catch (error) {
        await fs.writeFile(
          smokeOutput,
          JSON.stringify({ ok: false, error: error.message }),
        );
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      if (permission === "serial") return true;
      return false;
    },
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  probe.fail("窗口已关闭");
  connections.dispose();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  probe.dispose();
  connections.dispose();
});

ipcMain.handle("native:capabilities", async () => {
  return {
    platform: process.platform,
    serialAvailable: Boolean(SerialPort),
    tcpAvailable: true,
    udpAvailable: true,
    mqttAvailable: Boolean(mqtt),
    node: process.versions.node,
    electron: process.versions.electron,
  };
});

ipcMain.handle("serial:list", async () => {
  if (!SerialPort) return [];
  return SerialPort.list();
});

ipcMain.handle("connection:list", () => connections.list());
ipcMain.handle("connection:open", (_event, request) =>
  connections.open(request),
);
ipcMain.handle("connection:send", (_event, request) =>
  connections.send(request),
);
ipcMain.handle("connection:close", (_event, id) => connections.close(id));

ipcMain.handle("file:save", async (_event, request) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: request.title || "保存文件",
    defaultPath: request.defaultPath || "ebed-debug-export.txt",
    filters: request.filters || [{ name: "All files", extensions: ["*"] }],
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  await fs.writeFile(
    result.filePath,
    request.content,
    request.encoding || "utf8",
  );
  return { ok: true, path: result.filePath };
});
