// src/worker.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { dirname as dirname3, join as join3, resolve as resolve3, sep } from "node:path";
import { homedir as homedir2 } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/lsp-client.ts
import { spawn } from "node:child_process";
var LspClient = class {
  proc;
  buf = Buffer.alloc(0);
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  notifyHandlers = /* @__PURE__ */ new Map();
  requestHandlers = /* @__PURE__ */ new Map();
  exited = false;
  onExit;
  log = () => {
  };
  constructor(command, args, cwd, env) {
    this.proc = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => this.onData(d));
    this.proc.stderr.on("data", (d) => this.log(`[stderr] ${d.toString().trim().slice(0, 500)}`));
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("language server exited"));
      }
      this.pending.clear();
      this.onExit?.(code);
    });
    this.proc.on("error", (e) => this.log(`[spawn] ${e.message}`));
  }
  onNotification(method, h) {
    this.notifyHandlers.set(method, h);
  }
  onRequest(method, h) {
    this.requestHandlers.set(method, h);
  }
  request(method, params, timeoutMs = 15e3) {
    if (this.exited) return Promise.reject(new Error("language server exited"));
    const id = ++this.nextId;
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve4, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    if (!this.exited) this.write({ jsonrpc: "2.0", method, params });
  }
  kill() {
    try {
      this.proc.kill();
    } catch {
    }
  }
  write(msg) {
    const s = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s, "utf8")}\r
