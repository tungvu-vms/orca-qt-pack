// src/agent.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
import { createInterface } from "node:readline";

// src/core.ts
import { createHash } from "node:crypto";
import { readdirSync as readdirSync3, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve4, sep as sep2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/lsp-client.ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
var LspClient = class {
  proc;
  buf = Buffer.alloc(0);
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  notifyHandlers = /* @__PURE__ */ new Map();
  requestHandlers = /* @__PURE__ */ new Map();
  cancellationFolder;
  cancelled = /* @__PURE__ */ new Set();
  exited = !1;
  onExit;
  log = () => {
  };
  constructor(command, args, cwd, env, options) {
    if (options?.fileCancellation) {
      let base = join(tmpdir(), "python-languageserver-cancellation");
      mkdirSync(base, { recursive: !0 }), this.cancellationFolder = mkdtempSync(join(base, "orca-")), args = [...args, `--cancellationReceive=file:${basename(this.cancellationFolder)}`];
    }
    this.proc = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: !0, stdio: ["pipe", "pipe", "pipe"] }), this.proc.stdin.on("error", (e) => {
      this.log(`[stdin] ${e.message}`), this.closePending(e), this.kill();
    }), this.proc.stdout.on("data", (d) => this.onData(d)), this.proc.stderr.on("data", (d) => this.log(`[stderr] ${d.toString().trim().slice(0, 500)}`)), this.proc.on("exit", (code) => {
      this.closePending(new Error("language server exited")), this.clearCancellationFolder(), this.onExit?.(code);
    }), this.proc.on("error", (e) => {
      this.log(`[spawn] ${e.message}`), this.closePending(e), this.clearCancellationFolder();
    });
  }
  onNotification(method, h) {
    this.notifyHandlers.set(method, h);
  }
  onRequest(method, h) {
    this.requestHandlers.set(method, h);
  }
  request(method, params, timeoutMs = 15e3, signal) {
    if (this.exited) return Promise.reject(new Error("language server exited"));
    let aborted = () => Object.assign(new Error("Request cancelled"), { name: "AbortError" });
    if (signal?.aborted) return Promise.reject(aborted());
    let id = ++this.nextId;
    return new Promise((resolve5, reject) => {
      let timer = setTimeout(() => {
        this.pending.delete(id), cleanup(), this.cancelRequest(id), reject(new Error(`${method} timed out`));
      }, timeoutMs), cancel = () => {
        this.pending.delete(id) && (cleanup(), this.cancelRequest(id), reject(aborted()));
      }, cleanup = () => {
        clearTimeout(timer), signal?.removeEventListener("abort", cancel);
      };
      this.pending.set(id, { resolve: resolve5, reject, cleanup }), signal?.addEventListener("abort", cancel, { once: !0 }), this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.exited || this.write({ jsonrpc: "2.0", method, params });
  }
  kill() {
    this.closePending(new Error("language server exited"));
    try {
      this.proc.kill();
    } catch {
    }
  }
  closePending(error) {
    if (!this.exited) {
      this.exited = !0;
      for (let p of this.pending.values())
        p.cleanup(), p.reject(error);
      this.pending.clear(), this.buf = Buffer.alloc(0);
    }
  }
  cancelRequest(id) {
    if (this.cancellationFolder)
      try {
        writeFileSync(join(this.cancellationFolder, `cancellation-${id}.tmp`), ""), this.cancelled.add(id);
      } catch (e) {
        this.log(`[cancellation] ${String(e)}`);
      }
    this.notify("$/cancelRequest", { id });
  }
  clearCancellationFolder() {
    let folder = this.cancellationFolder;
    if (folder && dirname(resolve(folder)) === resolve(tmpdir(), "python-languageserver-cancellation") && basename(folder).startsWith("orca-"))
      try {
        rmSync(folder, { recursive: !0, force: !0 });
      } catch {
      }
    this.cancellationFolder = void 0, this.cancelled.clear();
  }
  write(msg) {
    if (this.exited) return;
    if (!this.proc.stdin.writable || this.proc.stdin.destroyed) {
      this.closePending(new Error("language server input closed")), this.kill();
      return;
    }
    let s = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s, "utf8")}\r
\r
${s}`);
  }
  onData(d) {
    for (this.buf = Buffer.concat([this.buf, d]); ; ) {
      let h = this.buf.indexOf(`\r
\r
`);
      if (h < 0) return;
      let m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, h).toString("ascii"));
      if (!m) {
        this.buf = this.buf.subarray(h + 4);
        continue;
      }
      let len = Number(m[1]);
      if (this.buf.length < h + 4 + len) return;
      let body = this.buf.subarray(h + 4, h + 4 + len).toString("utf8");
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
    if (!this.exited) {
      if (msg.id !== void 0 && msg.method === void 0) {
        if (this.cancelled.delete(msg.id) && this.cancellationFolder)
          try {
            rmSync(join(this.cancellationFolder, `cancellation-${msg.id}.tmp`), { force: !0 });
          } catch {
          }
        let p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id), p.cleanup(), msg.error ? p.reject(new Error(msg.error.message ?? "LSP error")) : p.resolve(msg.result);
        return;
      }
      if (msg.id !== void 0) {
        let h = this.requestHandlers.get(msg.method);
        Promise.resolve(h ? h(msg.params) : null).then((result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null })).catch((e) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }));
        return;
      }
      this.notifyHandlers.get(msg.method)?.(msg.params);
    }
  }
};

// src/language-adapters.ts
import { homedir as homedir2 } from "node:os";

// src/servers.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { homedir } from "node:os";
var LANGUAGE_ID = {
  python: () => "python",
  qml: () => "qml",
  cpp: (p) => /\.c$/i.test(p) ? "c" : "cpp"
}, SERVER_LABEL = { python: "Pyright", qml: "qmlls", cpp: "clangd" }, WIN = process.platform === "win32", home = () => process.env.USERPROFILE ?? process.env.HOME ?? homedir(), pathDirs = () => (process.env.PATH ?? process.env.Path ?? "").split(WIN ? ";" : ":").filter(Boolean), exe = (name) => WIN ? `${name}.exe` : name, lower = (p) => WIN ? p.toLowerCase() : p;
function firstExisting(cands) {
  for (let c of cands) if (c && existsSync(c)) return c;
  return null;
}
function findClangd(configured) {
  if (configured) {
    if (!existsSync(configured) || !statSync(configured).isFile()) throw new Error(`Configured clangd was not found: ${configured}`);
    return configured;
  }
  let c = pathDirs().map((d) => join2(d, exe("clangd")));
  if (WIN) {
    for (let root of ["C:\\Qt", join2(home(), "Qt")]) c.push(join2(root, "Tools", "QtCreator", "bin", "clang", "bin", "clangd.exe"));
    c.push("C:\\Program Files\\LLVM\\bin\\clangd.exe");
  } else
    c.push("/Applications/Qt Creator.app/Contents/Resources/libexec/clang/bin/clangd", join2(home(), "Qt", "Tools", "QtCreator", "libexec", "qtcreator", "clang", "bin", "clangd"), "/usr/bin/clangd", "/usr/local/bin/clangd", "/opt/homebrew/opt/llvm/bin/clangd");
  try {
    let vsc = join2(home(), ".vscode", "extensions");
    for (let d of readdirSync(vsc).filter((n) => n.startsWith("llvm-vs-code-extensions.vscode-clangd"))) {
      let inst = join2(vsc, d, "install");
      for (let v of existsSync(inst) ? readdirSync(inst) : []) c.push(join2(inst, v, `clangd_${v}`, "bin", exe("clangd")));
    }
  } catch {
  }
  return firstExisting(c);
}
var BUILD_DIR_RE = /^(build|out|cmake-build-.*|build-.*|_build)$/i;
function findBuildDirs(root, want) {
  let hits = [], check = (dir) => {
    try {
      if (want === "compile_commands") {
        let f = join2(dir, "compile_commands.json");
        existsSync(f) && hits.push({ dir, mtime: statSync(f).mtimeMs });
      } else (existsSync(join2(dir, "CMakeCache.txt")) || existsSync(join2(dir, "qmldir"))) && hits.push({ dir, mtime: statSync(dir).mtimeMs });
    } catch {
    }
  };
  want === "compile_commands" && check(root);
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  for (let n of names) {
    if (!BUILD_DIR_RE.test(n)) continue;
    let d = join2(root, n);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    check(d);
    try {
      for (let s of readdirSync(d)) {
        let sd = join2(d, s);
        try {
          statSync(sd).isDirectory() && check(sd);
        } catch {
        }
      }
    } catch {
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime).map((h) => h.dir);
}
function compilationDatabaseDir(root, configured) {
  if (!configured.trim()) return findBuildDirs(root, "compile_commands")[0] ?? null;
  let folder = resolve2(root, configured.trim()), file = join2(folder, "compile_commands.json");
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Compilation database missing: ${file}`);
  return folder;
}
var PROJECT_MARKERS = {
  python: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", ".git"],
  // QML/C++: CMake/qmake project (deepest CMakeLists.txt with project()), .qmlls.ini, compile_commands, .git
  qml: [".qmlls.ini", "CMakeLists.txt", ".git"],
  cpp: ["compile_commands.json", ".clangd", "compile_flags.txt", "CMakeLists.txt", ".git"]
};
function projectRootFor(lang, file, limit) {
  let stop = lower(resolve2(limit)), chain = [];
  for (let dir = dirname2(resolve2(file)); lower(dir).startsWith(stop) && (chain.push(dir), lower(dir) !== stop); ) {
    let up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  if (lang === "python") {
    let hasVenv = (d) => {
      try {
        return readdirSync(d).some((n) => existsSync(join2(d, n, "pyvenv.cfg")));
      } catch {
        return !1;
      }
    };
    for (let d of chain) if (PROJECT_MARKERS.python.some((m) => existsSync(join2(d, m))) || hasVenv(d)) return d;
    return resolve2(limit);
  }
  let strong = lang === "qml" ? [".qmlls.ini"] : ["compile_commands.json", ".clangd", "compile_flags.txt"];
  for (let d of chain) if (strong.some((m) => existsSync(join2(d, m)))) return d;
  let top = null;
  for (let d of chain)
    if (existsSync(join2(d, "CMakeLists.txt")) || existsSync(join2(d, `${d.split(/[\\/]/).pop()}.pro`))) top = d;
    else if (top) break;
  if (top) return top;
  for (let d of chain) if (existsSync(join2(d, ".git"))) return d;
  return resolve2(limit);
}

// src/language-adapters.ts
var WIN2 = process.platform === "win32";
async function serverCommand(lang, root, context) {
  let { setting } = context;
  if (lang !== "cpp")
    throw new Error("Unsupported language adapter");
  let clangd = findClangd(await setting("clangdPath", ""));
  if (!clangd)
    throw new Error(
      'clangd not found. Install LLVM or Qt Creator, or set "clangd path" in Settings.'
    );
  let args = [
    "--background-index",
    "--clang-tidy=false",
    "--header-insertion=never",
    "--completion-style=detailed",
    "--log=error",
    "--pch-storage=memory"
  ], cc = compilationDatabaseDir(
    root,
    await setting("compilationDatabase", "")
  );
  cc && args.push(`--compile-commands-dir=${cc}`);
  let drivers = WIN2 ? [
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
  ], extra = String(await setting("compilerGlobs", "")).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
  return args.push(`--query-driver=${[...drivers, ...extra].join(",")}`), {
    cmd: clangd,
    args,
    detail: cc ? `compile_commands: ${cc}` : "no compile_commands.json (configure your build system, use .clangd or compile_flags.txt)"
  };
}

// src/interpreters.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync, realpathSync, statSync as statSync2 } from "node:fs";
import { basename as basename2, dirname as dirname3, isAbsolute, join as join3, resolve as resolve3, sep } from "node:path";
var WIN3 = process.platform === "win32", lower2 = (p) => WIN3 ? p.toLowerCase() : p;
function envExe(envDir) {
  return (WIN3 ? [join3(envDir, "Scripts", "python.exe"), join3(envDir, "bin", "python.exe"), join3(envDir, "python.exe")] : [join3(envDir, "bin", "python"), join3(envDir, "bin", "python3")]).find((f) => existsSync2(f)) ?? null;
}
var SKIP = /* @__PURE__ */ new Set([".git", "node_modules", ".tox", "__pycache__", "bin", "Scripts", ".mypy_cache", ".pytest_cache", ".orca"]), PROJECT_MARKERS2 = ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", ".git"];
function readJsonc(file) {
  try {
    let text = readFileSync(file, "utf8"), s = "", inStr = !1;
    for (let i = 0; i < text.length; i++) {
      let c = text[i], n = text[i + 1];
      if (inStr)
        s += c, c === "\\" ? (s += n, i++) : c === '"' && (inStr = !1);
      else if (c === '"')
        inStr = !0, s += c;
      else if (c === "/" && n === "/") {
        for (; i < text.length && text[i] !== `
`; ) i++;
        s += `
`;
      } else if (c === "/" && n === "*") {
        for (i += 2; i < text.length && !(text[i] === "*" && text[i + 1] === "/"); ) i++;
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
    let cfg = readFileSync(join3(envDir, "pyvenv.cfg"), "utf8");
    return /^\s*(?:version_info|version)\s*=\s*([\d.]+)/im.exec(cfg)?.[1] ?? null;
  } catch {
    return null;
  }
}
var versionCache = /* @__PURE__ */ new Map();
function runVersion(python) {
  let k = lower2(python);
  if (versionCache.has(k)) return versionCache.get(k);
  let v = null;
  try {
    v = execFileSync(python, ["-c", 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { encoding: "utf8", timeout: 4e3, windowsHide: !0, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    v = null;
  }
  return versionCache.set(k, v), v;
}
function cmpVersionDesc(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  let pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}
var isEnvDir = (dir) => existsSync2(join3(dir, "pyvenv.cfg")) || existsSync2(join3(dir, "conda-meta")), envDirOf = (exe2) => isEnvDir(dirname3(dirname3(exe2))) ? dirname3(dirname3(exe2)) : isEnvDir(dirname3(exe2)) ? dirname3(exe2) : null;
function projectEnvs(root) {
  let found = /* @__PURE__ */ new Set();
  for (let n of [".venv", ".conda", ".virtualenv", "venv"]) isEnvDir(join3(root, n)) && found.add(join3(root, n));
  let names = [];
  try {
    names = readdirSync2(root);
  } catch {
  }
  for (let n of names) {
    if (SKIP.has(n)) continue;
    let full = join3(root, n);
    try {
      statSync2(full).isDirectory() && isEnvDir(full) && found.add(full);
    } catch {
    }
  }
  return [...found];
}
function projectRootFor2(file, limit) {
  let dir = dirname3(resolve3(file)), stop = lower2(resolve3(limit));
  for (; lower2(dir).startsWith(stop); ) {
    if (PROJECT_MARKERS2.some((m) => existsSync2(join3(dir, m))) || projectEnvs(dir).length) return dir;
    if (lower2(dir) === stop) break;
    let up = dirname3(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve3(limit);
}
function vscodeInterpreter(root) {
  for (let dir = root, i = 0; i < 6; i++) {
    let s = readJsonc(join3(dir, ".vscode", "settings.json")), raw = s?.["python.defaultInterpreterPath"] ?? s?.["python.pythonPath"];
    if (raw && raw !== "python") {
      let p = raw.replace(/\$\{workspaceFolder\}/g, dir).replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] ?? ""), abs = isAbsolute(p) ? p : resolve3(dir, p);
      if (existsSync2(abs) && statSync2(abs).isFile()) {
        if (envDirOf(abs)) return abs;
      } else {
        let exe2 = isEnvDir(abs) ? envExe(abs) : null;
        if (exe2) return exe2;
      }
    }
    let up = dirname3(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
function pyrightConfigInterpreter(root) {
  let cfg = readJsonc(join3(root, "pyrightconfig.json")), venvPath = cfg?.venvPath, venv = cfg?.venv;
  if (!venv)
    try {
      let toml = readFileSync(join3(root, "pyproject.toml"), "utf8"), sec = /\[tool\.(?:based)?pyright\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
      venvPath = /venvPath\s*=\s*"([^"]+)"/.exec(sec)?.[1] ?? venvPath, venv = /^\s*venv\s*=\s*"([^"]+)"/m.exec(sec)?.[1];
    } catch {
    }
  if (!venv) return null;
  let dir = resolve3(root, venvPath ?? ".", venv);
  return isEnvDir(dir) ? envExe(dir) : null;
}
function globalCandidates() {
  let out2 = [];
  if (WIN3) {
    try {
      let txt = execFileSync("py", ["-0p"], { encoding: "utf8", timeout: 4e3, windowsHide: !0, stdio: ["ignore", "pipe", "ignore"] });
      for (let line of txt.split(/\r?\n/)) {
        let m = /([A-Za-z]:\\.*python\.exe)\s*$/i.exec(line.trim());
        m && out2.push(m[1]);
      }
    } catch {
    }
    let base = join3(process.env.LOCALAPPDATA ?? join3(process.env.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Python");
    try {
      for (let d of readdirSync2(base)) out2.push(join3(base, d, "python.exe"));
    } catch {
    }
  }
  let names = WIN3 ? ["python.exe"] : ["python3", "python"];
  for (let dir of (process.env.PATH ?? process.env.Path ?? "").split(WIN3 ? ";" : ":"))
    if (!(!dir || /WindowsApps/i.test(dir)))
      for (let n of names) out2.push(join3(dir, n));
  WIN3 || out2.push("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3");
  let seen = /* @__PURE__ */ new Set();
  return out2.filter((p) => {
    let k = lower2(p);
    return seen.has(k) || !existsSync2(p) ? !1 : (seen.add(k), !0);
  });
}
function discoverInterpreters(file, root, opts = {}) {
  let useProject = opts.projectEnvs !== !1, project = projectRootFor2(file, root), list = [], seen = /* @__PURE__ */ new Set(), insideRoot = (p) => {
    let r = lower2(resolve3(root)), abs = lower2(resolve3(p));
    if (abs === r || abs.startsWith(r + sep)) return !0;
    try {
      let realRoot = lower2(realpathSync(root)), real = lower2(realpathSync(p));
      return real === realRoot || real.startsWith(realRoot + sep);
    } catch {
      return !1;
    }
  }, make = (path, source, reason) => {
    let key2 = lower2(resolve3(path));
    if (seen.has(key2) || !existsSync2(path)) return null;
    seen.add(key2);
    let envDir = dirname3(dirname3(path)), isVenv = isEnvDir(envDir) || isEnvDir(dirname3(path)), dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname3(path)) ? dirname3(path) : null;
    if (!useProject && (dir || insideRoot(path))) return null;
    let inProject = insideRoot(path), version = dir && venvVersion(dir) || (inProject ? null : runVersion(path)), name = dir ? lower2(dir).startsWith(lower2(project) + (WIN3 ? "\\" : "/")) ? dir.slice(project.length + 1).replace(/\\/g, "/") : basename2(dir) : `Python ${version ?? ""}`.trim();
    return { path: resolve3(path), label: isVenv ? `${name}${version ? ` (${version})` : ""}` : `${name} (global)`, version, source, envDir: dir, reason };
  }, add = (path, source, reason) => {
    if (!path) return;
    let it = make(path, source, reason);
    it && list.push(it);
  };
  add(opts.saved, "saved", "you selected it for this project"), add(opts.setting, "setting", 'plugin setting "Python interpreter"'), useProject && add(vscodeInterpreter(project), "vscode", "python.defaultInterpreterPath in .vscode/settings.json"), useProject && add(pyrightConfigInterpreter(project), "pyright", "venvPath/venv in pyrightconfig/pyproject");
  let levels = [];
  for (let dir = project; lower2(dir).startsWith(lower2(resolve3(root))) && (levels.push(dir), lower2(dir) !== lower2(resolve3(root))); ) {
    let up = dirname3(dir);
    if (up === dir) break;
    dir = up;
  }
  for (let [i, dir] of useProject ? levels.entries() : []) {
    let envs = projectEnvs(dir).map((d) => ({ d, exe: envExe(d) })).map((x) => ({ ...x, version: venvVersion(x.d) })).sort((a, b) => +!a.exe - +!b.exe || cmpVersionDesc(a.version, b.version) || basename2(a.d).localeCompare(basename2(b.d)) || a.d.localeCompare(b.d));
    for (let e of envs) e.exe && add(e.exe, "venv", i === 0 ? envs.length > 1 ? `project venv (${envs.length} venvs: highest Python version chosen)` : "project venv" : "parent folder venv");
  }
  let active = process.env.VIRTUAL_ENV;
  useProject && active && lower2(resolve3(active)).startsWith(lower2(project)) && add(envExe(active), "env", "active VIRTUAL_ENV");
  let globals = globalCandidates().filter((p) => !insideRoot(p) && !envDirOf(p)).map((p) => ({ p, v: runVersion(p) })).filter((x) => x.v).sort((a, b) => cmpVersionDesc(a.v, b.v));
  for (let g of globals) add(g.p, "global", "no venv: using the highest installed Python");
  return list;
}

// src/transport.ts
var encoder = new TextEncoder(), jsonBytes = (value) => encoder.encode(JSON.stringify(value)).length;
function messageBytes(value) {
  let objects = 0, visit = (v, depth) => depth > 90 ? 1 / 0 : v == null || typeof v == "boolean" ? 1 : typeof v == "number" ? 8 : typeof v == "string" ? encoder.encode(v).length : ++objects > 9e3 ? 1 / 0 : Array.isArray(v) ? 8 + v.reduce((sum, item) => sum + 4 + visit(item, depth + 1), 0) : Object.entries(v).reduce((sum, [key2, item]) => sum + 4 + encoder.encode(key2).length + visit(item, depth + 1), 0);
  return Math.max(jsonBytes(value), visit(value, 0));
}
function limitItems(items, envelope, budget = 7e5) {
  let count = 0, high = items.length;
  for (; count < high; ) {
    let middle = Math.ceil((count + high) / 2);
    messageBytes(envelope(items.slice(0, middle))) <= budget ? count = middle : high = middle - 1;
  }
  return items.slice(0, count);
}

// src/protocol.ts
var DOCUMENT_READ_METHODS = /* @__PURE__ */ new Set([
  "lsp.hover",
  "lsp.definition",
  "lsp.references",
  "lsp.signatureHelp",
  "lsp.documentSymbols",
  "lsp.documentHighlights",
  "lsp.semanticTokens",
  "lsp.completion",
  "lsp.prepareRename"
]);

// src/language-profile.ts
var PLUGIN_ID = "cpp-code-intelligence";
function languageOfPath(path) {
  return /\.(py|pyi|pyw)$/i.test(path) ? "python" : /\.qml$/i.test(path) ? "qml" : /\.(cpp|cc|cxx|c\+\+|c|h|hpp|hh|hxx|inl|ipp|tpp|tcc|ixx|cppm)$/i.test(
    path
  ) ? "cpp" : null;
}
function assertSupportedInput(method, input) {
  if (method === "lsp.peek" || method === "lsp.reveal")
    return;
  let language = method === "lsp.attach" ? input?.language : typeof input?.path == "string" ? languageOfPath(input.path) : null;
  if ((method === "lsp.attach" || input?.path) && language !== "cpp")
    throw new Error(
      `${PLUGIN_ID} supports only cpp; unsupported language request`
    );
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
]), sha = (s) => createHash("sha1").update(s.replace(/\r\n/g, `
`)).digest("hex"), WIN4 = process.platform === "win32", pluginDir = () => process.env.QT_LSP_DIR || resolve4(dirname4(fileURLToPath(import.meta.url)), ".."), norm = (p) => WIN4 ? p.toLowerCase() : p, key = (lang, root) => `${lang}|${norm(root)}`, langOfPath = languageOfPath;
function createCore(host) {
  let handlers = {}, handle = (name, fn) => {
    handlers[name] = async (input) => {
      if (assertSupportedInput(name, input), DOCUMENT_READ_METHODS.has(name) && Number.isInteger(input?.version)) {
        let lang = langOfPath(input.path), server = lang ? serverOf(lang, input.path) : null;
        if (!docs.has(norm(input.path)) || server?.open.get(norm(input.path)) !== input.version) return { resync: !0 };
      }
      return JSON.parse(JSON.stringify(await fn(input) ?? null));
    };
  }, servers = /* @__PURE__ */ new Map(), starting = /* @__PURE__ */ new Map(), hashIndex = /* @__PURE__ */ new Map();
  async function setting(k, fallback) {
    try {
      let v = await host.setting(k, null);
      return v == null || v === "" ? fallback : v;
    } catch {
      return fallback;
    }
  }
  let MAX_FILES = 2e5, skipDir = (n) => SKIP2.has(n) || n.startsWith(".") || /^(build|out|cmake-build-)/i.test(n);
  function scan(root, match) {
    let cached = hashIndex.get(root);
    if (cached && Date.now() - cached.at < 3e5) return null;
    let bySize = /* @__PURE__ */ new Map(), count = 0, stopAt = Date.now() + 3e4, level = [root];
    for (let depth = 0; level.length && depth <= 14; depth++) {
      let next = [];
      for (let dir of level) {
        if (count > MAX_FILES || Date.now() > stopAt) return null;
        let ents = [];
        try {
          ents = readdirSync3(dir, { withFileTypes: !0 });
        } catch {
          continue;
        }
        for (let e of ents) {
          let n = e.name;
          if (e.isDirectory()) {
            skipDir(n) || next.push(join4(dir, n));
            continue;
          }
          if (!e.isFile() || !langOfPath(n) || langOfPath(n) !== "cpp") continue;
          let full = join4(dir, n), size;
          try {
            size = statSync3(full).size;
          } catch {
            continue;
          }
          count++;
          let k = `size:${size}`, list = bySize.get(k);
          if (list ? list.push(full) : bySize.set(k, [full]), match?.(full, size)) return full;
        }
      }
      level = next;
    }
    return hashIndex.set(root, { at: Date.now(), byHash: bySize }), null;
  }
  function indexFor(root) {
    return scan(root), hashIndex.get(root)?.byHash ?? /* @__PURE__ */ new Map();
  }
  let hashCache = /* @__PURE__ */ new Map();
  function fileHash(p) {
    try {
      let st = statSync3(p), c = hashCache.get(p);
      if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.h;
      let h = sha(readFileSync2(p, "utf8").replace(/^﻿/, ""));
      return hashCache.set(p, { mtime: st.mtimeMs, size: st.size, h }), h;
    } catch {
      return null;
    }
  }
  let SAVED_KEY = "interpreters";
  async function savedInterpreters() {
    try {
      let v = await host.storageGet(SAVED_KEY);
      return v && typeof v == "object" ? v : {};
    } catch {
      return {};
    }
  }
  async function interpretersFor(root, file) {
    return [];
  }
  async function serverFor(lang, root, file) {
    let existing = servers.get(key(lang, root));
    if (existing && !existing.client.exited)
      return await existing.ready, existing;
    let id = key(lang, root), pending = starting.get(id);
    if (pending) return pending;
    let startup = startServer(lang, root, file);
    starting.set(id, startup);
    try {
      return await startup;
    } finally {
      starting.get(id) === startup && starting.delete(id);
    }
  }
  async function startServer(lang, root, file) {
    let { cmd, args, env, detail } = await serverCommand(lang, root, { setting, pluginDir, log: host.log, installPyright: host.installPyright });
    host.log(`spawn ${lang}: ${cmd} ${args.join(" ")} (root ${root})`);
    let client = new LspClient(cmd, args, lang === "python" ? pluginDir() : root, env, { fileCancellation: lang === "python" });
    client.log = (l) => host.log(`[${lang}] ${l}`);
    let srv = { lang, root, client, ready: Promise.resolve(), open: /* @__PURE__ */ new Map(), diagnostics: /* @__PURE__ */ new Map(), legend: null, interpreter: null, detail, capabilities: {} };
    client.onExit = (code) => {
      host.log(`${lang} server exited (${code}) for ${root}`), servers.get(key(lang, root)) === srv && servers.delete(key(lang, root));
    };
    let typeMode = String(await setting("typeCheckingMode", "off")).trim() || "off";
    lang === "python" && (srv.interpreter = (await interpretersFor(root, file))[0] ?? null, host.log(`interpreter for ${root}: ${srv.interpreter ? `${srv.interpreter.path} [${srv.interpreter.source}]` : "none"}`)), client.onRequest("workspace/configuration", (params) => params.items.map((it) => {
      if (lang !== "python") return {};
      let py = srv.interpreter?.path, analysis = {
        typeCheckingMode: typeMode,
        diagnosticMode: "openFilesOnly",
        autoSearchPaths: !0,
        useLibraryCodeForTypes: !0,
        autoImportCompletions: !0,
        // Large Qt/Python repositories often keep packaged apps and additional
        // checkouts here. Explicit imports still resolve; avoid enumerating them
        // for workspace indexing before an interactive request can be answered.
        exclude: ["**/node_modules/**", "**/__pycache__/**", "**/.git/**", "**/.worktrees/**", "**/.venv/**", "**/venv/**", "**/build/**", "**/dist/**", "**/out/**"],
        ...typeMode === "off" ? { diagnosticSeverityOverrides: { reportMissingImports: "error" } } : {}
      };
      return it.section === "python" ? { ...py ? { pythonPath: py, defaultInterpreterPath: py } : {}, analysis } : it.section === "basedpyright" || it.section === "pyright" ? { analysis } : it.section === "python.analysis" || it.section === "basedpyright.analysis" ? analysis : {};
    })), client.onRequest("window/workDoneProgress/create", () => null), client.onRequest("client/registerCapability", () => null), client.onRequest("window/showMessageRequest", () => null), client.onRequest("workspace/semanticTokens/refresh", () => (host.post("lsp.refresh", { lang, root }), null)), client.onNotification("window/showMessage", (p) => host.log(`[${lang}] ${p?.message ?? ""}`)), client.onNotification("textDocument/publishDiagnostics", (p) => {
      let path;
      try {
        path = fileURLToPath(p.uri);
      } catch {
        return;
      }
      let out2 = {
        version: p.version ?? -1,
        items: p.diagnostics.filter((d) => {
          let code = typeof d.code == "object" ? d.code?.value : d.code;
          return lang !== "python" || typeMode !== "off" || code == null || code === "reportMissingImports";
        }).map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code == "object" ? d.code?.value : d.code }))
      };
      srv.diagnostics.set(norm(path), out2);
      let envelope = (items) => ({ path, version: out2.version, items });
      host.post("lsp.diagnostics", JSON.parse(JSON.stringify(envelope(limitItems(out2.items.slice(0, 300).map((d) => ({ ...d, message: String(d.message).slice(0, 500) })), envelope, 22e4)))));
    });
    let rootUri = pathToFileURL(root).href;
    srv.ready = client.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: root.split(sep2).pop() }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: !1, dynamicRegistration: !1 },
          definition: { linkSupport: !1 },
          declaration: { linkSupport: !1 },
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { snippetSupport: !0, documentationFormat: ["markdown", "plaintext"] }, contextSupport: !0 },
          references: {},
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: !0 }, activeParameterSupport: !0 }, contextSupport: !0 },
          documentSymbol: { hierarchicalDocumentSymbolSupport: !0 },
          documentHighlight: {},
          rename: { prepareSupport: !0 },
          publishDiagnostics: { versionSupport: !0 },
          semanticTokens: { requests: { full: !0, range: !1 }, tokenTypes: [], tokenModifiers: [], formats: ["relative"], multilineTokenSupport: !1, overlappingTokenSupport: !1 }
        },
        workspace: { configuration: !0, workspaceFolders: !0, semanticTokens: { refreshSupport: !0 } }
      },
      initializationOptions: lang === "cpp" ? { clangdFileStatus: !1 } : {}
    }, 6e4).then((init) => {
      srv.capabilities = init?.capabilities ?? {};
      let legend = init?.capabilities?.semanticTokensProvider?.legend;
      legend?.tokenTypes && (srv.legend = { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers ?? [] }), client.notify("initialized", {}), lang === "python" && client.notify("workspace/didChangeConfiguration", { settings: {} });
    }), servers.set(key(lang, root), srv);
    try {
      await srv.ready;
    } catch (e) {
      throw servers.get(key(lang, root)) === srv && servers.delete(key(lang, root)), srv.client.kill(), e;
    }
    return host.log(`${lang} ready for ${root} (${detail})`), srv;
  }
  function serverOf(lang, path) {
    let best = null;
    for (let s of servers.values())
      s.lang === lang && norm(path).startsWith(norm(s.root) + sep2) && (!best || s.root.length > best.root.length) && (best = s);
    return best;
  }
  let attachedRoots = /* @__PURE__ */ new Map(), uriOf = (path) => pathToFileURL(path).href;
  async function rootForFile(lang, path) {
    let hit = attachedRoots.get(`${lang}|${norm(path)}`);
    if (hit) return hit;
    let { roots } = await host.roots(), p = norm(resolve4(path)), best = null;
    for (let w of [...roots, ...[...servers.values()].map((s) => s.root)]) {
      let r = resolve4(w);
      p.startsWith(norm(r) + sep2) && (!best || r.length > best.length) && (best = r);
    }
    if (!best) return null;
    let root = projectRootFor(lang, path, best);
    return attachedRoots.set(`${lang}|${norm(path)}`, root), root;
  }
  async function serverForPath(path) {
    let lang = langOfPath(path);
    if (!lang) throw new Error(`Unsupported file type: ${path}`);
    let r = await rootForFile(lang, path);
    if (!r) throw new Error(`No workspace contains ${path}`);
    let srv = await serverFor(lang, r, path);
    if (!srv.open.has(norm(path)))
      try {
        srv.client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[lang](path), version: 0, text: readFileSync2(path, "utf8") } }), srv.open.set(norm(path), 0);
      } catch {
      }
    return srv;
  }
  handle("lsp.attach", async (input) => {
    let lang = input.language, listed = await host.roots(input.hints).catch(() => ({ focused: null, roots: [] })), focused = listed.focused, known = [...servers.values()].map((s) => s.root), roots = [focused, ...known, ...listed.roots.map((w) => resolve4(w))].filter((r, i, a) => !!r && a.findIndex((x) => x && norm(x) === norm(r)) === i), h = input.hash ?? sha(input.text ?? ""), sizes = [input.size, input.sizeCrlf].filter((s) => typeof s == "number").flatMap((s) => [s, s + 3]), sizeSet = new Set(sizes), ok = (p) => langOfPath(p) === lang && fileHash(p) === h, find = (r) => {
      let cached = hashIndex.get(r);
      if (!cached || Date.now() - cached.at >= 3e5) {
        let hit = scan(r, (full, size) => (sizeSet.size ? sizeSet.has(size) : !0) && ok(full));
        if (hit) return [hit];
      }
      let idx = hashIndex.get(r)?.byHash;
      if (!idx) return [];
      let cands = sizes.length ? sizes.flatMap((s) => idx.get(`size:${s}`) ?? []) : [...idx.values()].flat();
      return [...new Set(cands)].filter(ok);
    }, wsRoot = null, hits = [], deadline = Date.now() + 6e4;
    for (let r of roots) {
      if (Date.now() > deadline) break;
      if (hits = find(r), hits.length) {
        wsRoot = r;
        break;
      }
    }
    if (!wsRoot)
      for (let r of roots) {
        if (Date.now() > deadline) break;
        if (hashIndex.delete(r), hits = find(r), hits.length) {
          wsRoot = r;
          break;
        }
      }
    if (!wsRoot) {
      let scanned = roots.map((r) => `${r} (${[...hashIndex.get(r)?.byHash.values() ?? []].reduce((n, l) => n + l.length, 0)} file)`);
      return host.log(`attach miss: lang=${lang} size=${input.size} roots=${scanned.join(" | ")}`), { ok: !1, path: null, candidates: 0, workspace: focused, server: null, message: `File not found (${roots.length} workspaces scanned).` };
    }
    let ws = wsRoot;
    for (let w of listed.roots) norm(hits[0]).startsWith(norm(resolve4(w)) + sep2) && resolve4(w).length > ws.length && (ws = resolve4(w));
    let root = projectRootFor(lang, hits[0], ws);
    try {
      let srv = await serverFor(lang, root, hits[0]);
      for (let p of hits) attachedRoots.set(`${lang}|${norm(p)}`, root);
      return { ok: !0, path: hits[0], candidates: hits.length, workspace: root, server: `${SERVER_LABEL[lang]}${srv.detail ? ` (${srv.detail})` : ""}` };
    } catch (e) {
      return { ok: !1, path: hits[0], candidates: hits.length, workspace: root, server: null, message: e instanceof Error ? e.message : String(e) };
    }
  });
  let docs = /* @__PURE__ */ new Map(), sendFull = (srv, path, text, version) => {
    srv.open.has(norm(path)) ? srv.client.notify("textDocument/didChange", { textDocument: { uri: uriOf(path), version }, contentChanges: [{ text }] }) : srv.client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[srv.lang](path), version, text } }), srv.open.set(norm(path), version), docs.set(norm(path), text);
  };
  handle("lsp.open", async ({ path, text, version }) => {
    let srv = await serverForPath(path);
    return sendFull(srv, path, text ?? readFileSync2(path, "utf8"), version), { ok: !0 };
  }), handle("lsp.change", async ({ path, text, version, edits, expectLength }) => {
    let srv = await serverForPath(path), next = text;
    if (next === void 0 && edits) {
      let base = docs.get(norm(path));
      if (base === void 0) return { ok: !1, resync: !0 };
      let cur = base;
      for (let e of [...edits].sort((a, b) => b.offset - a.offset)) cur = cur.slice(0, e.offset) + e.text + cur.slice(e.offset + e.length);
      next = cur;
    }
    return next === void 0 ? { ok: !1, resync: !0 } : edits && typeof expectLength == "number" && next.length !== expectLength ? { ok: !1, resync: !0 } : (sendFull(srv, path, next, version), { ok: !0 });
  });
  let uploads = /* @__PURE__ */ new Map();
  handle("lsp.upload", async ({ path, version, part, index, total }) => {
    let k = norm(path);
    index === 0 && uploads.set(k, []);
    let parts = uploads.get(k);
    return parts ? (parts[index] = part, index < total - 1 ? { ok: !0, pending: !0 } : (uploads.delete(k), sendFull(await serverForPath(path), path, parts.join(""), version), { ok: !0 })) : { ok: !1 };
  }), handle("lsp.close", async ({ path }) => {
    docs.delete(norm(path)), uploads.delete(norm(path));
    let lang = langOfPath(path), srv = lang ? serverOf(lang, path) : null;
    return srv?.open.delete(norm(path)) && srv.client.notify("textDocument/didClose", { textDocument: { uri: uriOf(path) } }), srv && srv.open.size === 0 && setTimeout(() => {
      srv.open.size === 0 && servers.get(key(srv.lang, srv.root)) === srv && stopServer(srv);
    }, 6e4), { ok: !0 };
  });
  function stopServer(srv) {
    starting.delete(key(srv.lang, srv.root)), servers.delete(key(srv.lang, srv.root)), hashIndex.delete(srv.root), srv.client.request("shutdown", null, 3e3).catch(() => {
    }).finally(() => {
      srv.client.notify("exit", null), setTimeout(() => srv.client.kill(), 500);
    });
  }
  let workspaceRemoved = (path) => {
    for (let s of [...servers.values()]) (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep2)) && stopServer(s);
  }, LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i, isLibPath = (p, root) => !norm(p).startsWith(norm(root) + sep2) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length)), interactiveRequests = /* @__PURE__ */ new Map();
  async function interactive(input, run) {
    let controller = new AbortController(), id = input.requestId ? `${norm(input.path)}|${input.requestId}` : null;
    id && interactiveRequests.set(id, controller);
    try {
      return await run(controller.signal);
    } finally {
      id && interactiveRequests.get(id) === controller && interactiveRequests.delete(id);
    }
  }
  handle("lsp.cancel", async ({ path, requestId }) => (interactiveRequests.get(`${norm(path)}|${requestId}`)?.abort(), { ok: !0 })), handle("lsp.hover", (input) => interactive(input, async (signal) => {
    let { path, position } = input, r = await (await serverForPath(path)).client.request("textDocument/hover", { textDocument: { uri: uriOf(path) }, position }, 15e3, signal);
    if (!r) return { markdown: null, range: null };
    let c = r.contents, md = typeof c == "string" ? c : Array.isArray(c) ? c.map((x) => typeof x == "string" ? x : "```" + (x.language ?? "") + `
` + x.value + "\n```").join(`

`) : c?.kind === "plaintext" ? "```\n" + c.value + "\n```" : c?.value ?? null;
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }));
  }));
  let peekable = /* @__PURE__ */ new Set();
  async function locationsOf(list, srv) {
    let wsRoots = [...(await host.roots().catch(() => ({ roots: [] }))).roots, srv.root].map((x) => resolve4(x)), locations = [];
    for (let l of list) {
      let p;
      try {
        p = fileURLToPath(l.uri ?? l.targetUri);
      } catch {
        continue;
      }
      let range = l.targetSelectionRange ?? l.range ?? l.targetRange;
      !range?.start || !range?.end || (peekable.add(norm(p)), locations.push({ path: p, range, inWorkspace: !isLibPath(p, srv.root), openable: wsRoots.some((r) => norm(p).startsWith(norm(r) + sep2)) }));
    }
    return limitItems(locations, (locations2) => ({ locations: locations2, truncated: !0 }));
  }
  handle("lsp.definition", (input) => interactive(input, async (signal) => {
    let { path, position } = input, srv = await serverForPath(path), r = await srv.client.request("textDocument/definition", { textDocument: { uri: uriOf(path) }, position }, 15e3, signal);
    (!r || Array.isArray(r) && !r.length) && srv.lang === "cpp" && (r = await srv.client.request("textDocument/declaration", { textDocument: { uri: uriOf(path) }, position }).catch(() => null));
    let list = r ? Array.isArray(r) ? r : [r] : [], locations = await locationsOf(list, srv);
    return input.intent === "click" && host.log(`[navigation] click ${path}:${position.line + 1}:${position.character + 1} -> ${locations.length} definitions`), JSON.parse(JSON.stringify({ locations }));
  })), handle("lsp.references", async ({ path, position, includeDeclaration = !0 }) => {
    let srv = await serverForPath(path);
    if (!srv.capabilities.referencesProvider) return { locations: [] };
    let r = await srv.client.request("textDocument/references", { textDocument: { uri: uriOf(path) }, position, context: { includeDeclaration } }), locations = await locationsOf(r ?? [], srv);
    return { locations, truncated: locations.length < (r?.length ?? 0) };
  });
  let markdown = (v) => (typeof v == "string" ? v : v?.value)?.slice(0, 8e3);
  return handle("lsp.signatureHelp", async ({ path, position, trigger }) => {
    let srv = await serverForPath(path), empty = { signatures: [], activeSignature: 0, activeParameter: 0 };
    if (!srv.capabilities.signatureHelpProvider) return empty;
    let r = await srv.client.request("textDocument/signatureHelp", {
      textDocument: { uri: uriOf(path) },
      position,
      context: { triggerKind: trigger ? 2 : 1, triggerCharacter: trigger, isRetrigger: !1 }
    });
    if (!r) return empty;
    let signatures = (r.signatures ?? []).slice(0, 50).map((s) => ({
      label: String(s.label).slice(0, 16e3),
      documentation: markdown(s.documentation),
      activeParameter: s.activeParameter,
      parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: markdown(p.documentation) }))
    }));
    return { ...empty, signatures: limitItems(signatures, (signatures2) => ({ ...empty, signatures: signatures2 })), activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0 };
  }), handle("lsp.documentSymbols", async ({ path }) => {
    let srv = await serverForPath(path);
    if (!srv.capabilities.documentSymbolProvider) return { items: [] };
    let raw = await srv.client.request("textDocument/documentSymbol", { textDocument: { uri: uriOf(path) } }), items = [], visit = (list, parent = "", depth = 0) => {
      if (!(depth > 100))
        for (let s of list) {
          if (items.length >= 1e4) return;
          let range = s.range ?? s.location?.range;
          range && (items.push({ name: String(s.name), detail: s.detail ?? "", kind: s.kind, range, selectionRange: s.selectionRange ?? range, containerName: s.containerName ?? parent, tags: s.tags }), s.children && visit(s.children, s.name, depth + 1));
        }
    };
    visit(raw ?? []);
    let capped = limitItems(items, (items2) => ({ items: items2, truncated: !0 }));
    return { items: capped, truncated: capped.length < items.length };
  }), handle("lsp.documentHighlights", async ({ path, position }) => {
    let srv = await serverForPath(path);
    if (!srv.capabilities.documentHighlightProvider) return { items: [] };
    let r = await srv.client.request("textDocument/documentHighlight", { textDocument: { uri: uriOf(path) }, position });
    return { items: limitItems((r ?? []).map((h) => ({ range: h.range, kind: h.kind ?? 1 })), (items) => ({ items })) };
  }), handle("lsp.prepareRename", async ({ path, position }) => {
    let srv = await serverForPath(path);
    if (!srv.capabilities.renameProvider) return { rejectReason: "This language server does not support rename." };
    if (!srv.capabilities.renameProvider.prepareProvider) return {};
    let r = await srv.client.request("textDocument/prepareRename", { textDocument: { uri: uriOf(path) }, position });
    if (!r) return { rejectReason: "This symbol cannot be renamed." };
    if (r.defaultBehavior) return {};
    let range = r.range ?? r, line = docs.get(norm(path))?.split(/\r?\n/)[range.start.line];
    return { range, placeholder: r.placeholder ?? (range.start.line === range.end.line ? line?.slice(range.start.character, range.end.character) : void 0) };
  }), handle("lsp.rename", async ({ path, position, newName, version }) => {
    let srv = await serverForPath(path), reject = (rejectReason) => ({ edits: [], rejectReason });
    if (!srv.capabilities.renameProvider) return reject("This language server does not support rename.");
    if (!newName?.trim()) return reject("Enter a non-empty name.");
    if (srv.open.get(norm(path)) !== version) return reject("The document changed. Try rename again.");
    let r = await srv.client.request("textDocument/rename", { textDocument: { uri: uriOf(path) }, position, newName });
    if (srv.open.get(norm(path)) !== version) return reject("The document changed. Try rename again.");
    if (!r) return reject("This symbol cannot be renamed.");
    let edits = [], add = (uri, changes) => {
      let target;
      try {
        target = fileURLToPath(uri);
      } catch {
        return !1;
      }
      if (norm(resolve4(target)) !== norm(resolve4(path))) return !1;
      for (let e of changes) {
        if (!e.range || typeof e.newText != "string") return !1;
        edits.push({ range: e.range, text: e.newText });
      }
      return !0;
    };
    for (let [uri, changes] of Object.entries(r.changes ?? {})) if (!add(uri, changes)) return reject("Rename also changes other files. Cross-file rename is not available yet; no changes were applied.");
    for (let change of r.documentChanges ?? []) {
      if (!change.textDocument || !Array.isArray(change.edits)) return reject("Rename requires file operations; no changes were applied.");
      if (change.textDocument.version != null && change.textDocument.version !== version) return reject("The document changed. Try rename again.");
      if (!add(change.textDocument.uri, change.edits)) return reject("Rename also changes other files. Cross-file rename is not available yet; no changes were applied.");
    }
    return messageBytes({ edits }) > 7e5 ? reject("This rename is too large; no changes were applied.") : { edits };
  }), handle("lsp.completion", async ({ path, position, trigger }) => {
    let srv = await serverForPath(path), context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 }, r = await srv.client.request("textDocument/completion", { textDocument: { uri: uriOf(path) }, position, context }), items = (Array.isArray(r) ? r : r?.items ?? []).slice(0, 300).map((it) => {
      let doc = typeof it.documentation == "string" ? it.documentation : it.documentation?.value, out2 = { label: String(it.label).trim(), kind: it.kind ?? 1 };
      it.detail && (out2.detail = String(it.detail)), doc && (out2.documentation = String(doc).slice(0, 1500));
      let insert = it.textEdit?.newText ?? it.insertText;
      return insert && (out2.insertText = String(insert)), (it.textEdit?.range ?? it.textEdit?.replace) && (out2.range = it.textEdit.range ?? it.textEdit.replace), it.sortText && (out2.sortText = String(it.sortText)), it.filterText && (out2.filterText = String(it.filterText)), it.insertTextFormat === 2 && (out2.snippet = !0), it.additionalTextEdits?.length && (out2.additionalTextEdits = it.additionalTextEdits.map((e) => ({ range: e.range, text: e.newText }))), out2;
    }), capped = limitItems(items, (items2) => ({ items: items2, incomplete: !0 }));
    return JSON.parse(JSON.stringify({ items: capped, incomplete: capped.length < items.length || (Array.isArray(r) ? !1 : !!r?.isIncomplete) }));
  }), handle("lsp.diagnostics", async ({ path }) => {
    let lang = langOfPath(path), d = (lang ? serverOf(lang, path) : null)?.diagnostics.get(norm(path));
    if (!d) return { version: -1, items: [] };
    let envelope = (items) => ({ version: d.version, items });
    return envelope(limitItems(d.items.slice(0, 2e3).map((x) => ({ ...x, message: String(x.message).slice(0, 500) })), envelope));
  }), handle("lsp.serverInfo", async ({ path }) => {
    let srv = await serverForPath(path);
    return { lang: srv.lang, server: SERVER_LABEL[srv.lang], root: srv.root, detail: srv.detail };
  }), handle("lsp.restart", async ({ path }) => {
    let lang = langOfPath(path), srv = lang ? serverOf(lang, path) : null;
    return srv && stopServer(srv), { detail: (await serverForPath(path)).detail };
  }), handle("lsp.interpreters", async ({ path }) => {
    let srv = await serverForPath(path);
    if (srv.lang !== "python") return { root: srv.root, current: null, list: [] };
    let list = await interpretersFor(srv.root, path);
    return JSON.parse(JSON.stringify({ root: srv.root, current: srv.interpreter, list }));
  }), handle("lsp.setInterpreter", async ({ path, interpreter }) => {
    let srv = await serverForPath(path);
    if (srv.lang !== "python") return { current: null };
    let saved = await savedInterpreters();
    return interpreter ? saved[norm(srv.root)] = interpreter : delete saved[norm(srv.root)], await host.storageSet(SAVED_KEY, saved), srv.interpreter = (await interpretersFor(srv.root, path))[0] ?? null, srv.client.notify("workspace/didChangeConfiguration", { settings: {} }), host.log(`interpreter for ${srv.root} -> ${srv.interpreter?.path ?? "none"} [${srv.interpreter?.source ?? "-"}]`), JSON.parse(JSON.stringify({ current: srv.interpreter }));
  }), handle("lsp.semanticTokens", async ({ path }) => {
    let srv = await serverForPath(path);
    if (!srv.legend) return { legend: null, data: [] };
    let r = await srv.client.request("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(path) } }, 2e4).catch(() => null), data = Array.isArray(r?.data) ? r.data : [], groups = [];
    for (let i = 0; i + 4 < data.length && i < 15e4; i += 5) groups.push(data.slice(i, i + 5));
    return { legend: srv.legend, data: limitItems(groups, (groups2) => ({ legend: srv.legend, data: groups2.flat() })).flat() };
  }), handle("lsp.peek", async ({ path, line }) => {
    if (!peekable.has(norm(path))) return { text: "", lang: null };
    let lang = langOfPath(path) ?? "cpp", LIMIT = 3e5, text, live = serverOf(lang, path)?.open.has(norm(path));
    try {
      text = (live ? docs.get(norm(path)) : void 0) ?? readFileSync2(path, "utf8");
    } catch {
      return { text: "", lang };
    }
    if (jsonBytes({ text, lang }) <= 7e5) return { text, lang };
    let lines = text.split(`
`), at = Math.max(0, Math.min(lines.length - 1, line ?? 0)), from = at, to = at, size = lines[at].length;
    for (; size < LIMIT - lines.length && (from > 0 || to < lines.length - 1); )
      to < lines.length - 1 && (to++, size += lines[to].length + 1), from > 0 && size < LIMIT - lines.length && (from--, size += lines[from].length + 1);
    let windowText = lines.map((l, i) => i >= from && i <= to ? l : "").join(`
`);
    for (; jsonBytes({ text: windowText, lang, window: [from, to] }) > 7e5 && from < to; )
      at - from > to - at ? from++ : to--, windowText = lines.map((l, i) => i >= from && i <= to ? l : "").join(`
`);
    return jsonBytes({ text: windowText, lang, window: [from, to] }) > 7e5 ? { text: "", lang, truncated: !0 } : { text: windowText, lang, window: [from, to] };
  }), handle("lsp.reveal", async ({ path, line }) => {
    let result = host.reveal ? await host.reveal(path, line) : { opened: !1, reason: "no-host" };
    return host.log(`[navigation] reveal ${path}:${line} opened=${result.opened}${result.reason ? ` reason=${result.reason}` : ""}`), result;
  }), { handlers, workspaceRemoved, shutdown: () => {
    for (let s of [...servers.values()]) stopServer(s);
  } };
}

