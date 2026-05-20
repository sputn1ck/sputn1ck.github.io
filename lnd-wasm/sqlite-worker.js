// Dedicated SQLite worker using the supported sqlite3.oo1 API directly.

const workerProtocolVersion = 1;
let sqlite3;
let nextDbId = 1;
const dbs = new Map();
const openOPFSFiles = new Map();
let sqliteJSURL = "sqlite3.js";

function normalizeError(error) {
  if (!error) return "unknown sqlite worker error";
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  return String(error);
}

function vfsList() {
  return sqlite3.capi.sqlite3_js_vfs_list();
}

function hasVFS(name) {
  return !!sqlite3.capi.sqlite3_vfs_find(name);
}

async function ensureSQLite(options = {}) {
  if (sqlite3) return sqlite3;

  sqliteJSURL = options.sqliteJSURL || sqliteJSURL;
  importScripts(sqliteJSURL);
  sqlite3 = await sqlite3InitModule();

  if (sqlite3.installOpfsSAHPoolVfs && !hasVFS("opfs-sahpool")) {
    await sqlite3.installOpfsSAHPoolVfs({ name: "opfs-sahpool" }).catch((error) => {
      sqlite3.config.warn("Ignoring inability to install opfs-sahpool:", error.message);
    });
  }

  return sqlite3;
}

function openFlags(mode) {
  switch ((mode || "rwc").toLowerCase()) {
    case "ro":
      return "r";
    case "rw":
      return "w";
    case "rwc":
    case "memory":
    default:
      return "c";
  }
}

function normalizeFilename(file) {
  if (!file || file === ":memory:") return ":memory:";
  return file;
}

function normalizeRequestedVFS(vfs) {
  switch ((vfs || "auto").toLowerCase()) {
    case "":
    case "auto":
    case "opfs-auto":
      return "auto";
    case "opfs-sah":
    case "sahpool":
      return "opfs-sahpool";
    default:
      return vfs;
  }
}

function normalizeOPFSFilename(file) {
  if (file.startsWith("/") || file.startsWith("file:")) return file;
  return `/${file}`;
}

function makeURI(filename, params) {
  const pairs = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!pairs.length) return filename;
  const sep = filename.includes("?") ? "&" : "?";
  return `${filename}${sep}${pairs.join("&")}`;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const byte of value) hex += byte.toString(16).padStart(2, "0");
    return `X'${hex}'`;
  }
  if (value instanceof ArrayBuffer) return sqlLiteral(new Uint8Array(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeValue(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "__wasmSqliteInt64")) {
    return BigInt(value.__wasmSqliteInt64);
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
    return value.toString();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function stripParamPrefix(name) {
  return String(name || "").replace(/^[:@$]/, "");
}

function normalizeNamedParams(stmt, params) {
  const normalized = Object.create(null);
  const usedKeys = new Set();

  for (let i = 1; i <= stmt.parameterCount; i++) {
    const bindName = stmt.getParamName(i);
    if (!bindName) continue;

    const bareName = stripParamPrefix(bindName);
    let value;
    let matchedKey = "";
    for (const candidate of [bindName, bareName, `:${bareName}`, `$${bareName}`, `@${bareName}`]) {
      if (Object.prototype.hasOwnProperty.call(params, candidate)) {
        value = params[candidate];
        matchedKey = candidate;
        break;
      }
    }
    if (!matchedKey) {
      throw new Error(`missing named SQL parameter: ${bindName}`);
    }

    normalized[bindName] = normalizeValue(value);
    usedKeys.add(matchedKey);
  }

  for (const key of Object.keys(params)) {
    if (!usedKeys.has(key)) {
      throw new Error(`unused named SQL parameter: ${key}`);
    }
  }

  return normalized;
}

function numericParamIndex(name) {
  const match = String(name || "").match(/^[:@$?]([1-9][0-9]*)$/);
  if (!match) return 0;
  return Number(match[1]);
}

function normalizePositionalParams(stmt, params) {
  if (!params.length) return params;

  const normalized = [];
  const usedParamIndexes = new Set();

  for (let i = 1; i <= stmt.parameterCount; i++) {
    const bindName = stmt.getParamName(i);
    const numericIndex = numericParamIndex(bindName);
    const paramIndex = numericIndex ? numericIndex - 1 : i - 1;

    if (paramIndex < 0 || paramIndex >= params.length) {
      throw new Error(`missing SQL parameter for ${bindName || `?${i}`}`);
    }

    normalized.push(normalizeValue(params[paramIndex]));
    usedParamIndexes.add(paramIndex);
  }

  for (let i = 0; i < params.length; i++) {
    if (!usedParamIndexes.has(i)) {
      throw new Error(`unused SQL parameter at index ${i + 1}`);
    }
  }

  return normalized;
}

function bindParams(stmt, params) {
  if (!params) return;
  if (Array.isArray(params)) {
    if (!params.length) return;
    stmt.bind(normalizePositionalParams(stmt, params));
    return;
  }

  if (typeof params === "object") {
    const keys = Object.keys(params);
    if (!keys.length) return;
    stmt.bind(normalizeNamedParams(stmt, params));
    return;
  }

  throw new Error("invalid SQL parameter container");
}

function getDB(dbId) {
  const db = dbs.get(dbId);
  if (!db) throw new Error(`database is not open: ${dbId}`);
  return db;
}

function runQuery(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    bindParams(stmt, params);
    const columnNames = stmt.columnCount ? stmt.getColumnNames([]) : [];
    const resultRows = [];
    while (stmt.step()) {
      const row = stmt.get([]);
      resultRows.push(row.map(normalizeValue));
    }
    return { columnNames, resultRows };
  } finally {
    stmt.finalize();
  }
}

function runExec(db, sql, params) {
  const beforeChanges = db.changes(true);
  if (params && !Array.isArray(params) && Object.keys(params).length) {
    const stmt = db.prepare(sql);
    try {
      bindParams(stmt, params);
      while (stmt.step()) {}
    } finally {
      stmt.finalize();
    }
  } else {
    const options = { sql };
    if (params && params.length) options.bind = params.map(normalizeValue);
    db.exec(options);
  }

  return {
    rowsAffected: db.changes(true) - beforeChanges,
    lastInsertId: Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer))
  };
}

