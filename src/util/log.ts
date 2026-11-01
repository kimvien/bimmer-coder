export type LogLevel = "silent" | "error" | "info" | "debug" | "trace";
const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3, trace: 4 };

export interface Logger {
  level: LogLevel;
  error(msg: string, ...a: unknown[]): void;
  info(msg: string, ...a: unknown[]): void;
  debug(msg: string, ...a: unknown[]): void;
  trace(msg: string, ...a: unknown[]): void;
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = console.log): Logger {
  const at = (want: LogLevel) => ORDER[level] >= ORDER[want];
  const fmt = (tag: string, msg: string, a: unknown[]) =>
    `[${tag}] ${msg}${a.length ? " " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") : ""}`;
  return {
    get level() { return level; },
    set level(l: LogLevel) { level = l; },
    error: (m, ...a) => at("error") && sink(fmt("err", m, a)),
    info: (m, ...a) => at("info") && sink(fmt("info", m, a)),
    debug: (m, ...a) => at("debug") && sink(fmt("dbg", m, a)),
    trace: (m, ...a) => at("trace") && sink(fmt("trc", m, a)),
  };
}

export const silentLogger = createLogger("silent");