// src/agent.ts
var AGENT_VERSION = "0.1.0", HOME = join5(homedir3(), ".orca-qt-lsp");
mkdirSync2(HOME, { recursive: !0 });
process.env.QT_LSP_DIR ??= HOME;
var out = (o) => process.stdout.write(JSON.stringify(o) + `
`), log = (m) => out({ log: m }), settings = {}, statePath = join5(HOME, `state-${PLUGIN_ID}.json`), readState = () => {
  try {
    return JSON.parse(readFileSync3(statePath, "utf8"));
  } catch {
    return {};
  }
}, orcaRoots = { at: 0, list: [] };
function orcaWorkspaces() {
  if (Date.now() - orcaRoots.at < 6e4) return orcaRoots.list;
  let list = [];
  try {
    let cli = process.platform === "win32" ? join5(process.env.LOCALAPPDATA ?? join5(homedir3(), "AppData", "Local"), "Programs", "orca", "resources", "bin", "orca.exe") : process.platform === "darwin" ? "/Applications/Orca.app/Contents/Resources/bin/orca" : "";
    if (!cli || !existsSync4(cli)) throw new Error("no orca");
    let r = spawnSync(cli, ["worktree", "list", "--json"], { encoding: "utf8", timeout: 15e3, maxBuffer: 64 << 20, windowsHide: !0 });
    list = (JSON.parse(r.stdout || "{}").result?.worktrees ?? []).filter((w) => !w.hostId || w.hostId === "local").map((w) => String(w.path));
  } catch {
  }
  return orcaRoots = { at: Date.now(), list }, list;
}
var usedRoots = new Set(readState().roots ?? []);
function rootsOf(hints) {
  let fromSetting = String(settings.remoteRoots ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean), list = [...hints ?? [], ...usedRoots, ...fromSetting, ...orcaWorkspaces(), homedir3()].filter((r) => r && existsSync4(r));
  return { focused: list[0] ?? null, roots: [...new Set(list)] };
}
var installPyright2 = void 0, core = createCore({
  log,
  post: (ev, p) => out({ ev, p }),
  setting: async (k, fallback) => settings[k] ?? fallback,
  storageGet: async (k) => readState()[k],
  storageSet: async (k, v) => {
    let s = readState();
    s[k] = v, writeFileSync2(statePath, JSON.stringify(s));
  },
  roots: async (hints) => rootsOf(hints),
  installPyright: installPyright2
}), rl = createInterface({ input: process.stdin, crlfDelay: 1 / 0 }), identified = !1;
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
      if (msg.p?.language !== "cpp" || msg.p?.pluginId !== PLUGIN_ID) throw new Error("Remote agent language/profile identity mismatch");
      identified = !0, settings = msg.p?.settings ?? {}, out({ id: msg.id, r: { version: AGENT_VERSION, platform: process.platform, node: process.version, home: HOME, language: "cpp", pluginId: PLUGIN_ID } });
      return;
    }
    if (!identified) throw new Error("Remote agent identity handshake required");
    if (msg.m === "$roots") {
      for (let r2 of msg.p?.roots ?? []) typeof r2 == "string" && usedRoots.add(r2);
      let state = readState();
      state.roots = [...usedRoots].slice(-30), writeFileSync2(statePath, JSON.stringify(state)), out({ id: msg.id, r: null });
      return;
    }
    let h = core.handlers[msg.m];
    if (!h) {
      out({ id: msg.id, e: `unknown method ${msg.m}` });
      return;
    }
    let r = await h(msg.p);
    if (msg.m === "lsp.attach" && r?.ok && r.workspace) {
      usedRoots.add(r.workspace);
      let s = readState();
      s.roots = [...usedRoots].slice(-30), writeFileSync2(statePath, JSON.stringify(s));
    }
    out({ id: msg.id, r: r ?? null });
  } catch (e) {
    out({ id: msg.id, e: e instanceof Error ? e.message : String(e) });
  }
});
rl.on("close", () => {
  core.shutdown(), setTimeout(() => process.exit(0), 1500);
});
log(`agent ${AGENT_VERSION} ready on ${process.platform} ${process.version}`);
export {
  AGENT_VERSION
};
