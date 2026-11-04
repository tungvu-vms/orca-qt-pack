// src/worker.ts
import { existsSync as existsSync6, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname5, join as join5, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/core.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync4, readdirSync as readdirSync3, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve3, sep } from "node:path";
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
    return new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve5, reject, timer });
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
function installPyright(prefix, node, log) {
  const entry = join(prefix, "node_modules", "basedpyright", "langserver.index.js");
  if (existsSync(entry)) return Promise.resolve(entry);
  const busy = running.get(prefix);
  if (busy) return busy;
  const job = new Promise((resolve5) => {
    mkdirSync(prefix, { recursive: true });
    const binDir = dirname(node);
    const cli = [join(binDir, "node_modules", "npm", "bin", "npm-cli.js"), join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p2) => existsSync(p2));
    const args = ["install", "--prefix", prefix, `basedpyright@${PYRIGHT_VERSION}`, "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: binDir + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "") };
    log(`cai basedpyright ${PYRIGHT_VERSION} vao ${prefix} ...`);
    const p = cli ? spawn2(node, [cli, ...args], { env, windowsHide: true }) : spawn2(process.platform === "win32" ? "npm.cmd" : "npm", args, { env, shell: process.platform === "win32", windowsHide: true });
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
        log("da cai basedpyright");
        resolve5(entry);
      } else {
        log(`cai basedpyright that bai (${code}): ${err.trim().slice(-400)}`);
        resolve5(null);
      }
    });
  });
  running.set(prefix, job);
  return job;
}