\r
${s}`);
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (; ; ) {
      const h = this.buf.indexOf("\r\n\r\n");
      if (h < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, h).toString("ascii"));
      if (!m) {
        this.buf = this.buf.subarray(h + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < h + 4 + len) return;
      const body = this.buf.subarray(h + 4, h + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(h + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }
  dispatch(msg) {
    if (msg.id !== void 0 && msg.method === void 0) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== void 0) {
      const h = this.requestHandlers.get(msg.method);
      Promise.resolve(h ? h(msg.params) : null).then((result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null })).catch((e) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }));
      return;
    }
    this.notifyHandlers.get(msg.method)?.(msg.params);
  }
};

// src/interpreters.ts
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
var WIN = process.platform === "win32";
var lower = (p) => WIN ? p.toLowerCase() : p;
function envExe(envDir) {
  const c = WIN ? [join(envDir, "Scripts", "python.exe"), join(envDir, "bin", "python.exe"), join(envDir, "python.exe")] : [join(envDir, "bin", "python"), join(envDir, "bin", "python3")];
  return c.find((f) => existsSync(f)) ?? null;
}
var SKIP = /* @__PURE__ */ new Set([".git", "node_modules", ".tox", "__pycache__", "bin", "Scripts", ".mypy_cache", ".pytest_cache", ".orca"]);
var PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", ".git"];
function readJsonc(file) {
  try {
    const text = readFileSync(file, "utf8");
    let s = "", inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (inStr) {
        s += c;
        if (c === "\\") {
          s += n;
          i++;
        } else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
        s += c;
      } else if (c === "/" && n === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        s += "\n";
      } else if (c === "/" && n === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i++;
      } else s += c;
    }
    return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}
function venvVersion(envDir) {
  try {
    const cfg = readFileSync(join(envDir, "pyvenv.cfg"), "utf8");
    return /^\s*(?:version_info|version)\s*=\s*([\d.]+)/im.exec(cfg)?.[1] ?? null;
  } catch {
    return null;
  }
}
var versionCache = /* @__PURE__ */ new Map();
function runVersion(python) {
  const k = lower(python);
  if (versionCache.has(k)) return versionCache.get(k);
  let v = null;
  try {
    v = execFileSync(python, ["-c", 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { encoding: "utf8", timeout: 4e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    v = null;
  }
  versionCache.set(k, v);
  return v;
}
function cmpVersionDesc(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}
var isEnvDir = (dir) => existsSync(join(dir, "pyvenv.cfg")) || existsSync(join(dir, "conda-meta"));
function projectEnvs(root) {
  const found = /* @__PURE__ */ new Set();
  for (const n of [".venv", ".conda", ".virtualenv", "venv"]) if (isEnvDir(join(root, n))) found.add(join(root, n));
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
  }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const full = join(root, n);
    try {
      if (statSync(full).isDirectory() && isEnvDir(full)) found.add(full);
    } catch {
    }
  }
  return [...found];
}
function projectRootFor(file, limit) {
  let dir = dirname(resolve(file));
  const stop = lower(resolve(limit));
  while (lower(dir).startsWith(stop)) {
    if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) || projectEnvs(dir).length) return dir;
    if (lower(dir) === stop) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(limit);
}
function vscodeInterpreter(root) {
  for (let dir = root, i = 0; i < 6; i++) {
    const s = readJsonc(join(dir, ".vscode", "settings.json"));
    const raw = s?.["python.defaultInterpreterPath"] ?? s?.["python.pythonPath"];
    if (raw && raw !== "python") {
      const p = raw.replace(/\$\{workspaceFolder\}/g, dir).replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] ?? "");
      const abs = isAbsolute(p) ? p : resolve(dir, p);
      if (existsSync(abs) && statSync(abs).isFile()) return abs;
      const exe2 = envExe(abs);
      if (exe2) return exe2;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
function pyrightConfigInterpreter(root) {
  const cfg = readJsonc(join(root, "pyrightconfig.json"));
  let venvPath = cfg?.venvPath;
  let venv = cfg?.venv;
  if (!venv) {
    try {
      const toml = readFileSync(join(root, "pyproject.toml"), "utf8");
      const sec = /\[tool\.(?:based)?pyright\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
      venvPath = /venvPath\s*=\s*"([^"]+)"/.exec(sec)?.[1] ?? venvPath;
      venv = /^\s*venv\s*=\s*"([^"]+)"/m.exec(sec)?.[1];
    } catch {
    }
  }
  if (!venv) return null;
  return envExe(resolve(root, venvPath ?? ".", venv));
}
function globalCandidates() {
  const out = [];
  if (WIN) {
    try {
      const txt = execFileSync("py", ["-0p"], { encoding: "utf8", timeout: 4e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of txt.split(/\r?\n/)) {
        const m = /([A-Za-z]:\\.*python\.exe)\s*$/i.exec(line.trim());
        if (m) out.push(m[1]);
      }
    } catch {
    }
    const base = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Python");
    try {
      for (const d of readdirSync(base)) out.push(join(base, d, "python.exe"));
    } catch {
    }
  }
  const names = WIN ? ["python.exe"] : ["python3", "python"];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN ? ";" : ":")) {
    if (!dir || /WindowsApps/i.test(dir)) continue;
    for (const n of names) out.push(join(dir, n));
  }
  if (!WIN) out.push("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3");
  const seen = /* @__PURE__ */ new Set();
  return out.filter((p) => {
    const k = lower(p);
    if (seen.has(k) || !existsSync(p)) return false;
    seen.add(k);
    return true;
  });
}
function discoverInterpreters(file, root, opts = {}) {
  const project = projectRootFor(file, root);
  const list = [];
  const seen = /* @__PURE__ */ new Set();
  const make = (path, source, reason) => {
    const key2 = lower(resolve(path));
    if (seen.has(key2) || !existsSync(path)) return null;
    seen.add(key2);
    const envDir = dirname(dirname(path));
    const isVenv = isEnvDir(envDir) || isEnvDir(dirname(path));
    const dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname(path)) ? dirname(path) : null;
    const version = dir && venvVersion(dir) || runVersion(path);
    const name = dir ? lower(dir).startsWith(lower(project) + (WIN ? "\\" : "/")) ? dir.slice(project.length + 1).replace(/\\/g, "/") : basename(dir) : `Python ${version ?? ""}`.trim();
    return { path: resolve(path), label: isVenv ? `${name}${version ? ` (${version})` : ""}` : `${name} (global)`, version, source, envDir: dir, reason };
  };
  const add = (path, source, reason) => {
    if (!path) return;
    const it = make(path, source, reason);
    if (it) list.push(it);
  };
  add(opts.saved, "saved", "b\u1EA1n \u0111\xE3 ch\u1ECDn cho d\u1EF1 \xE1n n\xE0y");
  add(opts.setting, "setting", 'setting "Python interpreter" c\u1EE7a plugin');
  add(vscodeInterpreter(project), "vscode", "python.defaultInterpreterPath trong .vscode/settings.json");
  add(pyrightConfigInterpreter(project), "pyright", "venvPath/venv trong pyrightconfig/pyproject");
  const levels = [];
  for (let dir = project; lower(dir).startsWith(lower(resolve(root))); ) {
    levels.push(dir);
    if (lower(dir) === lower(resolve(root))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const [i, dir] of levels.entries()) {
    const envs = projectEnvs(dir).map((d) => ({ d, exe: envExe(d) })).map((x) => ({ ...x, version: venvVersion(x.d) })).sort((a, b) => Number(!a.exe) - Number(!b.exe) || cmpVersionDesc(a.version, b.version) || basename(a.d).localeCompare(basename(b.d)) || a.d.localeCompare(b.d));
    for (const e of envs) if (e.exe) add(e.exe, "venv", i === 0 ? envs.length > 1 ? `venv trong d\u1EF1 \xE1n (${envs.length} venv: ch\u1ECDn b\u1EA3n Python cao nh\u1EA5t)` : "venv trong d\u1EF1 \xE1n" : "venv c\u1EE7a th\u01B0 m\u1EE5c cha");
  }
  const active = process.env.VIRTUAL_ENV;
  if (active && lower(resolve(active)).startsWith(lower(project))) add(envExe(active), "env", "VIRTUAL_ENV \u0111ang k\xEDch ho\u1EA1t");
  const globals = globalCandidates().map((p) => ({ p, v: runVersion(p) })).filter((x) => x.v).sort((a, b) => cmpVersionDesc(a.v, b.v));
  for (const g of globals) add(g.p, "global", "kh\xF4ng c\xF3 venv: d\xF9ng Python c\xE0i \u0111\u1EB7t b\u1EA3n cao nh\u1EA5t");
  return list;
}

// src/servers.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { homedir } from "node:os";
var EXTS_OF_LANG = {
  python: /\.(py|pyi|pyw)$/i,
  qml: /\.qml$/i,
  cpp: /\.(cpp|cc|cxx|c\+\+|c|h|hpp|hh|hxx|inl|ipp)$/i
};
var LANGUAGE_ID = {
  python: () => "python",
  qml: () => "qml",
  cpp: (p) => /\.c$/i.test(p) ? "c" : "cpp"
};
var SERVER_LABEL = { python: "Pyright", qml: "qmlls", cpp: "clangd" };
var WIN2 = process.platform === "win32";
var home = () => process.env.USERPROFILE ?? process.env.HOME ?? homedir();
var pathDirs = () => (process.env.PATH ?? process.env.Path ?? "").split(WIN2 ? ";" : ":").filter(Boolean);
var exe = (name) => WIN2 ? `${name}.exe` : name;
var lower2 = (p) => WIN2 ? p.toLowerCase() : p;
function qtBinDirs(extra) {
  const out = [];
  if (extra) out.push(extra);
  const roots = WIN2 ? ["C:\\Qt", join2(home(), "Qt")] : [join2(home(), "Qt"), "/opt/Qt", "/usr/local/Qt"];
  for (const root of roots) {
    let versions = [];
    try {
      versions = readdirSync2(root).filter((v) => /^\d+\.\d+/.test(v));
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, void 0, { numeric: true }));
    for (const v of versions) {
      let kits = [];
      try {
        kits = readdirSync2(join2(root, v));
      } catch {
        continue;
      }
      for (const k of kits) if (existsSync2(join2(root, v, k, "bin"))) out.push(join2(root, v, k, "bin"));
    }
  }
  return out;
}
function firstExisting(cands) {
  for (const c of cands) if (c && existsSync2(c)) return c;
  return null;
}
function findQmlls(configured, qtBin) {
  if (configured && existsSync2(configured)) return configured;
  return firstExisting([...qtBinDirs(qtBin).map((d) => join2(d, exe("qmlls"))), ...pathDirs().map((d) => join2(d, exe("qmlls")))]);
}
function findClangd(configured) {
  if (configured && existsSync2(configured)) return configured;
  const c = [];
  if (WIN2) {
    for (const root of ["C:\\Qt", join2(home(), "Qt")]) c.push(join2(root, "Tools", "QtCreator", "bin", "clang", "bin", "clangd.exe"));
    c.push("C:\\Program Files\\LLVM\\bin\\clangd.exe");
  } else {
    c.push("/Applications/Qt Creator.app/Contents/Resources/libexec/clang/bin/clangd", join2(home(), "Qt", "Tools", "QtCreator", "libexec", "qtcreator", "clang", "bin", "clangd"), "/usr/bin/clangd", "/usr/local/bin/clangd", "/opt/homebrew/opt/llvm/bin/clangd");
  }
  c.push(...pathDirs().map((d) => join2(d, exe("clangd"))));
  try {
    const vsc = join2(home(), ".vscode", "extensions");
    for (const d of readdirSync2(vsc).filter((n) => n.startsWith("llvm-vs-code-extensions.vscode-clangd"))) {
      const inst = join2(vsc, d, "install");
      for (const v of existsSync2(inst) ? readdirSync2(inst) : []) c.push(join2(inst, v, `clangd_${v}`, "bin", exe("clangd")));
    }
  } catch {
  }
  return firstExisting(c);
}
var BUILD_DIR_RE = /^(build|out|cmake-build-.*|build-.*|_build)$/i;
function findBuildDirs(root, want) {
  const hits = [];
  const check = (dir) => {
    try {
      if (want === "compile_commands") {
        const f = join2(dir, "compile_commands.json");
        if (existsSync2(f)) hits.push({ dir, mtime: statSync2(f).mtimeMs });
      } else if (existsSync2(join2(dir, "CMakeCache.txt")) || existsSync2(join2(dir, "qmldir"))) {
        hits.push({ dir, mtime: statSync2(dir).mtimeMs });
      }
    } catch {
    }
  };
  if (want === "compile_commands") check(root);
  let names = [];
  try {
    names = readdirSync2(root);
  } catch {
    return [];
  }
  for (const n of names) {
    if (!BUILD_DIR_RE.test(n)) continue;
    const d = join2(root, n);
    try {
      if (!statSync2(d).isDirectory()) continue;
    } catch {
      continue;
    }
    check(d);
    try {
      for (const s of readdirSync2(d)) {
        const sd = join2(d, s);
        try {
          if (statSync2(sd).isDirectory()) check(sd);
        } catch {
        }
      }
    } catch {
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime).map((h) => h.dir);
}
var PROJECT_MARKERS2 = {
  python: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", ".git"],
  // QML/C++: du an CMake/qmake (CMakeLists.txt sau nhat co project()), .qmlls.ini, compile_commands, .git
  qml: [".qmlls.ini", "CMakeLists.txt", ".git"],
  cpp: ["compile_commands.json", ".clangd", "compile_flags.txt", "CMakeLists.txt", ".git"]
};
function projectRootFor2(lang, file, limit) {
  const stop = lower2(resolve2(limit));
  const chain = [];
  for (let dir = dirname2(resolve2(file)); lower2(dir).startsWith(stop); ) {
    chain.push(dir);
    if (lower2(dir) === stop) break;
    const up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  if (lang === "python") {
    const hasVenv = (d) => {
      try {
        return readdirSync2(d).some((n) => existsSync2(join2(d, n, "pyvenv.cfg")));
      } catch {
        return false;
      }
    };
    for (const d of chain) if (PROJECT_MARKERS2.python.some((m) => existsSync2(join2(d, m))) || hasVenv(d)) return d;
    return resolve2(limit);
  }
  const strong = lang === "qml" ? [".qmlls.ini"] : ["compile_commands.json", ".clangd", "compile_flags.txt"];
  for (const d of chain) if (strong.some((m) => existsSync2(join2(d, m)))) return d;
  let top = null;
  for (const d of chain) {
    if (existsSync2(join2(d, "CMakeLists.txt")) || existsSync2(join2(d, `${d.split(/[\\/]/).pop()}.pro`))) top = d;
    else if (top) break;
  }
  if (top) return top;
  for (const d of chain) if (existsSync2(join2(d, ".git"))) return d;
  return resolve2(limit);
}

// src/worker.ts
var SKIP2 = /* @__PURE__ */ new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "env", "dist", ".orca", ".mypy_cache", ".pytest_cache", "site-packages", ".cache", ".qtc_clangd"]);
var sha = (s) => createHash("sha1").update(s.replace(/\r\n/g, "\n")).digest("hex");
var WIN3 = process.platform === "win32";
var PLUGIN_DIR = resolve3(dirname3(fileURLToPath(import.meta.url)), "..");
var isLocal = (w) => !w.hostId || w.hostId === "local";
var norm = (p) => WIN3 ? p.toLowerCase() : p;
var key = (lang, root) => `${lang}|${norm(root)}`;
var langOfPath = (p) => EXTS_OF_LANG.python.test(p) ? "python" : EXTS_OF_LANG.qml.test(p) ? "qml" : EXTS_OF_LANG.cpp.test(p) ? "cpp" : null;
function activate(orca) {
  const servers = /* @__PURE__ */ new Map();
  const hashIndex = /* @__PURE__ */ new Map();
  async function setting(k, fallback) {
    try {
      const v = await orca.settings.get(k);
      return v === void 0 || v === null || v === "" ? fallback : v;
    } catch {
      return fallback;
    }
  }
  async function focusedRoot() {
    const ctx = await orca.host.call("workspace.readContext", {});
    if (!ctx) return null;
    const { workspaces } = await orca.host.call("workspace.list", {});
    const local = workspaces.filter(isLocal);
    const pool = local.length ? local : workspaces;
    const m = pool.find((w) => w.name === ctx.displayName && (w.branch ?? "") === (ctx.branch ?? "")) ?? pool.find((w) => w.name === ctx.displayName);
    return m?.path ?? null;
  }
  function indexFor(root) {
    const cached = hashIndex.get(root);
    if (cached && Date.now() - cached.at < 3e5) return cached.byHash;
    const byHash = /* @__PURE__ */ new Map();
    let count = 0;
    const walk = (dir, depth) => {
      if (depth > 10 || count > 8e3) return;
      let names = [];
      try {
        names = readdirSync3(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const full = join3(dir, n);
        let st;
        try {
          st = statSync3(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP2.has(n) && !n.startsWith(".") && !/^(build|out|cmake-build-)/i.test(n)) walk(full, depth + 1);
          continue;
        }
        if (!langOfPath(n) || st.size > 2e6) continue;
        count++;
        try {
          const h = sha(readFileSync2(full, "utf8"));
          const list = byHash.get(h) ?? [];
          list.push(full);
          byHash.set(h, list);
        } catch {
        }
      }
    };
    walk(root, 0);
    hashIndex.set(root, { at: Date.now(), byHash });
    return byHash;
  }
  const SAVED_KEY = "interpreters";
  async function savedInterpreters() {
    try {
      const v = await orca.storage.get(SAVED_KEY);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  async function interpretersFor(root, file) {
    const saved = (await savedInterpreters())[norm(root)];
    return discoverInterpreters(file ?? join3(root, "__init__.py"), root, { saved, setting: await setting("python", "") });
  }
  function findNode() {
    const exe2 = WIN3 ? "node.exe" : "node";
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN3 ? ";" : ":")) if (dir && existsSync3(join3(dir, exe2))) return join3(dir, exe2);
    for (const c of WIN3 ? ["C:\\Program Files\\nodejs\\node.exe"] : ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]) if (existsSync3(c)) return c;
    return process.execPath;
  }
  function pyrightEntry() {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir2();
    const local = process.env.LOCALAPPDATA ?? (WIN3 ? join3(h, "AppData", "Local") : join3(h, ".local", "share"));
    const appData = process.env.APPDATA ?? (WIN3 ? join3(h, "AppData", "Roaming") : void 0);
    const c = [join3(PLUGIN_DIR, "server", "pyright", "langserver.index.js"), join3(local, "orca-qt-lsp", "node_modules", "basedpyright", "langserver.index.js")];
    if (appData) c.push(join3(appData, "npm", "node_modules", "basedpyright", "langserver.index.js"), join3(appData, "npm", "node_modules", "pyright", "langserver.index.js"));
    for (const p of ["/usr/local", "/opt/homebrew", join3(h, ".npm-global")]) c.push(join3(p, "lib", "node_modules", "basedpyright", "langserver.index.js"), join3(p, "lib", "node_modules", "pyright", "langserver.index.js"));
    return c.find((p) => existsSync3(p)) ?? null;
  }
  async function commandFor(lang, root) {
    if (lang === "python") {
      const entry = await setting("pyrightPath", "") || pyrightEntry();
      if (!entry) throw new Error('Kh\xF4ng t\xECm th\u1EA5y basedpyright/Pyright. C\xE0i: npm i --prefix "%LOCALAPPDATA%\\orca-qt-lsp" basedpyright');
      const node = await setting("nodePath", "") || findNode();
      return { cmd: node, args: [entry, "--stdio"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detail: entry.includes("basedpyright") ? "basedpyright" : "pyright" };
    }
    if (lang === "qml") {
      const qmlls = findQmlls(await setting("qmllsPath", ""), await setting("qtBin", ""));
      if (!qmlls) throw new Error('Kh\xF4ng t\xECm th\u1EA5y qmlls (Qt 6.4+). \u0110\u1EB7t "qmlls path" ho\u1EB7c "Qt bin folder" trong Settings c\u1EE7a plugin.');
      const args2 = [];
      const builds = findBuildDirs(root, "qml");
      for (const b of builds.slice(0, 1)) args2.push("-b", b);
      const qmlDir = join3(dirname3(dirname3(qmlls)), "qml");
      if (existsSync3(qmlDir)) args2.push("-I", qmlDir);
      return { cmd: qmlls, args: args2, detail: builds[0] ? `build: ${builds[0].slice(root.length + 1) || "."}` : "ch\u01B0a c\xF3 th\u01B0 m\u1EE5c build (ch\u1EA1y CMake configure \u0111\u1EC3 qmlls th\u1EA5y module c\u1EE7a d\u1EF1 \xE1n)" };
    }
    const clangd = findClangd(await setting("clangdPath", ""));
    if (!clangd) throw new Error('Kh\xF4ng t\xECm th\u1EA5y clangd. C\xE0i LLVM ho\u1EB7c Qt Creator, ho\u1EB7c \u0111\u1EB7t "clangd path" trong Settings.');
    const args = ["--background-index", "--clang-tidy=false", "--header-insertion=never", "--completion-style=detailed", "--log=error", "--pch-storage=memory"];
    const cc = findBuildDirs(root, "compile_commands");
    if (cc[0]) args.push(`--compile-commands-dir=${cc[0]}`);
    args.push("--query-driver=**/*g++*,**/*gcc*,**/*c++*,**/*cc.exe,**/*clang++*,**/*clang*,**/cl.exe");
    return { cmd: clangd, args, detail: cc[0] ? `compile_commands: ${cc[0].slice(root.length + 1) || "."}` : "ch\u01B0a c\xF3 compile_commands.json (CMake configure v\u1EDBi CMAKE_EXPORT_COMPILE_COMMANDS=ON)" };
  }
  async function serverFor(lang, root, file) {
    const existing = servers.get(key(lang, root));
    if (existing && !existing.client.exited) return existing;
    const { cmd, args, env, detail } = await commandFor(lang, root);
    orca.log(`spawn ${lang}: ${cmd} ${args.join(" ")} (root ${root})`);
    const client = new LspClient(cmd, args, lang === "python" ? PLUGIN_DIR : root, env);
    client.log = (l) => orca.log(`[${lang}] ${l}`);
    const srv = { lang, root, client, ready: Promise.resolve(), open: /* @__PURE__ */ new Map(), diagnostics: /* @__PURE__ */ new Map(), legend: null, interpreter: null, detail };
    client.onExit = (code) => {
      orca.log(`${lang} server exited (${code}) for ${root}`);
      if (servers.get(key(lang, root)) === srv) servers.delete(key(lang, root));
    };
    if (lang === "python") {
      srv.interpreter = (await interpretersFor(root, file))[0] ?? null;
      orca.log(`interpreter for ${root}: ${srv.interpreter ? `${srv.interpreter.path} [${srv.interpreter.source}]` : "none"}`);
    }
    client.onRequest("workspace/configuration", (params) => params.items.map((it) => {
      if (lang !== "python") return {};
      const py = srv.interpreter?.path;
      if (it.section === "python") return py ? { pythonPath: py, defaultInterpreterPath: py } : {};
      if (it.section === "python.analysis" || it.section === "basedpyright.analysis") {
        return { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true };
      }
      return {};
    }));
    client.onRequest("window/workDoneProgress/create", () => null);
    client.onRequest("client/registerCapability", () => null);
    client.onRequest("window/showMessageRequest", () => null);
    client.onRequest("workspace/semanticTokens/refresh", () => {
      orca.panels.post("lsp.refresh", { lang, root });
      return null;
    });
    client.onNotification("window/showMessage", (p) => orca.log(`[${lang}] ${p?.message ?? ""}`));
    client.onNotification("textDocument/publishDiagnostics", (p) => {
      let path;
      try {
        path = fileURLToPath(p.uri);
      } catch {
        return;
      }
      const out = {
        version: p.version ?? -1,
        items: p.diagnostics.map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code === "object" ? d.code?.value : d.code }))
      };
      srv.diagnostics.set(norm(path), out);
      orca.panels.post("lsp.diagnostics", { path, ...out });
    });
    const rootUri = pathToFileURL(root).href;
    srv.ready = client.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: root.split(sep).pop() }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          definition: { linkSupport: false },
          declaration: { linkSupport: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] }, contextSupport: true },
          publishDiagnostics: { versionSupport: true },
          semanticTokens: { requests: { full: true, range: false }, tokenTypes: [], tokenModifiers: [], formats: ["relative"], multilineTokenSupport: false, overlappingTokenSupport: false }
        },
        workspace: { configuration: true, workspaceFolders: true, semanticTokens: { refreshSupport: true } }
      },
      initializationOptions: lang === "cpp" ? { clangdFileStatus: false } : {}
    }, 6e4).then((init) => {
      const legend = init?.capabilities?.semanticTokensProvider?.legend;
      if (legend?.tokenTypes) srv.legend = { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers ?? [] };
      client.notify("initialized", {});
      if (lang === "python") client.notify("workspace/didChangeConfiguration", { settings: {} });
    });
    servers.set(key(lang, root), srv);
    await srv.ready;
    orca.log(`${lang} ready for ${root} (${detail})`);
    return srv;
  }
  function serverOf(lang, path) {
    let best = null;
    for (const s of servers.values()) {
      if (s.lang !== lang) continue;
      if (norm(path).startsWith(norm(s.root) + sep) && (!best || s.root.length > best.root.length)) best = s;
    }
    return best;
  }
  const attachedRoots = /* @__PURE__ */ new Map();
  const uriOf = (path) => pathToFileURL(path).href;
  async function rootForFile(lang, path) {
    const hit = attachedRoots.get(`${lang}|${norm(path)}`);
    if (hit) return hit;
    const { workspaces } = await orca.host.call("workspace.list", {});
    const p = norm(resolve3(path));
    let best = null;
    for (const w of workspaces) {
      if (!isLocal(w)) continue;
      const r = resolve3(w.path);
      if (p.startsWith(norm(r) + sep) && (!best || r.length > best.length)) best = r;
    }
    if (!best) return null;
    const root = projectRootFor2(lang, path, best);
    attachedRoots.set(`${lang}|${norm(path)}`, root);
    return root;
  }
  async function serverForPath(path) {
    const lang = langOfPath(path);
    if (!lang) throw new Error(`Kh\xF4ng h\u1ED7 tr\u1EE3 lo\u1EA1i file ${path}`);
    const r = await rootForFile(lang, path);
    if (!r) throw new Error(`Kh\xF4ng t\xECm th\u1EA5y workspace ch\u1EE9a ${path}`);
    const srv = await serverFor(lang, r, path);
    if (!srv.open.has(norm(path))) {
      try {
        srv.client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[lang](path), version: 0, text: readFileSync2(path, "utf8") } });
        srv.open.set(norm(path), 0);
      } catch {
      }
    }
    return srv;
  }
  orca.panels.handle("lsp.attach", async (input) => {
    const lang = input.language;
    const focused = await focusedRoot().catch(() => null);
    const { workspaces } = await orca.host.call("workspace.list", {});
    const known = [...servers.values()].map((s) => s.root);
    const roots = [...known, focused, ...workspaces.filter(isLocal).map((w) => resolve3(w.path))].filter((r, i, a) => !!r && a.findIndex((x) => x && norm(x) === norm(r)) === i);
    const h = sha(input.text);
    let wsRoot = null;
    let hits = [];
    const deadline = Date.now() + 6e4;
    for (const r of roots) {
      if (Date.now() > deadline) break;
      hits = (indexFor(r).get(h) ?? []).filter((p) => langOfPath(p) === lang);
      if (hits.length) {
        wsRoot = r;
        break;
      }
    }
    if (!wsRoot) {
      for (const r of roots) {
        if (Date.now() > deadline) break;
        hashIndex.delete(r);
        hits = (indexFor(r).get(h) ?? []).filter((p) => langOfPath(p) === lang);
        if (hits.length) {
          wsRoot = r;
          break;
        }
      }
    }
    if (!wsRoot) return { ok: false, path: null, candidates: 0, workspace: focused, server: null, message: "Kh\xF4ng t\xECm th\u1EA5y file n\xE0y trong workspace n\xE0o c\u1EE7a Orca." };
    let ws = wsRoot;
    for (const w of workspaces) if (isLocal(w) && norm(hits[0]).startsWith(norm(resolve3(w.path)) + sep) && resolve3(w.path).length > ws.length) ws = resolve3(w.path);
    const root = projectRootFor2(lang, hits[0], ws);
    try {
      const srv = await serverFor(lang, root, hits[0]);
      for (const p of hits) attachedRoots.set(`${lang}|${norm(p)}`, root);
      return { ok: true, path: hits[0], candidates: hits.length, workspace: root, server: `${SERVER_LABEL[lang]}${srv.detail ? ` (${srv.detail})` : ""}` };
    } catch (e) {
      return { ok: false, path: hits[0], candidates: hits.length, workspace: root, server: null, message: e instanceof Error ? e.message : String(e) };
    }
  });
  const sync = (srv, path, text, version) => {
    if (srv.open.has(norm(path))) srv.client.notify("textDocument/didChange", { textDocument: { uri: uriOf(path), version }, contentChanges: [{ text }] });
    else srv.client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[srv.lang](path), version, text } });
    srv.open.set(norm(path), version);
  };
  orca.panels.handle("lsp.open", async ({ path, text, version }) => {
    sync(await serverForPath(path), path, text, version);
    return { ok: true };
  });
  orca.panels.handle("lsp.change", async ({ path, text, version }) => {
    sync(await serverForPath(path), path, text, version);
    return { ok: true };
  });
  orca.panels.handle("lsp.close", async ({ path }) => {
    const lang = langOfPath(path);
    const srv = lang ? serverOf(lang, path) : null;
    if (srv?.open.delete(norm(path))) srv.client.notify("textDocument/didClose", { textDocument: { uri: uriOf(path) } });
    if (srv && srv.open.size === 0) setTimeout(() => {
      if (srv.open.size === 0 && servers.get(key(srv.lang, srv.root)) === srv) stopServer(srv);
    }, 6e4);
    return { ok: true };
  });
  function stopServer(srv) {
    servers.delete(key(srv.lang, srv.root));
    hashIndex.delete(srv.root);
    void srv.client.request("shutdown", null, 3e3).catch(() => {
    }).finally(() => {
      srv.client.notify("exit", null);
      setTimeout(() => srv.client.kill(), 500);
    });
  }
  orca.events.on("workspace.removed", ({ path }) => {
    for (const s of [...servers.values()]) if (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep)) stopServer(s);
  });
  const LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i;
  const isLibPath = (p, root) => !norm(p).startsWith(norm(root) + sep) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length));
  orca.panels.handle("lsp.hover", async ({ path, position }) => {
    const srv = await serverForPath(path);
    const r = await srv.client.request("textDocument/hover", { textDocument: { uri: uriOf(path) }, position });
    if (!r) return { markdown: null, range: null };
    const c = r.contents;
    const md = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => typeof x === "string" ? x : "```" + (x.language ?? "") + "\n" + x.value + "\n```").join("\n\n") : c?.kind === "plaintext" ? "```\n" + c.value + "\n```" : c?.value ?? null;
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }));
  });
  orca.panels.handle("lsp.definition", async ({ path, position }) => {
    const srv = await serverForPath(path);
    let r = await srv.client.request("textDocument/definition", { textDocument: { uri: uriOf(path) }, position });
    if ((!r || Array.isArray(r) && !r.length) && srv.lang === "cpp") r = await srv.client.request("textDocument/declaration", { textDocument: { uri: uriOf(path) }, position }).catch(() => null);
    const list = r ? Array.isArray(r) ? r : [r] : [];
    const locations = [];
    for (const l of list) {
      const u = l.uri ?? l.targetUri;
      let p;
      try {
        p = fileURLToPath(u);
      } catch {
        continue;
      }
      locations.push({ path: p, range: l.targetSelectionRange ?? l.range ?? l.targetRange, inWorkspace: !isLibPath(p, srv.root) });
    }
    return JSON.parse(JSON.stringify({ locations }));
  });
  orca.panels.handle("lsp.completion", async ({ path, position, trigger }) => {
    const srv = await serverForPath(path);
    const context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 };
    const r = await srv.client.request("textDocument/completion", { textDocument: { uri: uriOf(path) }, position, context });
    const items = (Array.isArray(r) ? r : r?.items ?? []).slice(0, 300).map((it) => {
      const doc = typeof it.documentation === "string" ? it.documentation : it.documentation?.value;
      const out = { label: String(it.label).trim(), kind: it.kind ?? 1 };
      if (it.detail) out.detail = String(it.detail);
      if (doc) out.documentation = String(doc).slice(0, 4e3);
      const insert = it.textEdit?.newText ?? it.insertText;
      if (insert) out.insertText = String(insert);
      if (it.textEdit?.range ?? it.textEdit?.replace) out.range = it.textEdit.range ?? it.textEdit.replace;
      if (it.sortText) out.sortText = String(it.sortText);
      if (it.filterText) out.filterText = String(it.filterText);
      return out;
    });
    return JSON.parse(JSON.stringify({ items, incomplete: Array.isArray(r) ? false : !!r?.isIncomplete }));
  });
  orca.panels.handle("lsp.diagnostics", async ({ path }) => {
    const lang = langOfPath(path);
    const srv = lang ? serverOf(lang, path) : null;
    return srv?.diagnostics.get(norm(path)) ?? { version: -1, items: [] };
  });
  orca.panels.handle("lsp.serverInfo", async ({ path }) => {
    const srv = await serverForPath(path);
    return { lang: srv.lang, server: SERVER_LABEL[srv.lang], root: srv.root, detail: srv.detail };
  });
  orca.panels.handle("lsp.restart", async ({ path }) => {
    const lang = langOfPath(path);
    const srv = lang ? serverOf(lang, path) : null;
    if (srv) stopServer(srv);
    const fresh = await serverForPath(path);
    return { detail: fresh.detail };
  });
  orca.panels.handle("lsp.interpreters", async ({ path }) => {
    const srv = await serverForPath(path);
    if (srv.lang !== "python") return { root: srv.root, current: null, list: [] };
    const list = await interpretersFor(srv.root, path);
    return JSON.parse(JSON.stringify({ root: srv.root, current: srv.interpreter, list }));
  });
  orca.panels.handle("lsp.setInterpreter", async ({ path, interpreter }) => {
    const srv = await serverForPath(path);
    if (srv.lang !== "python") return { current: null };
    const saved = await savedInterpreters();
    if (interpreter) saved[norm(srv.root)] = interpreter;
    else delete saved[norm(srv.root)];
    await orca.storage.set(SAVED_KEY, saved);
    srv.interpreter = (await interpretersFor(srv.root, path))[0] ?? null;
    srv.client.notify("workspace/didChangeConfiguration", { settings: {} });
    orca.log(`interpreter for ${srv.root} -> ${srv.interpreter?.path ?? "none"} [${srv.interpreter?.source ?? "-"}]`);
    return JSON.parse(JSON.stringify({ current: srv.interpreter }));
  });
  orca.panels.handle("lsp.semanticTokens", async ({ path }) => {
    const srv = await serverForPath(path);
    if (!srv.legend) return { legend: null, data: [] };
    const r = await srv.client.request("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(path) } }, 2e4).catch(() => null);
    return { legend: srv.legend, data: Array.isArray(r?.data) ? r.data : [] };
  });
  orca.panels.handle("lsp.peek", async ({ path }) => {
    if (!langOfPath(path) && !/(^|[\\/])[A-Z][A-Za-z0-9]*$/.test(path)) return { text: "", lang: null };
    const lang = langOfPath(path) ?? "cpp";
    try {
      return { text: readFileSync2(path, "utf8").slice(0, 6e5), lang };
    } catch {
      return { text: "", lang };
    }
  });
  orca.panels.handle("lsp.reveal", async ({ path, line }) => {
    const { workspaces } = await orca.host.call("workspace.list", {});
    const p = norm(resolve3(path));
    let ws = null;
    for (const w of workspaces) if (isLocal(w) && p.startsWith(norm(resolve3(w.path)) + sep) && (!ws || w.path.length > ws.path.length)) ws = w;
    if (!ws) return { opened: false, reason: "outside" };
    const rel = resolve3(path).slice(resolve3(ws.path).length + 1).split(sep).join("/");
    await orca.host.call("editor.open", { workspaceId: ws.id, path: rel });
    return { opened: true, line, rel };
  });
}
function deactivate() {
}
export {
  deactivate,
  activate as default
};
