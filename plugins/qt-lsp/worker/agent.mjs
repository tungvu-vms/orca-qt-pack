// src/agent.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
import { createInterface } from "node:readline";

// src/core.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync4, readdirSync as readdirSync3, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve3, sep as sep2 } from "node:path";
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

// src/pyright-install.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
var PYRIGHT_VERSION = "1.40.2";
var running = /* @__PURE__ */ new Map();
function installPyright(prefix, node, log2) {
  const entry = join(prefix, "node_modules", "basedpyright", "langserver.index.js");
  if (existsSync(entry)) return Promise.resolve(entry);
  const busy = running.get(prefix);
  if (busy) return busy;
  const job = new Promise((resolve4) => {
    mkdirSync(prefix, { recursive: true });
    const binDir = dirname(node);
    const cli = [join(binDir, "node_modules", "npm", "bin", "npm-cli.js"), join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p2) => existsSync(p2));
    const args = ["install", "--prefix", prefix, `basedpyright@${PYRIGHT_VERSION}`, "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: binDir + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "") };
    log2(`installing basedpyright ${PYRIGHT_VERSION} into ${prefix} ...`);
    const p = cli ? spawn2(node, [cli, ...args], { env, windowsHide: true }) : spawn2(process.platform === "win32" ? "npm.cmd" : "npm", args, { env, windowsHide: true });
    let err = "";
    p.stderr?.on("data", (d) => {
      err = (err + d).slice(-1500);
    });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
      }
    }, 3e5);
    p.on("error", (e) => {
      err += e.message;
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      running.delete(prefix);
      if (code === 0 && existsSync(entry)) {
        log2("basedpyright installed");
        resolve4(entry);
      } else {
        log2(`basedpyright install failed (${code}): ${err.trim().slice(-400)}`);
        resolve4(null);
      }
    });
  });
  running.set(prefix, job);
  return job;
}