async function init(args = {}) {
  if (args.expectedBridgeProtocolVersion && args.expectedBridgeProtocolVersion !== workerProtocolVersion) {
    throw new Error(`SQLite bridge protocol mismatch: expected ${workerProtocolVersion}, got ${args.expectedBridgeProtocolVersion}`);
  }
  await ensureSQLite(args);
  return { version: sqlite3.version, vfsList: vfsList(), workerProtocolVersion };
}

async function openPersistentDB(vfsName, filename, uriParams, args) {
  if (vfsName === "opfs-sahpool" && sqlite3.installOpfsSAHPoolVfs && !hasVFS("opfs-sahpool")) {
    await sqlite3.installOpfsSAHPoolVfs({ name: "opfs-sahpool" });
  }
  if (!hasVFS(vfsName)) {
    throw new Error(`requested SQLite VFS is unavailable: ${vfsName}`);
  }

  let resolvedFilename = normalizeOPFSFilename(filename);
  const resolved = makeURI(resolvedFilename, uriParams);
  const duplicateKey = `opfs:${resolved}`;
  if (openOPFSFiles.has(duplicateKey)) {
    throw new Error(`OPFS database already open in this worker: ${resolved}`);
  }

  let db;
  if (vfsName === "opfs" && sqlite3.oo1.OpfsDb) {
    db = new sqlite3.oo1.OpfsDb(resolved, openFlags(args.mode));
  } else {
    db = new sqlite3.oo1.DB({ filename: resolved, flags: openFlags(args.mode), vfs: vfsName });
  }

  resolvedFilename = db.dbFilename();
  const vfs = db.dbVfsName() || vfsName;
  openOPFSFiles.set(duplicateKey, true);
  db.__opfsKey = duplicateKey;

  return { db, filename: resolvedFilename, vfs, persistent: true };
}

function openMemoryDB(args) {
  if (args.requirePersistent) {
    throw new Error("persistent storage required but memory VFS was requested");
  }
  return {
    db: new sqlite3.oo1.DB(":memory:", openFlags(args.mode)),
    filename: ":memory:",
    vfs: "memory",
    persistent: false
  };
}

