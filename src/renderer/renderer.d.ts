// Renderer process specific type definitions

/// <reference path="../types/electron.d.ts" />

declare global {
  interface Window {
    electronAPI: import("../types/electron").ElectronAPI;
  }
}

export {};
