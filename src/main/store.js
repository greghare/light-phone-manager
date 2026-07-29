"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

let dataFile = null;
let cacheDir = null;
let state = { repos: [], settings: { githubToken: "", photoBackupDir: "" } };

function init() {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  dataFile = path.join(userData, "repos.json");
  cacheDir = path.join(userData, "apk-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(dataFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      state = {
        repos: Array.isArray(parsed.repos) ? parsed.repos : [],
        settings: { githubToken: "", photoBackupDir: "", ...(parsed.settings || {}) },
      };
    } catch (err) {
      console.error("Failed to read repos.json, starting fresh:", err);
    }
  }
}

function persist() {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
}

function getRepos() {
  return state.repos;
}

function setRepos(repos) {
  state.repos = repos;
  persist();
}

function upsertRepo(repo) {
  const idx = state.repos.findIndex((r) => r.id === repo.id);
  if (idx === -1) state.repos.unshift(repo);
  else state.repos[idx] = repo;
  persist();
  return repo;
}

function patchRepo(id, patch) {
  const idx = state.repos.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  state.repos[idx] = { ...state.repos[idx], ...patch };
  persist();
  return state.repos[idx];
}

function removeRepo(id) {
  state.repos = state.repos.filter((r) => r.id !== id);
  persist();
}

function getSettings() {
  return state.settings;
}

function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
  return state.settings;
}

function getCacheDir() {
  return cacheDir;
}

module.exports = {
  init,
  getRepos,
  setRepos,
  upsertRepo,
  patchRepo,
  removeRepo,
  getSettings,
  setSettings,
  getCacheDir,
};