async function open(args) {
  await ensureSQLite();

  const requestedVFS = normalizeRequestedVFS(args.vfs);
  let filename = normalizeFilename(args.file || args.filename || "/app.db");
  let opened;

  const uriParams = {};
  if (args.cache) uriParams.cache = args.cache;

  if (filename === ":memory:" || requestedVFS === "memory") {
    opened = openMemoryDB(args);
  } else {
    const candidates = requestedVFS === "auto"
      ? ["opfs-wl", "opfs-sahpool", "opfs"]
      : [requestedVFS];
    const failures = [];
    for (const candidate of candidates) {
      try {
        opened = await openPersistentDB(candidate, filename, uriParams, args);
        break;
      } catch (error) {
        failures.push(`${candidate}: ${error.message || String(error)}`);
        if (/already open/i.test(error.message || "")) {
          throw error;
        }
        if (requestedVFS !== "auto") {
          if (requestedVFS === "opfs" && !args.requirePersistent) {
            sqlite3.config.warn("OPFS VFS unavailable, falling back to :memory:", error.message || String(error));
            opened = openMemoryDB(args);
            break;
          }
          throw error;
        }
      }
    }
    if (!opened) {
      if (args.requirePersistent) {
        throw new Error(`persistent storage required but no OPFS VFS opened; tried ${failures.join("; ")}`);
      }
      sqlite3.config.warn("OPFS VFS unavailable, falling back to :memory:", failures.join("; "));
      opened = openMemoryDB(args);
    }
  }

  if (args.busyTimeout > 0) {
    sqlite3.capi.sqlite3_busy_timeout(opened.db.pointer, args.busyTimeout);
  }
  if (args.journalMode) {
    opened.db.exec(`PRAGMA journal_mode=${args.journalMode}`);
  }
  for (const pragma of args.pragma || []) {
    if (pragma) opened.db.exec(`PRAGMA ${pragma}`);
  }

  const dbId = `db${nextDbId++}`;
  dbs.set(dbId, opened.db);

  return { dbId, filename: opened.filename, vfs: opened.vfs, persistent: opened.persistent };
}

async function exec(args) {
  const db = getDB(args.dbId);
  return runExec(db, args.sql, args.params || []);
}

async function query(args) {
  const db = getDB(args.dbId);
  return runQuery(db, args.sql, args.params || []);
}

async function begin(args) {
  getDB(args.dbId).exec("BEGIN IMMEDIATE");
  return {};
}

async function commit(args) {
  getDB(args.dbId).exec("COMMIT");
  return {};
}

async function rollback(args) {
  getDB(args.dbId).exec("ROLLBACK");
  return {};
}

async function close(args) {
  const db = dbs.get(args.dbId);
  if (!db) return {};

  if (db.__opfsKey) openOPFSFiles.delete(db.__opfsKey);
  db.close();
  dbs.delete(args.dbId);
  return {};
}

async function dump(args) {
  const db = getDB(args.dbId);
  let dumpSQL = "BEGIN TRANSACTION;\n";

  const schemaRows = runQuery(
    db,
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, type DESC, name",
    []
  ).resultRows;
  for (const row of schemaRows) {
    dumpSQL += `${row[3]};\n`;
  }

  const tableRows = runQuery(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    []
  ).resultRows;
  for (const [tableName] of tableRows) {
    const columns = runQuery(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`, [])
      .resultRows
      .map((row) => row[1]);
    const rows = runQuery(db, `SELECT * FROM ${quoteIdentifier(tableName)}`, []).resultRows;
    for (const row of rows) {
      dumpSQL += `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${row.map(sqlLiteral).join(", ")});\n`;
    }
  }

  dumpSQL += "COMMIT;\n";
  return { dump: dumpSQL };
}

async function load(args) {
  const db = getDB(args.dbId);
  const tables = runQuery(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    []
  ).resultRows;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    for (const [tableName] of tables) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
    }
    db.exec(args.sql || "");
  } catch (error) {
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  return {};
}

const methods = { init, open, exec, query, begin, commit, rollback, close, dump, load };

globalThis.onmessage = async (event) => {
  const message = event.data || {};
  try {
    const method = methods[message.method];
    if (!method) throw new Error(`unknown sqlite worker method: ${message.method}`);
    const result = await method(message.args || {});
    globalThis.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    globalThis.postMessage({ id: message.id, ok: false, error: normalizeError(error) });
  }
};