// src/interpreters.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname as dirname2, isAbsolute, join as join2, resolve, sep } from "node:path";
var WIN = process.platform === "win32";
var lower = (p) => WIN ? p.toLowerCase() : p;
function envExe(envDir) {
  const c = WIN ? [join2(envDir, "Scripts", "python.exe"), join2(envDir, "bin", "python.exe"), join2(envDir, "python.exe")] : [join2(envDir, "bin", "python"), join2(envDir, "bin", "python3")];
  return c.find((f) => existsSync2(f)) ?? null;
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
    const cfg = readFileSync(join2(envDir, "pyvenv.cfg"), "utf8");
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
var isEnvDir = (dir) => existsSync2(join2(dir, "pyvenv.cfg")) || existsSync2(join2(dir, "conda-meta"));
var envDirOf = (exe2) => isEnvDir(dirname2(dirname2(exe2))) ? dirname2(dirname2(exe2)) : isEnvDir(dirname2(exe2)) ? dirname2(exe2) : null;
function projectEnvs(root) {
  const found = /* @__PURE__ */ new Set();
  for (const n of [".venv", ".conda", ".virtualenv", "venv"]) if (isEnvDir(join2(root, n))) found.add(join2(root, n));
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
  }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const full = join2(root, n);
    try {
      if (statSync(full).isDirectory() && isEnvDir(full)) found.add(full);
    } catch {
    }
  }
  return [...found];
}
function projectRootFor(file, limit) {
  let dir = dirname2(resolve(file));
  const stop = lower(resolve(limit));
  while (lower(dir).startsWith(stop)) {
    if (PROJECT_MARKERS.some((m) => existsSync2(join2(dir, m))) || projectEnvs(dir).length) return dir;
    if (lower(dir) === stop) break;
    const up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(limit);
}
function vscodeInterpreter(root) {
  for (let dir = root, i = 0; i < 6; i++) {
    const s = readJsonc(join2(dir, ".vscode", "settings.json"));
    const raw = s?.["python.defaultInterpreterPath"] ?? s?.["python.pythonPath"];
    if (raw && raw !== "python") {
      const p = raw.replace(/\$\{workspaceFolder\}/g, dir).replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] ?? "");
      const abs = isAbsolute(p) ? p : resolve(dir, p);
      if (existsSync2(abs) && statSync(abs).isFile()) {
        if (envDirOf(abs)) return abs;
      } else {
        const exe2 = isEnvDir(abs) ? envExe(abs) : null;
        if (exe2) return exe2;
      }
    }
    const up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
function pyrightConfigInterpreter(root) {
  const cfg = readJsonc(join2(root, "pyrightconfig.json"));
  let venvPath = cfg?.venvPath;
  let venv = cfg?.venv;
  if (!venv) {
    try {
      const toml = readFileSync(join2(root, "pyproject.toml"), "utf8");
      const sec = /\[tool\.(?:based)?pyright\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
      venvPath = /venvPath\s*=\s*"([^"]+)"/.exec(sec)?.[1] ?? venvPath;
      venv = /^\s*venv\s*=\s*"([^"]+)"/m.exec(sec)?.[1];
    } catch {
    }
  }
  if (!venv) return null;
  const dir = resolve(root, venvPath ?? ".", venv);
  return isEnvDir(dir) ? envExe(dir) : null;
}
function globalCandidates() {
  const out2 = [];
  if (WIN) {
    try {
      const txt = execFileSync("py", ["-0p"], { encoding: "utf8", timeout: 4e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of txt.split(/\r?\n/)) {
        const m = /([A-Za-z]:\\.*python\.exe)\s*$/i.exec(line.trim());
        if (m) out2.push(m[1]);
      }
    } catch {
    }
    const base = join2(process.env.LOCALAPPDATA ?? join2(process.env.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Python");
    try {
      for (const d of readdirSync(base)) out2.push(join2(base, d, "python.exe"));
    } catch {
    }
  }
  const names = WIN ? ["python.exe"] : ["python3", "python"];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN ? ";" : ":")) {
    if (!dir || /WindowsApps/i.test(dir)) continue;
    for (const n of names) out2.push(join2(dir, n));
  }
  if (!WIN) out2.push("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3");
  const seen = /* @__PURE__ */ new Set();
  return out2.filter((p) => {
    const k = lower(p);
    if (seen.has(k) || !existsSync2(p)) return false;
    seen.add(k);
    return true;
  });
}
function discoverInterpreters(file, root, opts = {}) {
  const useProject = opts.projectEnvs !== false;
  const project = projectRootFor(file, root);
  const list = [];
  const seen = /* @__PURE__ */ new Set();
  const make = (path, source, reason) => {
    const key2 = lower(resolve(path));
    if (seen.has(key2) || !existsSync2(path)) return null;
    seen.add(key2);
    const envDir = dirname2(dirname2(path));
    const isVenv = isEnvDir(envDir) || isEnvDir(dirname2(path));
    const dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname2(path)) ? dirname2(path) : null;
    const inProject = lower(resolve(path)).startsWith(lower(resolve(root)) + sep);
    const version = dir && venvVersion(dir) || (inProject ? null : runVersion(path));
    const name = dir ? lower(dir).startsWith(lower(project) + (WIN ? "\\" : "/")) ? dir.slice(project.length + 1).replace(/\\/g, "/") : basename(dir) : `Python ${version ?? ""}`.trim();
    return { path: resolve(path), label: isVenv ? `${name}${version ? ` (${version})` : ""}` : `${name} (global)`, version, source, envDir: dir, reason };
  };
  const add = (path, source, reason) => {
    if (!path) return;
    const it = make(path, source, reason);
    if (it) list.push(it);
  };
  add(opts.saved, "saved", "you selected it for this project");
  add(opts.setting, "setting", 'plugin setting "Python interpreter"');
  if (useProject) add(vscodeInterpreter(project), "vscode", "python.defaultInterpreterPath in .vscode/settings.json");
  if (useProject) add(pyrightConfigInterpreter(project), "pyright", "venvPath/venv in pyrightconfig/pyproject");
  const levels = [];
  for (let dir = project; lower(dir).startsWith(lower(resolve(root))); ) {
    levels.push(dir);
    if (lower(dir) === lower(resolve(root))) break;
    const up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const [i, dir] of useProject ? levels.entries() : []) {
    const envs = projectEnvs(dir).map((d) => ({ d, exe: envExe(d) })).map((x) => ({ ...x, version: venvVersion(x.d) })).sort((a, b) => Number(!a.exe) - Number(!b.exe) || cmpVersionDesc(a.version, b.version) || basename(a.d).localeCompare(basename(b.d)) || a.d.localeCompare(b.d));
    for (const e of envs) if (e.exe) add(e.exe, "venv", i === 0 ? envs.length > 1 ? `project venv (${envs.length} venvs: highest Python version chosen)` : "project venv" : "parent folder venv");
  }
  const active = process.env.VIRTUAL_ENV;
  if (useProject && active && lower(resolve(active)).startsWith(lower(project))) add(envExe(active), "env", "active VIRTUAL_ENV");
  const globals = globalCandidates().map((p) => ({ p, v: runVersion(p) })).filter((x) => x.v).sort((a, b) => cmpVersionDesc(a.v, b.v));
  for (const g of globals) add(g.p, "global", "no venv: using the highest installed Python");
  return list;
}