// src/interpreters.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname as dirname2, isAbsolute, join as join2, resolve } from "node:path";
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
      if (existsSync2(abs) && statSync(abs).isFile()) return abs;
      const exe2 = envExe(abs);
      if (exe2) return exe2;
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
    const base = join2(process.env.LOCALAPPDATA ?? join2(process.env.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Python");
    try {
      for (const d of readdirSync(base)) out.push(join2(base, d, "python.exe"));
    } catch {
    }
  }
  const names = WIN ? ["python.exe"] : ["python3", "python"];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN ? ";" : ":")) {
    if (!dir || /WindowsApps/i.test(dir)) continue;
    for (const n of names) out.push(join2(dir, n));
  }
  if (!WIN) out.push("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3");
  const seen = /* @__PURE__ */ new Set();
  return out.filter((p) => {
    const k = lower(p);
    if (seen.has(k) || !existsSync2(p)) return false;
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
    if (seen.has(key2) || !existsSync2(path)) return null;
    seen.add(key2);
    const envDir = dirname2(dirname2(path));
    const isVenv = isEnvDir(envDir) || isEnvDir(dirname2(path));
    const dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname2(path)) ? dirname2(path) : null;
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
    const up = dirname2(dir);
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
  const out = [];
  if (extra) out.push(extra);
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
      for (const k of kits) if (existsSync3(join3(root, v, k, "bin"))) out.push(join3(root, v, k, "bin"));
    }
  }
  return out;
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
  // QML/C++: du an CMake/qmake (CMakeLists.txt sau nhat co project()), .qmlls.ini, compile_commands, .git
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
  // workspace la thu muc home (vd. /Users/<ten>): bo qua thu muc he thong/media lon
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
    return discoverInterpreters(file ?? join4(root, "__init__.py"), root, { saved, setting: await setting("python", "") });
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
      if (!entry) throw new Error(`Kh\xF4ng t\xECm th\u1EA5y basedpyright/Pyright tr\xEAn m\xE1y ${process.platform}. C\xE0i (c\u1EA7n Node.js 18+ k\xE8m npm): npm i --prefix ${WIN3 ? '"%LOCALAPPDATA%\\orca-qt-lsp"' : "~/.local/share/orca-qt-lsp"} basedpyright@1.40.2`);
      const node = await setting("nodePath", "") || findNode();
      return { cmd: node, args: [entry, "--stdio"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detail: entry.includes("basedpyright") ? "basedpyright" : "pyright" };
    }
    if (lang === "qml") {
      const qmlls = findQmlls(await setting("qmllsPath", ""), await setting("qtBin", ""));
      if (!qmlls) throw new Error('Kh\xF4ng t\xECm th\u1EA5y qmlls (Qt 6.4+). \u0110\u1EB7t "qmlls path" ho\u1EB7c "Qt bin folder" trong Settings c\u1EE7a plugin.');
      const args2 = [];
      const builds = findBuildDirs(root, "qml");
      for (const b of builds.slice(0, 1)) args2.push("-b", b);
      const qmlDir = join4(dirname4(dirname4(qmlls)), "qml");
      if (existsSync4(qmlDir)) args2.push("-I", qmlDir);
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
      const out = {
        version: p.version ?? -1,
        items: p.diagnostics.map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code === "object" ? d.code?.value : d.code }))
      };
      srv.diagnostics.set(norm(path), out);
      host.post("lsp.diagnostics", { path, version: out.version, items: out.items.slice(0, 300).map((d) => ({ ...d, message: String(d.message).slice(0, 500) })) });
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
    host.log(`${lang} ready for ${root} (${detail})`);
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
    const { roots } = await host.roots();
    const p = norm(resolve3(path));
    let best = null;
    for (const w of [...roots, ...[...servers.values()].map((s) => s.root)]) {
      const r = resolve3(w);
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
      return { ok: false, path: null, candidates: 0, workspace: focused, server: null, message: `Kh\xF4ng t\xECm th\u1EA5y file n\xE0y (${roots.length} workspace \u0111\xE3 qu\xE9t).` };
    }
    let ws = wsRoot;
    for (const w of listed.roots) if (norm(hits[0]).startsWith(norm(resolve3(w)) + sep) && resolve3(w).length > ws.length) ws = resolve3(w);
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
    for (const s of [...servers.values()]) if (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep)) stopServer(s);
  };
  const LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i;
  const isLibPath = (p, root) => !norm(p).startsWith(norm(root) + sep) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length));
  handle("lsp.hover", async ({ path, position }) => {
    const srv = await serverForPath(path);
    const r = await srv.client.request("textDocument/hover", { textDocument: { uri: uriOf(path) }, position });
    if (!r) return { markdown: null, range: null };
    const c = r.contents;
    const md = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => typeof x === "string" ? x : "```" + (x.language ?? "") + "\n" + x.value + "\n```").join("\n\n") : c?.kind === "plaintext" ? "```\n" + c.value + "\n```" : c?.value ?? null;
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }));
  });
  handle("lsp.definition", async ({ path, position }) => {
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
  handle("lsp.completion", async ({ path, position, trigger }) => {
    const srv = await serverForPath(path);
    const context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 };
    const r = await srv.client.request("textDocument/completion", { textDocument: { uri: uriOf(path) }, position, context });
    const items = (Array.isArray(r) ? r : r?.items ?? []).slice(0, 300).map((it) => {
      const doc = typeof it.documentation === "string" ? it.documentation : it.documentation?.value;
      const out = { label: String(it.label).trim(), kind: it.kind ?? 1 };
      if (it.detail) out.detail = String(it.detail);
      if (doc) out.documentation = String(doc).slice(0, 1500);
      const insert = it.textEdit?.newText ?? it.insertText;
      if (insert) out.insertText = String(insert);
      if (it.textEdit?.range ?? it.textEdit?.replace) out.range = it.textEdit.range ?? it.textEdit.replace;
      if (it.sortText) out.sortText = String(it.sortText);
      if (it.filterText) out.filterText = String(it.filterText);
      return out;
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
    if (!langOfPath(path) && !/(^|[\\/])[A-Z][A-Za-z0-9]*$/.test(path)) return { text: "", lang: null };
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

// src/remote.ts
import { spawn as spawn3 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync5 } from "node:fs";
import { createInterface } from "node:readline";

// src/probe-script.ts
var PROBE_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const A=JSON.parse(Buffer.from(Q,'base64').toString());
const sizes=new Set(A.sizes),SK=new Set(A.skip),ext=new RegExp(A.ext,'i');
const roots=[...A.hints,...A.roots];
try{const st=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.orca-qt-lsp','state.json'),'utf8'));roots.push(...(st.roots||[]))}catch{}
const win=process.platform==='win32';
try{const o=require('child_process').execSync(win?'orca.cmd worktree list --json':'orca worktree list --json',{encoding:'utf8',timeout:8000,stdio:['ignore','pipe','ignore'],maxBuffer:64<<20,windowsHide:true});
 for(const w of (JSON.parse(o).result||{}).worktrees||[])if(!w.hostId||w.hostId==='local')roots.push(w.path)}catch{}
roots.push(os.homedir());
if(win){for(const d of 'CDEFGH')roots.push(d+':\\')}else{for(const d of ['/data','/srv','/opt','/workspace','/work','/projects'])roots.push(d)}
const sha=f=>crypto.createHash('sha1').update(fs.readFileSync(f,'utf8').replace(/^﻿/,'').replace(/\r\n/g,'\n')).digest('hex');
const t0=Date.now(),seen=new Set();
for(const r of roots){if(!r||!fs.existsSync(r))continue;let level=[r];
 for(let d=0;level.length&&d<=14;d++){const next=[];
  for(const dir of level){if(seen.has(dir))continue;seen.add(dir);
   if(Date.now()-t0>A.ms){console.log('QTLSP-NONE timeout');process.exit(0)}
   let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}
   for(const e of es){const n=e.name;
    if(e.isDirectory()){if(!SK.has(n)&&!n.startsWith('.')&&!/^(build|out|cmake-build-)/i.test(n))next.push(path.join(dir,n));continue}
    if(!e.isFile()||!ext.test(n))continue;const f=path.join(dir,n);let s;try{s=fs.statSync(f).size}catch{continue}
    if(sizes.has(s)){try{if(sha(f)===A.hash){console.log('QTLSP-FOUND '+JSON.stringify({path:f,root:r}));process.exit(0)}}catch{}}}}
  level=next}}
console.log('QTLSP-NONE');
`;
var EXT_RE = {
  python: "\\.(py|pyi|pyw)$",
  qml: "\\.qml$",
  cpp: "\\.(cpp|cc|cxx|c|h|hpp|hh|hxx|inl|ipp)$"
};
var PROBE_SKIP = [
  "node_modules",
  "__pycache__",
  "venv",
  "env",
  "dist",
  "site-packages",
  "Library",
  "Applications",
  "AppData",
  "Movies",
  "Music",
  "Pictures",
  "Downloads",
  "$Recycle.Bin",
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "snap",
  "proc",
  "sys"
];

// src/remote.ts
var NODE_CANDIDATES = [
  (a) => ["node", a],
  (a) => ["/opt/homebrew/bin/node", a],
  (a) => ["/usr/local/bin/node", a],
  (a) => ["/usr/bin/node", a],
  // nvm / fnm / volta / asdf: node khong nam tren PATH cua phien SSH khong tuong tac.
  // Lenh duoi chay bang sh (Linux/macOS); tren Windows (cmd) se loi va bi bo qua.
  (a) => ["sh", "-c", `'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node 2>/dev/null | sort -V | tail -1); [ -n "$n" ] && exec "$n" ${a}; exit 127'`],
  (a) => ["bash", "-lc", `'exec node ${a}'`],
  (a) => ["zsh", "-lc", `'exec node ${a}'`],
  (a) => ["bash", "-ic", `'exec node ${a}'`]
];
function findSsh(setting) {
  if (setting) return setting;
  if (process.platform === "win32") {
    const sys = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\OpenSSH\\ssh.exe`;
    if (existsSync5(sys)) return sys;
  }
  return "ssh";
}
var RemoteAgent = class {
  constructor(host, ssh, agentSource, settings) {
    this.host = host;
    this.ssh = ssh;
    this.agentSource = agentSource;
    this.settings = settings;
    this.version = createHash2("sha1").update(agentSource).digest("hex").slice(0, 10);
  }
  host;
  ssh;
  agentSource;
  settings;
  proc = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  starting = null;
  node = NODE_CANDIDATES[0];
  info = null;
  lastError = "";
  onEvent = () => {
  };
  log = () => {
  };
  version;
  get alive() {
    return !!this.proc && this.proc.exitCode === null && !!this.info;
  }
  sshArgs(cmd) {
    return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", this.host, ...cmd];
  }
  /** Chay mot lenh ngan qua SSH, gui `input` vao stdin roi dong. */
  run(cmd, input, timeoutMs = 6e4) {
    return new Promise((resolve5) => {
      const p = spawn3(this.ssh, this.sshArgs(cmd), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const t = setTimeout(() => {
        try {
          p.kill();
        } catch {
        }
      }, timeoutMs);
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.stderr.on("data", (d) => {
        err += d;
      });
      p.on("error", (e) => {
        err += e.message;
      });
      p.on("close", (code) => {
        clearTimeout(t);
        resolve5({ code, out, err });
      });
      p.stdin.end(input);
    });
  }
  nodeKnown = false;
  nodeCandidates() {
    if (this.nodeKnown) return [this.node];
    const custom = String(this.settings.remoteNode ?? "").trim();
    return custom ? [(a) => [custom, a], ...NODE_CANDIDATES] : NODE_CANDIDATES;
  }
  /** Do tim file tren may kia, chi doc (xem probe-script.ts). Nem loi neu khong SSH/khong chay duoc node. */
  async probe(q) {
    const script = `const Q=${JSON.stringify(Buffer.from(JSON.stringify(q)).toString("base64"))};${PROBE_SCRIPT}`;
    let last = "";
    for (const node of this.nodeCandidates()) {
      const r = await this.run(node("-"), script, q.ms + 2e4);
      const m = /QTLSP-FOUND (.+)/.exec(r.out);
      if (m || r.out.includes("QTLSP-NONE")) {
        this.node = node;
        this.nodeKnown = true;
        return m ? JSON.parse(m[1]) : null;
      }
      last = (r.err || r.out).trim().split("\n").pop()?.slice(0, 160) ?? String(r.code);
      if (r.code === 255) break;
    }
    throw new Error(last || "kh\xF4ng ch\u1EA1y \u0111\u01B0\u1EE3c node");
  }
  /** Chep agent sang may kia (neu chua co ban nay) va tim node dung duoc. */
  async install() {
    const b64 = Buffer.from(this.agentSource).toString("base64");
    const script = `const fs=require('fs'),path=require('path'),os=require('os');const d=path.join(os.homedir(),'.orca-qt-lsp');fs.mkdirSync(d,{recursive:true});const f=path.join(d,'agent-${this.version}.mjs');if(!fs.existsSync(f)){fs.writeFileSync(f+'.tmp',Buffer.from('${b64}','base64'));fs.renameSync(f+'.tmp',f)}for(const n of fs.readdirSync(d))if(/^agent-[0-9a-f]+\\.mjs$/.test(n)&&n!=='agent-${this.version}.mjs')try{fs.unlinkSync(path.join(d,n))}catch{}console.log('QTLSP-OK '+process.version+' '+process.platform)
`;
    const tried = [];
    for (const node of this.nodeCandidates()) {
      const r = await this.run(node("-"), script);
      if (r.out.includes("QTLSP-OK")) {
        this.node = node;
        this.nodeKnown = true;
        this.log(`${this.host}: agent ${this.version} san sang (${r.out.trim().split(" ").slice(1).join(" ")}, ${node("").join(" ")})`);
        return;
      }
      tried.push(`${node("").join(" ")}: ${(r.err || r.out).trim().split("\n").pop()?.slice(0, 160) ?? r.code}`);
      if (r.code === 255) break;
    }
    const last = tried[tried.length - 1] ?? "";
    const hint = /Host key verification|Permission denied|publickey|Could not resolve|timed out|Connection refused/i.test(last) ? `Ki\u1EC3m tra: ch\u1EA1y "ssh ${this.host}" m\u1ED9t l\u1EA7n trong terminal (ch\u1EA5p nh\u1EADn host key) v\xE0 d\xF9ng kh\xF3a SSH, kh\xF4ng m\u1EADt kh\u1EA9u.` : 'M\xE1y kia c\u1EA7n Node.js >= 18 (ho\u1EB7c \u0111\u1EB7t "Remote node path").';
    throw new Error(`Kh\xF4ng ch\u1EA1y \u0111\u01B0\u1EE3c agent tr\xEAn ${this.host}: ${last}. ${hint}`);
  }
  start() {
    if (this.alive && this.info) return Promise.resolve(this.info);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.install();
      const p = spawn3(this.ssh, this.sshArgs(this.node(`.orca-qt-lsp/agent-${this.version}.mjs`)), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.proc = p;
      let errTail = "";
      p.stderr.on("data", (d) => {
        errTail = (errTail + d).slice(-2e3);
      });
      p.on("error", (e) => {
        this.lastError = e.message;
      });
      p.on("exit", (code) => {
        this.lastError = `${this.host}: agent tho\xE1t (${code}) ${errTail.trim().split("\n").pop() ?? ""}`;
        this.log(this.lastError);
        this.info = null;
        this.proc = null;
        for (const x of this.pending.values()) {
          clearTimeout(x.timer);
          x.reject(new Error(this.lastError));
        }
        this.pending.clear();
      });
      createInterface({ input: p.stdout }).on("line", (line) => {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.log) {
          this.log(`${this.host}: ${m.log}`);
          return;
        }
        if (m.ev) {
          this.onEvent(m.ev, m.p);
          return;
        }
        const x = this.pending.get(m.id);
        if (!x) return;
        this.pending.delete(m.id);
        clearTimeout(x.timer);
        if ("e" in m) x.reject(new Error(m.e));
        else x.resolve(m.r);
      });
      const info = await this.call("$hello", { settings: this.settings }, 3e4);
      this.info = info;
      return info;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  call(m, p, timeoutMs = 9e4) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return Promise.reject(new Error(this.lastError || `${this.host}: ch\u01B0a k\u1EBFt n\u1ED1i`));
    const id = this.nextId++;
    return new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.host}: ${m} qu\xE1 th\u1EDDi gian`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve5, reject, timer });
      proc.stdin.write(JSON.stringify({ id, m, p }) + "\n");
    });
  }
  /** Gui khong cho tra loi (vd. danh sach thu muc goc). */
  notify(m, p) {
    if (this.proc && this.proc.exitCode === null) this.proc.stdin.write(JSON.stringify({ id: 0, m, p }) + "\n");
  }
  stop() {
    try {
      this.proc?.stdin?.end();
    } catch {
    }
    setTimeout(() => {
      try {
        this.proc?.kill();
      } catch {
      }
    }, 2e3);
  }
};

// src/worker.ts
var WIN4 = process.platform === "win32";
var norm2 = (p) => WIN4 ? p.toLowerCase() : p;
var isLocal = (w) => !w.hostId || w.hostId === "local";
var HERE = dirname5(fileURLToPath2(import.meta.url));
var REMOTE_RE = /^@([^:]+):(.*)$/s;
var tag = (host, p) => `@${host}:${p}`;
var untag = (p) => {
  const m = REMOTE_RE.exec(p);
  return m ? { host: m[1], path: m[2] } : null;
};
var errText = (e) => e instanceof Error ? e.message : String(e);
function sshConfigHosts(auto = false, configPath = join5(homedir3(), ".ssh", "config")) {
  const blocks = [];
  const read = (file, depth) => {
    if (depth > 3 || !existsSync6(file)) return;
    let text = "";
    try {
      text = readFileSync3(file, "utf8");
    } catch {
      return;
    }
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k === "host") {
        cur = { names: m[2].split(/\s+/).filter(Boolean), opts: {} };
        blocks.push(cur);
        continue;
      }
      if (k === "match") {
        cur = null;
        continue;
      }
      if (k === "include") {
        for (const v of m[2].split(/\s+/)) {
          if (/[*?]/.test(v)) continue;
          const p = v.replace(/^~/, homedir3());
          read(/^([\\/]|[A-Za-z]:)/.test(p) ? p : join5(homedir3(), ".ssh", p), depth + 1);
        }
        continue;
      }
      if (cur && !(k in cur.opts)) cur.opts[k] = m[2].trim();
    }
  };
  read(configPath, 0);
  const out = [];
  const seenTarget = /* @__PURE__ */ new Set();
  for (const b of blocks) {
    for (const n of b.names) {
      if (/[*?!]/.test(n)) continue;
      const hostName = (b.opts.hostname ?? n).toLowerCase();
      if (/^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com|ssh\.github\.com)$/.test(hostName)) continue;
      if (auto && b.opts.proxycommand) continue;
      const target = `${(b.opts.user ?? "").toLowerCase()}@${hostName}:${b.opts.port ?? "22"}|${b.opts.proxyjump ?? ""}`;
      if (auto && seenTarget.has(target)) continue;
      seenTarget.add(target);
      out.push(n);
    }
  }
  return [...new Set(out)];
}
function activate(orca) {
  const setting = async (k, fallback) => {
    try {
      const v = await orca.settings.get(k);
      return v === void 0 || v === null || v === "" ? fallback : v;
    } catch {
      return fallback;
    }
  };
  async function localRoots() {
    const { workspaces } = await orca.host.call("workspace.list", {});
    const local2 = workspaces.filter(isLocal);
    let focused = null;
    const ctx = await orca.host.call("workspace.readContext", {}).catch(() => null);
    if (ctx) {
      const m = local2.find((w) => w.name === ctx.displayName && (w.branch ?? "") === (ctx.branch ?? "")) ?? local2.find((w) => w.name === ctx.displayName);
      focused = m?.path ?? null;
    }
    return { focused, roots: local2.map((w) => resolve4(w.path)) };
  }
  const local = createCore({
    log: (m) => orca.log(m),
    post: (ev, p) => orca.panels.post(ev, p),
    setting,
    storageGet: (k) => orca.storage.get(k),
    storageSet: async (k, v) => {
      await orca.storage.set(k, v);
    },
    roots: () => localRoots(),
    reveal: async (path, line) => {
      const { workspaces } = await orca.host.call("workspace.list", {});
      const p = norm2(resolve4(path));
      let ws = null;
      for (const w of workspaces) if (isLocal(w) && p.startsWith(norm2(resolve4(w.path)) + (WIN4 ? "\\" : "/")) && (!ws || w.path.length > ws.path.length)) ws = w;
      if (!ws) return { opened: false, reason: "outside" };
      const rel = resolve4(path).slice(resolve4(ws.path).length + 1).split(/[\\/]/).join("/");
      await orca.host.call("editor.open", { workspaceId: ws.id, path: rel });
      return { opened: true, line, rel };
    }
  });
  const agents = /* @__PURE__ */ new Map();
  let agentSource = null;
  const cfg = { sshPath: "", remoteRoots: "", remoteNode: "" };
  const loadCfg = async () => {
    cfg.sshPath = String(await setting("sshPath", ""));
    cfg.remoteRoots = String(await setting("remoteRoots", ""));
    cfg.remoteNode = String(await setting("remoteNode", ""));
  };
  const cfgReady = loadCfg();
  try {
    orca.settings.onDidChange?.(() => {
      void loadCfg();
      for (const a of agents.values()) a.stop();
      agents.clear();
    });
  } catch {
  }
  const extraHosts = async () => String(await setting("remoteHosts", "")).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  function remoteFor(host) {
    let a = agents.get(host);
    if (!a) {
      agentSource ??= readFileSync3(join5(HERE, "agent.mjs"), "utf8");
      a = new RemoteAgent(host, findSsh(cfg.sshPath), agentSource, { remoteRoots: cfg.remoteRoots, remoteNode: cfg.remoteNode });
      a.log = (l) => orca.log(l);
      a.onEvent = (ev, p) => {
        if (p && typeof p.path === "string") p = { ...p, path: tag(host, p.path) };
        orca.panels.post(ev, p);
      };
      agents.set(host, a);
    }
    return a;
  }
  async function agentFor(host) {
    await cfgReady;
    const a = remoteFor(host);
    await a.start();
    return a;
  }
  async function remoteHints() {
    const { workspaces } = await orca.host.call("workspace.list", {}).catch(() => ({ workspaces: [] }));
    return workspaces.filter((w) => !isLocal(w)).map((w) => w.path);
  }
  const SKIP_KEYS = /* @__PURE__ */ new Set(["current", "list", "interpreter"]);
  const tagPaths = (host, v) => {
    if (Array.isArray(v)) return v.map((x) => tagPaths(host, x));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = SKIP_KEYS.has(k) ? x : (k === "path" || k === "workspace") && typeof x === "string" ? tag(host, x) : tagPaths(host, x);
      return o;
    }
    return v;
  };
  const PROJECT_HOSTS = "projectHosts";
  const NO_PROJECT = "(kh\xF4ng c\xF3 workspace)";
  async function projectKey() {
    const ctx = await orca.host.call("workspace.readContext", {}).catch(() => null);
    return ctx?.displayName || NO_PROJECT;
  }
  async function projectHosts() {
    try {
      const v = await orca.storage.get(PROJECT_HOSTS);
      return v && typeof v === "object" ? { ...v } : {};
    } catch {
      return {};
    }
  }
  async function rememberHost(key2, host) {
    const map = await projectHosts();
    if (host) map[key2] = host;
    else delete map[key2];
    await orca.storage.set(PROJECT_HOSTS, map);
  }
  async function attachOn(host, input, hints) {
    const a = await agentFor(host);
    const r = await a.call("lsp.attach", { ...input, hints }, 12e4);
    return r.path ? tagPaths(host, r) : r;
  }
  async function attach(input) {
    await cfgReady;
    const key2 = await projectKey();
    const chosen = (await projectHosts())[key2];
    if (chosen === "local") return local.handlers["lsp.attach"](input);
    if (chosen) {
      try {
        const r = await attachOn(chosen, input, await remoteHints());
        if (r.path) return r;
        await rememberHost(key2, null);
      } catch (e) {
        return { ok: false, path: null, candidates: 0, workspace: null, server: null, message: `${chosen}: ${errText(e)} \u2014 b\u1EA5m \u21C4 \u1EDF g\xF3c d\u01B0\u1EDBi \u0111\u1EC3 ch\u1ECDn m\xE1y kh\xE1c.` };
      }
    }
    const res = await local.handlers["lsp.attach"](input);
    if (res.path) return res;
    const hosts = [.../* @__PURE__ */ new Set([...await extraHosts(), ...sshConfigHosts(true)])].slice(0, 40);
    if (!hosts.length) {
      return { ...res, message: "Kh\xF4ng t\xECm th\u1EA5y file tr\xEAn m\xE1y n\xE0y, v\xE0 ~/.ssh/config ch\u01B0a c\xF3 m\xE1y n\xE0o. N\u1EBFu code \u1EDF m\xE1y kh\xE1c: b\u1EA5m \u21C4 \u1EDF g\xF3c d\u01B0\u1EDBi, g\xF5 user@host." };
    }
    const hints = await remoteHints();
    const sizes = [input.size, input.sizeCrlf].filter((s) => typeof s === "number").flatMap((s) => [s, s + 3]);
    const roots = cfg.remoteRoots.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
    const q = { hash: input.hash ?? "", sizes, ext: EXT_RE[input.language], hints, roots, skip: PROBE_SKIP, ms: 25e3 };
    const errors = [];
    const found = await new Promise((done) => {
      let left = hosts.length;
      let settled = false;
      for (const host of hosts) {
        void remoteFor(host).probe(q).then(
          (hit) => {
            if (hit && !settled) {
              settled = true;
              done({ host, root: hit.root });
            } else if (!hit) errors.push(`${host}: kh\xF4ng c\xF3`);
          },
          (e) => {
            errors.push(`${host}: ${errText(e).slice(0, 80)}`);
          }
        ).finally(() => {
          if (--left === 0 && !settled) {
            settled = true;
            done(null);
          }
        });
      }
    });
    if (found) {
      orca.log(`project "${key2}" -> ${found.host} (t\u1EF1 t\xECm th\u1EA5y trong ${found.root})`);
      try {
        const r = await attachOn(found.host, input, [found.root, ...hints]);
        if (r.path) {
          if (key2 !== NO_PROJECT) await rememberHost(key2, found.host);
          return r;
        }
      } catch (e) {
        return { ...res, message: `T\xECm th\u1EA5y file tr\xEAn ${found.host} nh\u01B0ng kh\xF4ng ch\u1EA1y \u0111\u01B0\u1EE3c agent: ${errText(e)}` };
      }
    }
    orca.log(`attach miss on ${hosts.length} hosts: ${errors.join("; ")}`);
    return { ...res, message: `Kh\xF4ng t\xECm th\u1EA5y file tr\xEAn m\xE1y n\xE0y v\xE0 ${hosts.length} m\xE1y SSH (${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "\u2026" : ""}). B\u1EA5m \u21C4 \u1EDF g\xF3c d\u01B0\u1EDBi \u0111\u1EC3 ch\u1ECDn m\xE1y.` };
  }
  const route = (name) => async (input) => {
    const target = input && typeof input.path === "string" ? untag(input.path) : null;
    if (!target) return local.handlers[name](input);
    if (name === "lsp.reveal") return { opened: false, reason: "remote" };
    const a = await agentFor(target.host);
    const out = tagPaths(target.host, await a.call(name, { ...input, path: target.path }));
    if (name === "lsp.definition" && out?.locations) for (const l of out.locations) l.inWorkspace = false;
    return out;
  };
  orca.panels.handle("lsp.attach", (input) => attach(input));
  for (const name of Object.keys(local.handlers)) if (name !== "lsp.attach") orca.panels.handle(name, route(name));
  orca.panels.handle("lsp.hostChoice", async () => {
    const key2 = await projectKey();
    const map = await projectHosts();
    const hosts = [.../* @__PURE__ */ new Set([...await extraHosts(), ...Object.values(map).filter((h) => h !== "local"), ...sshConfigHosts(false)])];
    return { project: key2, chosen: map[key2] ?? null, hosts };
  });
  orca.panels.handle("lsp.setHost", async (input) => {
    const host = (input?.host ?? "").trim() || null;
    const key2 = await projectKey();
    await rememberHost(key2, host);
    orca.log(`project "${key2}" -> ${host ?? "t\u1EF1 \u0111\u1ED9ng"} (ch\u1ECDn tay)`);
    if (host && host !== "local") {
      try {
        const a = await agentFor(host);
        return { project: key2, chosen: host, ok: true, info: a.info };
      } catch (e) {
        return { project: key2, chosen: host, ok: false, error: errText(e) };
      }
    }
    return { project: key2, chosen: host, ok: true };
  });
  orca.panels.handle("lsp.remoteStatus", async () => ({
    projects: await projectHosts(),
    agents: [...agents.values()].map((a) => ({ host: a.host, alive: a.alive, info: a.info, error: a.lastError }))
  }));
  orca.events.on("workspace.removed", ({ path }) => local.workspaceRemoved(path));
}
function deactivate() {
}
export {
  deactivate,
  activate as default,
  sshConfigHosts
};
