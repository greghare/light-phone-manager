"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, callback) {
  const listener = (_evt, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("api", {
  reposList: () => ipcRenderer.invoke("repos:list"),
  reposAdd: (url) => ipcRenderer.invoke("repos:add", url),
  reposRemove: (id) => ipcRenderer.invoke("repos:remove", id),
  reposRefresh: (id) => ipcRenderer.invoke("repos:refresh", id),

  deviceGet: () => ipcRenderer.invoke("device:get"),
  deviceRefresh: () => ipcRenderer.invoke("device:refresh"),
  deviceReboot: () => ipcRenderer.invoke("device:reboot"),

  osSettingsGet: () => ipcRenderer.invoke("os-settings:get"),
  osSettingsRefresh: () => ipcRenderer.invoke("os-settings:refresh"),
  osSettingsSetAnimations: (on) => ipcRenderer.invoke("os-settings:setAnimations", on),
  osSettingsSetShowExternalTools: (on) => ipcRenderer.invoke("os-settings:setShowExternalTools", on),
  osSettingsSetChromiumHidden: (hidden) => ipcRenderer.invoke("os-settings:setChromiumHidden", hidden),

  installStart: (repoId, version) => ipcRenderer.invoke("install:start", { repoId, version }),
  installLatest: (repoId) => ipcRenderer.invoke("install:latest", repoId),
  installUpdateAll: () => ipcRenderer.invoke("install:updateAll"),
  uninstallStart: (repoId) => ipcRenderer.invoke("uninstall:start", repoId),
  appLaunch: (repoId) => ipcRenderer.invoke("app:launch", repoId),
  appLogsStart: (repoId) => ipcRenderer.invoke("applogs:start", repoId),
  appLogsStop: () => ipcRenderer.invoke("applogs:stop"),

  apkPickFile: () => ipcRenderer.invoke("apk:pickFile"),
  apkInspect: (filePath) => ipcRenderer.invoke("apk:inspect", filePath),
  apkInstallDropped: (filePath, parsed, matchId, newId) =>
    ipcRenderer.invoke("apk:installDropped", { filePath, parsed, matchId, newId }),

  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  mediaGetSettings: () => ipcRenderer.invoke("media:getSettings"),
  mediaChooseBackupDir: () => ipcRenderer.invoke("media:chooseBackupDir"),
  mediaList: (key) => ipcRenderer.invoke("media:list", key),
  mediaBackupNow: () => ipcRenderer.invoke("media:backupNow"),
  mediaOpenFolder: (key) => ipcRenderer.invoke("media:openFolder", key),

  ringtonesList: () => ipcRenderer.invoke("ringtones:list"),
  ringtonesUpload: (remoteFilename, backupFilename) => ipcRenderer.invoke("ringtones:pickAndUpload", { remoteFilename, backupFilename }),
  ringtonesRestore: (remoteFilename, backupFilename) => ipcRenderer.invoke("ringtones:restore", { remoteFilename, backupFilename }),
  ringtonesGetPlayUrl: (remoteFilename) => ipcRenderer.invoke("ringtones:getPlayUrl", { remoteFilename }),

  lightStatus: () => ipcRenderer.invoke("light:status"),
  lightLogin: (email, password) => ipcRenderer.invoke("light:login", { email, password }),
  lightSelectDevice: (deviceId) => ipcRenderer.invoke("light:selectDevice", deviceId),
  lightLogout: () => ipcRenderer.invoke("light:logout"),

  podcastsList: () => ipcRenderer.invoke("podcasts:list"),
  podcastsAdd: (rssUrl) => ipcRenderer.invoke("podcasts:add", rssUrl),
  podcastsRemove: (title) => ipcRenderer.invoke("podcasts:remove", title),
  podcastsSearchAvailable: () => ipcRenderer.invoke("podcasts:searchAvailable"),
  podcastsSearch: (term) => ipcRenderer.invoke("podcasts:search", term),

  notesList: () => ipcRenderer.invoke("notes:list"),
  notesListPreviews: () => ipcRenderer.invoke("notes:listPreviews"),
  notesGet: (noteId) => ipcRenderer.invoke("notes:get", noteId),
  notesCreate: (title, content) => ipcRenderer.invoke("notes:create", { title, content }),
  notesUpdate: (noteId, { title, content }) => ipcRenderer.invoke("notes:update", { noteId, title, content }),
  notesRemove: (noteId) => ipcRenderer.invoke("notes:remove", noteId),

  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:isMaximized"),

  onDeviceUpdate: (cb) => on("device:update", cb),
  onOsSettingsUpdate: (cb) => on("os-settings:update", cb),
  onReposChanged: (cb) => on("repos:changed", cb),
  onInstallLog: (cb) => on("install:log", cb),
  onAppLogsLine: (cb) => on("applogs:line", cb),
  onToast: (cb) => on("toast", cb),
  onWindowMaximizedChange: (cb) => on("window:maximized", cb),
  onMediaChanged: (cb) => on("media:changed", cb),
});