// src/servers.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { dirname as dirname3, join as join3, resolve as resolve2 } from "node:path";
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
  const out2 = [];
  if (extra) out2.push(extra);
  const roots = WIN2 ? ["C:\\Qt", join3(home(), "Qt")] : [join3(home(), "Qt"), "/opt/Qt", "/usr/local/Qt"];
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
        kits = readdirSync2(join3(root, v));
      } catch {
        continue;
      }
      for (const k of kits) if (existsSync3(join3(root, v, k, "bin"))) out2.push(join3(root, v, k, "bin"));
    }
  }
  return out2;
}
function firstExisting(cands) {
  for (const c of cands) if (c && existsSync3(c)) return c;
  return null;
}
function findQmlls(configured, qtBin) {
  if (configured && existsSync3(configured)) return configured;
  return firstExisting([...qtBinDirs(qtBin).map((d) => join3(d, exe("qmlls"))), ...pathDirs().map((d) => join3(d, exe("qmlls")))]);
}
function findClangd(configured) {
  if (configured && existsSync3(configured)) return configured;
  const c = [];
  if (WIN2) {
    for (const root of ["C:\\Qt", join3(home(), "Qt")]) c.push(join3(root, "Tools", "QtCreator", "bin", "clang", "bin", "clangd.exe"));
    c.push("C:\\Program Files\\LLVM\\bin\\clangd.exe");
  } else {
    c.push("/Applications/Qt Creator.app/Contents/Resources/libexec/clang/bin/clangd", join3(home(), "Qt", "Tools", "QtCreator", "libexec", "qtcreator", "clang", "bin", "clangd"), "/usr/bin/clangd", "/usr/local/bin/clangd", "/opt/homebrew/opt/llvm/bin/clangd");
  }
  c.push(...pathDirs().map((d) => join3(d, exe("clangd"))));
  try {
    const vsc = join3(home(), ".vscode", "extensions");
    for (const d of readdirSync2(vsc).filter((n) => n.startsWith("llvm-vs-code-extensions.vscode-clangd"))) {
      const inst = join3(vsc, d, "install");
      for (const v of existsSync3(inst) ? readdirSync2(inst) : []) c.push(join3(inst, v, `clangd_${v}`, "bin", exe("clangd")));
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
        const f = join3(dir, "compile_commands.json");
        if (existsSync3(f)) hits.push({ dir, mtime: statSync2(f).mtimeMs });
      } else if (existsSync3(join3(dir, "CMakeCache.txt")) || existsSync3(join3(dir, "qmldir"))) {
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
    const d = join3(root, n);
    try {
      if (!statSync2(d).isDirectory()) continue;
    } catch {
      continue;
    }
    check(d);
    try {
      for (const s of readdirSync2(d)) {
        const sd = join3(d, s);
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
  // QML/C++: CMake/qmake project (deepest CMakeLists.txt with project()), .qmlls.ini, compile_commands, .git
  qml: [".qmlls.ini", "CMakeLists.txt", ".git"],
  cpp: ["compile_commands.json", ".clangd", "compile_flags.txt", "CMakeLists.txt", ".git"]
};
function projectRootFor2(lang, file, limit) {
  const stop = lower2(resolve2(limit));
  const chain = [];
  for (let dir = dirname3(resolve2(file)); lower2(dir).startsWith(stop); ) {
    chain.push(dir);
    if (lower2(dir) === stop) break;
    const up = dirname3(dir);
    if (up === dir) break;
    dir = up;
  }
  if (lang === "python") {
    const hasVenv = (d) => {
      try {
        return readdirSync2(d).some((n) => existsSync3(join3(d, n, "pyvenv.cfg")));
      } catch {
        return false;
      }
    };
    for (const d of chain) if (PROJECT_MARKERS2.python.some((m) => existsSync3(join3(d, m))) || hasVenv(d)) return d;
    return resolve2(limit);
  }
  const strong = lang === "qml" ? [".qmlls.ini"] : ["compile_commands.json", ".clangd", "compile_flags.txt"];
  for (const d of chain) if (strong.some((m) => existsSync3(join3(d, m)))) return d;
  let top = null;
  for (const d of chain) {
    if (existsSync3(join3(d, "CMakeLists.txt")) || existsSync3(join3(d, `${d.split(/[\\/]/).pop()}.pro`))) top = d;
    else if (top) break;
  }
  if (top) return top;
  for (const d of chain) if (existsSync3(join3(d, ".git"))) return d;
  return resolve2(limit);
}

// src/core.ts
var SKIP2 = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "dist",
  ".orca",
  ".mypy_cache",
  ".pytest_cache",
  "site-packages",
  ".cache",
  ".qtc_clangd",
  // workspace is the home folder (e.g. /Users/<name>): skip large system/media folders
  "Library",
  "Applications",
  "AppData",
  "Movies",
  "Music",
  "Pictures",
  "Downloads",
  "$Recycle.Bin"
]);
var sha = (s) => createHash("sha1").update(s.replace(/\r\n/g, "\n")).digest("hex");
var WIN3 = process.platform === "win32";
var pluginDir = () => process.env.QT_LSP_DIR || resolve3(dirname4(fileURLToPath(import.meta.url)), "..");
var norm = (p) => WIN3 ? p.toLowerCase() : p;
var key = (lang, root) => `${lang}|${norm(root)}`;
var langOfPath = (p) => EXTS_OF_LANG.python.test(p) ? "python" : EXTS_OF_LANG.qml.test(p) ? "qml" : EXTS_OF_LANG.cpp.test(p) ? "cpp" : null;
function createCore(host) {
  const handlers = {};
  const handle = (name, fn) => {
    handlers[name] = fn;
  };
  const servers = /* @__PURE__ */ new Map();
  const hashIndex = /* @__PURE__ */ new Map();
  async function setting(k, fallback) {
    try {
      const v = await host.setting(k, null);
      return v === void 0 || v === null || v === "" ? fallback : v;
    } catch {
      return fallback;
    }
  }
  const MAX_FILES = 2e5;
  const skipDir = (n) => SKIP2.has(n) || n.startsWith(".") || /^(build|out|cmake-build-)/i.test(n);
  function scan(root, match) {
    const cached = hashIndex.get(root);
    if (cached && Date.now() - cached.at < 3e5) return null;
    const bySize = /* @__PURE__ */ new Map();
    let count = 0;
    const stopAt = Date.now() + 3e4;
    let level = [root];
    for (let depth = 0; level.length && depth <= 14; depth++) {
      const next = [];
      for (const dir of level) {
        if (count > MAX_FILES || Date.now() > stopAt) return null;
        let ents = [];
        try {
          ents = readdirSync3(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of ents) {
          const n = e.name;
          if (e.isDirectory()) {
            if (!skipDir(n)) next.push(join4(dir, n));
            continue;
          }
          if (!e.isFile() || !langOfPath(n)) continue;
          const full = join4(dir, n);
          let size;
          try {
            size = statSync3(full).size;
          } catch {
            continue;
          }
          count++;
          const k = `size:${size}`;
          const list = bySize.get(k);
          if (list) list.push(full);
          else bySize.set(k, [full]);
          if (match?.(full, size)) return full;
        }
      }
      level = next;
    }
    hashIndex.set(root, { at: Date.now(), byHash: bySize });
    return null;
  }
  function indexFor(root) {
    scan(root);
    return hashIndex.get(root)?.byHash ?? /* @__PURE__ */ new Map();
  }
  const hashCache = /* @__PURE__ */ new Map();
  function fileHash(p) {
    try {
      const st = statSync3(p);
      const c = hashCache.get(p);
      if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.h;
      const h = sha(readFileSync2(p, "utf8").replace(/^﻿/, ""));
      hashCache.set(p, { mtime: st.mtimeMs, size: st.size, h });
      return h;
    } catch {
      return null;
    }
  }
  const SAVED_KEY = "interpreters";
  async function savedInterpreters() {
    try {
      const v = await host.storageGet(SAVED_KEY);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  async function interpretersFor(root, file) {
    const saved = (await savedInterpreters())[norm(root)];
    const projectEnvs2 = String(await setting("projectEnvironments", "on")).trim().toLowerCase() !== "off";
    return discoverInterpreters(file ?? join4(root, "__init__.py"), root, { saved, setting: await setting("python", ""), projectEnvs: projectEnvs2 });
  }
  function findNode() {
    const exe2 = WIN3 ? "node.exe" : "node";
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN3 ? ";" : ":")) if (dir && existsSync4(join4(dir, exe2))) return join4(dir, exe2);
    for (const c of WIN3 ? ["C:\\Program Files\\nodejs\\node.exe"] : ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]) if (existsSync4(c)) return c;
    return process.execPath;
  }
  function pyrightPrefix() {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir2();
    return join4(process.env.LOCALAPPDATA ?? (WIN3 ? join4(h, "AppData", "Local") : join4(h, ".local", "share")), "orca-qt-lsp");
  }
  function pyrightEntry() {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir2();
    const local = process.env.LOCALAPPDATA ?? (WIN3 ? join4(h, "AppData", "Local") : join4(h, ".local", "share"));
    const appData = process.env.APPDATA ?? (WIN3 ? join4(h, "AppData", "Roaming") : void 0);
    const c = [join4(pluginDir(), "server", "pyright", "langserver.index.js"), join4(local, "orca-qt-lsp", "node_modules", "basedpyright", "langserver.index.js")];
    if (appData) c.push(join4(appData, "npm", "node_modules", "basedpyright", "langserver.index.js"), join4(appData, "npm", "node_modules", "pyright", "langserver.index.js"));
    for (const p of ["/usr/local", "/opt/homebrew", join4(h, ".npm-global")]) c.push(join4(p, "lib", "node_modules", "basedpyright", "langserver.index.js"), join4(p, "lib", "node_modules", "pyright", "langserver.index.js"));
    return c.find((p) => existsSync4(p)) ?? null;
  }
  async function commandFor(lang, root) {
    if (lang === "python") {
      const entry = await setting("pyrightPath", "") || pyrightEntry() || await (host.installPyright ? host.installPyright() : installPyright(pyrightPrefix(), findNode(), host.log));
      if (!entry) throw new Error(`basedpyright/Pyright not found on this ${process.platform} machine. Install it (needs Node.js 18+ with npm): npm i --prefix ${WIN3 ? '"%LOCALAPPDATA%\\orca-qt-lsp"' : "~/.local/share/orca-qt-lsp"} basedpyright@1.40.2`);
      const node = await setting("nodePath", "") || findNode();
      return { cmd: node, args: [entry, "--stdio"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detail: entry.includes("basedpyright") ? "basedpyright" : "pyright" };
    }
    if (lang === "qml") {
      const qmlls = findQmlls(await setting("qmllsPath", ""), await setting("qtBin", ""));
      if (!qmlls) throw new Error('qmlls (Qt 6.4+) not found. Set "qmlls path" or "Qt bin folder" in the plugin Settings.');
      const args2 = [];
      const builds = findBuildDirs(root, "qml");
      for (const b of builds.slice(0, 1)) args2.push("-b", b);
      const qmlDir = join4(dirname4(dirname4(qmlls)), "qml");
      if (existsSync4(qmlDir)) args2.push("-I", qmlDir);
      return { cmd: qmlls, args: args2, detail: builds[0] ? `build: ${builds[0].slice(root.length + 1) || "."}` : "no build folder yet (run CMake configure so qmlls can see the project modules)" };
    }
    const clangd = findClangd(await setting("clangdPath", ""));
    if (!clangd) throw new Error('clangd not found. Install LLVM or Qt Creator, or set "clangd path" in Settings.');
    const args = ["--background-index", "--clang-tidy=false", "--header-insertion=never", "--completion-style=detailed", "--log=error", "--pch-storage=memory"];
    const cc = findBuildDirs(root, "compile_commands");
    if (cc[0]) args.push(`--compile-commands-dir=${cc[0]}`);
    const drivers = WIN3 ? [
      "C:/Qt/Tools/**/bin/*.exe",
      "C:/Program Files/LLVM/bin/*.exe",
      "C:/Program Files/Microsoft Visual Studio/**/bin/**/cl.exe",
      "C:/Program Files (x86)/Microsoft Visual Studio/**/bin/**/cl.exe",
      "C:/msys64/*/bin/*.exe",
      "C:/mingw*/bin/*.exe"
    ] : [
      "/usr/bin/*",
      "/usr/local/bin/*",
      "/opt/homebrew/bin/*",
      "/opt/homebrew/opt/llvm/bin/*",
      "/Library/Developer/CommandLineTools/usr/bin/*",
      "/Applications/Xcode*.app/Contents/Developer/Toolchains/**/bin/*",
      `${homedir2()}/Qt/Tools/**/bin/*`
    ];
    const extra = String(await setting("compilerGlobs", "")).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
    args.push(`--query-driver=${[...drivers, ...extra].join(",")}`);
    return { cmd: clangd, args, detail: cc[0] ? `compile_commands: ${cc[0].slice(root.length + 1) || "."}` : "no compile_commands.json yet (run CMake configure with CMAKE_EXPORT_COMPILE_COMMANDS=ON)" };
  }
  async function serverFor(lang, root, file) {
    const existing = servers.get(key(lang, root));
    if (existing && !existing.client.exited) return existing;
    const { cmd, args, env, detail } = await commandFor(lang, root);
    host.log(`spawn ${lang}: ${cmd} ${args.join(" ")} (root ${root})`);
    const client = new LspClient(cmd, args, lang === "python" ? pluginDir() : root, env);
    client.log = (l) => host.log(`[${lang}] ${l}`);
    const srv = { lang, root, client, ready: Promise.resolve(), open: /* @__PURE__ */ new Map(), diagnostics: /* @__PURE__ */ new Map(), legend: null, interpreter: null, detail };
    client.onExit = (code) => {
      host.log(`${lang} server exited (${code}) for ${root}`);
      if (servers.get(key(lang, root)) === srv) servers.delete(key(lang, root));
    };
    const typeMode = String(await setting("typeCheckingMode", "off")).trim() || "off";
    if (lang === "python") {
      srv.interpreter = (await interpretersFor(root, file))[0] ?? null;
      host.log(`interpreter for ${root}: ${srv.interpreter ? `${srv.interpreter.path} [${srv.interpreter.source}]` : "none"}`);
    }
    client.onRequest("workspace/configuration", (params) => params.items.map((it) => {
      if (lang !== "python") return {};
      const py = srv.interpreter?.path;
      if (it.section === "python") return py ? { pythonPath: py, defaultInterpreterPath: py } : {};
      if (it.section === "python.analysis" || it.section === "basedpyright.analysis") {
        return { typeCheckingMode: typeMode, diagnosticMode: "openFilesOnly", autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true };
      }
      return {};
    }));
    client.onRequest("window/workDoneProgress/create", () => null);
    client.onRequest("client/registerCapability", () => null);
    client.onRequest("window/showMessageRequest", () => null);
    client.onRequest("workspace/semanticTokens/refresh", () => {
      host.post("lsp.refresh", { lang, root });
      return null;
    });
    client.onNotification("window/showMessage", (p) => host.log(`[${lang}] ${p?.message ?? ""}`));
    client.onNotification("textDocument/publishDiagnostics", (p) => {
      let path;
      try {
        path = fileURLToPath(p.uri);
      } catch {
        return;
      }
      const out2 = {
        version: p.version ?? -1,
        items: p.diagnostics.map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code === "object" ? d.code?.value : d.code }))
      };
      srv.diagnostics.set(norm(path), out2);
      host.post("lsp.diagnostics", { path, version: out2.version, items: out2.items.slice(0, 300).map((d) => ({ ...d, message: String(d.message).slice(0, 500) })) });
    });
    const rootUri = pathToFileURL(root).href;
    srv.ready = client.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: root.split(sep2).pop() }],
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
    host.log(`${lang} ready for ${root} (${detail})`);
    return srv;
  }
  function serverOf(lang, path) {
    let best = null;
    for (const s of servers.values()) {
      if (s.lang !== lang) continue;
      if (norm(path).startsWith(norm(s.root) + sep2) && (!best || s.root.length > best.root.length)) best = s;
    }
    return best;
  }
  const attachedRoots = /* @__PURE__ */ new Map();
  const uriOf = (path) => pathToFileURL(path).href;
  async function rootForFile(lang, path) {
    const hit = attachedRoots.get(`${lang}|${norm(path)}`);
    if (hit) return hit;
    const { roots } = await host.roots();
    const p = norm(resolve3(path));
    let best = null;
    for (const w of [...roots, ...[...servers.values()].map((s) => s.root)]) {
      const r = resolve3(w);
      if (p.startsWith(norm(r) + sep2) && (!best || r.length > best.length)) best = r;
    }
    if (!best) return null;
    const root = projectRootFor2(lang, path, best);
    attachedRoots.set(`${lang}|${norm(path)}`, root);
    return root;
  }
  async function serverForPath(path) {
    const lang = langOfPath(path);
    if (!lang) throw new Error(`Unsupported file type: ${path}`);
    const r = await rootForFile(lang, path);
    if (!r) throw new Error(`No workspace contains ${path}`);
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
  handle("lsp.attach", async (input) => {
    const lang = input.language;
    const listed = await host.roots(input.hints).catch(() => ({ focused: null, roots: [] }));
    const focused = listed.focused;
    const known = [...servers.values()].map((s) => s.root);
    const roots = [focused, ...known, ...listed.roots.map((w) => resolve3(w))].filter((r, i, a) => !!r && a.findIndex((x) => x && norm(x) === norm(r)) === i);
    const h = input.hash ?? sha(input.text ?? "");
    const sizes = [input.size, input.sizeCrlf].filter((s) => typeof s === "number").flatMap((s) => [s, s + 3]);
    const sizeSet = new Set(sizes);
    const ok = (p) => langOfPath(p) === lang && fileHash(p) === h;
    const find = (r) => {
      const cached = hashIndex.get(r);
      if (!cached || Date.now() - cached.at >= 3e5) {
        const hit = scan(r, (full, size) => (sizeSet.size ? sizeSet.has(size) : true) && ok(full));
        if (hit) return [hit];
      }
      const idx = hashIndex.get(r)?.byHash;
      if (!idx) return [];
      const cands = sizes.length ? sizes.flatMap((s) => idx.get(`size:${s}`) ?? []) : [...idx.values()].flat();
      return [...new Set(cands)].filter(ok);
    };
    let wsRoot = null;
    let hits = [];
    const deadline = Date.now() + 6e4;
    for (const r of roots) {
      if (Date.now() > deadline) break;
      hits = find(r);
      if (hits.length) {
        wsRoot = r;
        break;
      }
    }
    if (!wsRoot) {
      for (const r of roots) {
        if (Date.now() > deadline) break;
        hashIndex.delete(r);
        hits = find(r);
        if (hits.length) {
          wsRoot = r;
          break;
        }
      }
    }
    if (!wsRoot) {
      const scanned = roots.map((r) => `${r} (${[...hashIndex.get(r)?.byHash.values() ?? []].reduce((n, l) => n + l.length, 0)} file)`);
      host.log(`attach miss: lang=${lang} size=${input.size} roots=${scanned.join(" | ")}`);
      return { ok: false, path: null, candidates: 0, workspace: focused, server: null, message: `File not found (${roots.length} workspaces scanned).` };
    }
    let ws = wsRoot;
    for (const w of listed.roots) if (norm(hits[0]).startsWith(norm(resolve3(w)) + sep2) && resolve3(w).length > ws.length) ws = resolve3(w);
    const root = projectRootFor2(lang, hits[0], ws);
    try {
      const srv = await serverFor(lang, root, hits[0]);
      for (const p of hits) attachedRoots.set(`${lang}|${norm(p)}`, root);
      return { ok: true, path: hits[0], candidates: hits.length, workspace: root, server: `${SERVER_LABEL[lang]}${srv.detail ? ` (${srv.detail})` : ""}` };
    } catch (e) {
      return { ok: false, path: hits[0], candidates: hits.length, workspace: root, server: null, message: e instanceof Error ? e.message : String(e) };
    }
  });
  const docs = /* @__PURE__ */ new Map();
  const sendFull = (srv, path, text, version) => {
    if (srv.open.has(norm(path))) srv.client.notify("textDocument/didChange", { textDocument: { uri: uriOf(path), version }, contentChanges: [{ text }] });
    else srv.client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[srv.lang](path), version, text } });
    srv.open.set(norm(path), version);
    docs.set(norm(path), text);
  };
  handle("lsp.open", async ({ path, text, version }) => {
    const srv = await serverForPath(path);
    sendFull(srv, path, text ?? readFileSync2(path, "utf8"), version);
    return { ok: true };
  });
  handle("lsp.change", async ({ path, text, version, edits, expectLength }) => {
    const srv = await serverForPath(path);
    let next = text;
    if (next === void 0 && edits) {
      const base = docs.get(norm(path));
      if (base === void 0) return { ok: false, resync: true };
      let cur = base;
      for (const e of [...edits].sort((a, b) => b.offset - a.offset)) cur = cur.slice(0, e.offset) + e.text + cur.slice(e.offset + e.length);
      next = cur;
    }
    if (next === void 0) return { ok: false, resync: true };
    if (edits && typeof expectLength === "number" && next.length !== expectLength) return { ok: false, resync: true };
    sendFull(srv, path, next, version);
    return { ok: true };
  });
  const uploads = /* @__PURE__ */ new Map();
  handle("lsp.upload", async ({ path, version, part, index, total }) => {
    const k = norm(path);
    if (index === 0) uploads.set(k, []);
    const parts = uploads.get(k);
    if (!parts) return { ok: false };
    parts[index] = part;
    if (index < total - 1) return { ok: true, pending: true };
    uploads.delete(k);
    sendFull(await serverForPath(path), path, parts.join(""), version);
    return { ok: true };
  });
  handle("lsp.close", async ({ path }) => {
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
  const workspaceRemoved = (path) => {
    for (const s of [...servers.values()]) if (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep2)) stopServer(s);
  };
  const LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i;
  const isLibPath = (p, root) => !norm(p).startsWith(norm(root) + sep2) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length));
  handle("lsp.hover", async ({ path, position }) => {
    const srv = await serverForPath(path);
    const r = await srv.client.request("textDocument/hover", { textDocument: { uri: uriOf(path) }, position });
    if (!r) return { markdown: null, range: null };
    const c = r.contents;
    const md = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => typeof x === "string" ? x : "```" + (x.language ?? "") + "\n" + x.value + "\n```").join("\n\n") : c?.kind === "plaintext" ? "```\n" + c.value + "\n```" : c?.value ?? null;
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }));
  });
  const peekable = /* @__PURE__ */ new Set();
  handle("lsp.definition", async ({ path, position }) => {
    const srv = await serverForPath(path);
    let r = await srv.client.request("textDocument/definition", { textDocument: { uri: uriOf(path) }, position });
    if ((!r || Array.isArray(r) && !r.length) && srv.lang === "cpp") r = await srv.client.request("textDocument/declaration", { textDocument: { uri: uriOf(path) }, position }).catch(() => null);
    const list = r ? Array.isArray(r) ? r : [r] : [];
    const wsRoots = [...(await host.roots().catch(() => ({ roots: [] }))).roots, srv.root].map((x) => resolve3(x));
    const locations = [];
    for (const l of list) {
      const u = l.uri ?? l.targetUri;
      let p;
      try {
        p = fileURLToPath(u);
      } catch {
        continue;
      }
      peekable.add(norm(p));
      locations.push({ path: p, range: l.targetSelectionRange ?? l.range ?? l.targetRange, inWorkspace: !isLibPath(p, srv.root), openable: wsRoots.some((r2) => norm(p).startsWith(norm(r2) + sep2)) });
    }
    return JSON.parse(JSON.stringify({ locations }));
  });
  handle("lsp.completion", async ({ path, position, trigger }) => {
    const srv = await serverForPath(path);
    const context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 };
    const r = await srv.client.request("textDocument/completion", { textDocument: { uri: uriOf(path) }, position, context });
    const items = (Array.isArray(r) ? r : r?.items ?? []).slice(0, 300).map((it) => {
      const doc = typeof it.documentation === "string" ? it.documentation : it.documentation?.value;
      const out2 = { label: String(it.label).trim(), kind: it.kind ?? 1 };
      if (it.detail) out2.detail = String(it.detail);
      if (doc) out2.documentation = String(doc).slice(0, 1500);
      const insert = it.textEdit?.newText ?? it.insertText;
      if (insert) out2.insertText = String(insert);
      if (it.textEdit?.range ?? it.textEdit?.replace) out2.range = it.textEdit.range ?? it.textEdit.replace;
      if (it.sortText) out2.sortText = String(it.sortText);
      if (it.filterText) out2.filterText = String(it.filterText);
      return out2;
    });
    return JSON.parse(JSON.stringify({ items, incomplete: Array.isArray(r) ? false : !!r?.isIncomplete }));
  });
  handle("lsp.diagnostics", async ({ path }) => {
    const lang = langOfPath(path);
    const srv = lang ? serverOf(lang, path) : null;
    const d = srv?.diagnostics.get(norm(path));
    return d ? { version: d.version, items: d.items.slice(0, 2e3).map((x) => ({ ...x, message: String(x.message).slice(0, 500) })) } : { version: -1, items: [] };
  });
  handle("lsp.serverInfo", async ({ path }) => {
    const srv = await serverForPath(path);
    return { lang: srv.lang, server: SERVER_LABEL[srv.lang], root: srv.root, detail: srv.detail };
  });
  handle("lsp.restart", async ({ path }) => {
    const lang = langOfPath(path);
    const srv = lang ? serverOf(lang, path) : null;
    if (srv) stopServer(srv);
    const fresh = await serverForPath(path);
    return { detail: fresh.detail };
  });
  handle("lsp.interpreters", async ({ path }) => {
    const srv = await serverForPath(path);
    if (srv.lang !== "python") return { root: srv.root, current: null, list: [] };
    const list = await interpretersFor(srv.root, path);
    return JSON.parse(JSON.stringify({ root: srv.root, current: srv.interpreter, list }));
  });
  handle("lsp.setInterpreter", async ({ path, interpreter }) => {
    const srv = await serverForPath(path);
    if (srv.lang !== "python") return { current: null };
    const saved = await savedInterpreters();
    if (interpreter) saved[norm(srv.root)] = interpreter;
    else delete saved[norm(srv.root)];
    await host.storageSet(SAVED_KEY, saved);
    srv.interpreter = (await interpretersFor(srv.root, path))[0] ?? null;
    srv.client.notify("workspace/didChangeConfiguration", { settings: {} });
    host.log(`interpreter for ${srv.root} -> ${srv.interpreter?.path ?? "none"} [${srv.interpreter?.source ?? "-"}]`);
    return JSON.parse(JSON.stringify({ current: srv.interpreter }));
  });
  handle("lsp.semanticTokens", async ({ path }) => {
    const srv = await serverForPath(path);
    if (!srv.legend) return { legend: null, data: [] };
    const r = await srv.client.request("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(path) } }, 2e4).catch(() => null);
    const data = Array.isArray(r?.data) ? r.data : [];
    return { legend: srv.legend, data: data.length > 15e4 ? data.slice(0, 15e4) : data };
  });
  handle("lsp.peek", async ({ path, line }) => {
    if (!peekable.has(norm(path))) return { text: "", lang: null };
    const lang = langOfPath(path) ?? "cpp";
    const LIMIT = 3e5;
    let text;
    try {
      text = readFileSync2(path, "utf8");
    } catch {
      return { text: "", lang };
    }
    if (text.length <= LIMIT) return { text, lang };
    const lines = text.split("\n");
    const at = Math.max(0, Math.min(lines.length - 1, line ?? 0));
    let from = at, to = at, size = lines[at].length;
    while (size < LIMIT - lines.length && (from > 0 || to < lines.length - 1)) {
      if (to < lines.length - 1) {
        to++;
        size += lines[to].length + 1;
      }
      if (from > 0 && size < LIMIT - lines.length) {
        from--;
        size += lines[from].length + 1;
      }
    }
    return { text: lines.map((l, i) => i >= from && i <= to ? l : "").join("\n"), lang, window: [from, to] };
  });
  handle("lsp.reveal", async ({ path, line }) => host.reveal ? host.reveal(path, line) : { opened: false, reason: "no-host" });
  return { handlers, workspaceRemoved, shutdown: () => {
    for (const s of [...servers.values()]) stopServer(s);
  } };
}

