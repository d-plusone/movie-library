/**
 * デバッグログの抑制用ロガー
 * production ビルドでは debug / log / info を出力しない（warn / error は常に出力）。
 * main プロセスは createLogger(app.isPackaged)、
 * renderer は createLogger(window.electronAPI.isProduction) で生成する。
 */

export interface AppLogger {
  debug(...args: Parameters<typeof console.debug>): void;
  log(...args: Parameters<typeof console.log>): void;
  info(...args: Parameters<typeof console.info>): void;
  warn(...args: Parameters<typeof console.warn>): void;
  error(...args: Parameters<typeof console.error>): void;
}

export function createLogger(isProduction: boolean): AppLogger {
  if (isProduction) {
    return {
      // production ではデバッグログを抑制
      debug: () => {},
      log: () => {},
      info: () => {},
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }
  return {
    debug: (...args) => console.debug(...args),
    log: (...args) => console.log(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}