// src/agent.ts
var AGENT_VERSION = "0.5.0";
var HOME = join5(homedir3(), ".orca-qt-lsp");
mkdirSync2(HOME, { recursive: true });
process.env.QT_LSP_DIR ??= HOME;
var out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
var log = (m) => out({ log: m });
var settings = {};
var statePath = join5(HOME, "state.json");
var readState = () => {
  try {
    return JSON.parse(readFileSync3(statePath, "utf8"));
  } catch {
    return {};
  }
};
var orcaRoots = { at: 0, list: [] };
function orcaWorkspaces() {
  if (Date.now() - orcaRoots.at < 6e4) return orcaRoots.list;
  let list = [];
  try {
    const cli = process.platform === "win32" ? join5(process.env.LOCALAPPDATA ?? join5(homedir3(), "AppData", "Local"), "Programs", "orca", "resources", "bin", "orca.exe") : process.platform === "darwin" ? "/Applications/Orca.app/Contents/Resources/bin/orca" : "";
    if (!cli || !existsSync5(cli)) throw new Error("no orca");
    const r = spawnSync(cli, ["worktree", "list", "--json"], { encoding: "utf8", timeout: 15e3, maxBuffer: 64 << 20, windowsHide: true });
    const j = JSON.parse(r.stdout || "{}");
    list = (j.result?.worktrees ?? []).filter((w) => !w.hostId || w.hostId === "local").map((w) => String(w.path));
  } catch {
  }
  orcaRoots = { at: Date.now(), list };
  return list;
}
var usedRoots = new Set(readState().roots ?? []);
function rootsOf(hints) {
  const fromSetting = String(settings.remoteRoots ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  const list = [...hints ?? [], ...usedRoots, ...fromSetting, ...orcaWorkspaces(), homedir3()].filter((r) => r && existsSync5(r));
  return { focused: list[0] ?? null, roots: [...new Set(list)] };
}
var installPyright2 = () => installPyright(HOME, process.execPath, log);
var core = createCore({
  log,
  post: (ev, p) => out({ ev, p }),
  setting: async (k, fallback) => settings[k] ?? fallback,
  storageGet: async (k) => readState()[k],
  storageSet: async (k, v) => {
    const s = readState();
    s[k] = v;
    writeFileSync(statePath, JSON.stringify(s));
  },
  roots: async (hints) => rootsOf(hints),
  installPyright: installPyright2
});
var rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (msg.m === "$hello") {
      settings = msg.p?.settings ?? {};
      out({ id: msg.id, r: { version: AGENT_VERSION, platform: process.platform, node: process.version, home: HOME } });
      return;
    }
    if (msg.m === "$roots") {
      for (const r2 of msg.p?.roots ?? []) usedRoots.add(r2);
      return;
    }
    const h = core.handlers[msg.m];
    if (!h) {
      out({ id: msg.id, e: `unknown method ${msg.m}` });
      return;
    }
    const r = await h(msg.p);
    if (msg.m === "lsp.attach" && r?.ok && r.workspace) {
      usedRoots.add(r.workspace);
      const s = readState();
      s.roots = [...usedRoots].slice(-30);
      writeFileSync(statePath, JSON.stringify(s));
    }
    out({ id: msg.id, r: r ?? null });
  } catch (e) {
    out({ id: msg.id, e: e instanceof Error ? e.message : String(e) });
  }
});
rl.on("close", () => {
  core.shutdown();
  setTimeout(() => process.exit(0), 1500);
});
log(`agent ${AGENT_VERSION} ready on ${process.platform} ${process.version}`);
export {
  AGENT_VERSION
};
