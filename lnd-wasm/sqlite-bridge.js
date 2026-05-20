// Main-thread bridge between Go WASM and the dedicated SQLite oo1 worker.

(() => {
  const bridgeProtocolVersion = 1;
  const expectedWorkerProtocolVersion = 1;
  let worker = null;
  let nextRequestId = 1;
  let initPromise = null;
  const pending = new Map();
  const bridgeScriptURL = globalThis.document?.currentScript?.src || "";

  function workerURL(override) {
    if (override) return override;
    if (globalThis.sqliteBridgeWorkerURL) return globalThis.sqliteBridgeWorkerURL;
    if (bridgeScriptURL) return new URL("sqlite-worker.js", bridgeScriptURL).href;
    return "sqlite-worker.js";
  }

  function ensureWorker(override) {
    if (worker) return;

    worker = new Worker(workerURL(override));
    worker.onmessage = (event) => {
      const message = event.data || {};
      const waiter = pending.get(message.id);
      if (!waiter) return;

      pending.delete(message.id);
      if (message.ok) {
        waiter.resolve(message.result || {});
      } else {
        waiter.reject(new Error(message.error || "sqlite worker request failed"));
      }
    };
    worker.onerror = (event) => {
      const err = new Error(event.message || "sqlite worker error");
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    };
  }

  function request(method, args = {}, transfer = []) {
    if (!worker) throw new Error("SQLite worker is not initialized");

    const id = nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, method, args }, transfer);
    return promise;
  }

  globalThis.sqliteBridge = {
    protocolVersion: bridgeProtocolVersion,

    async init(options = {}) {
      ensureWorker(options.workerURL);
      if (!initPromise) {
        initPromise = request("init", {
          sqliteJSURL: options.sqliteJSURL || globalThis.sqliteBridgeSQLiteJSURL || "",
          expectedBridgeProtocolVersion: bridgeProtocolVersion
        }).then((result) => {
          if (result.workerProtocolVersion !== expectedWorkerProtocolVersion) {
            throw new Error(`SQLite worker protocol mismatch: expected ${expectedWorkerProtocolVersion}, got ${result.workerProtocolVersion}`);
          }
          console.log("SQLite oo1 worker initialized:", result.version?.libVersion || "unknown");
          return { ok: true, bridgeProtocolVersion, ...result };
        });
      }
      return initPromise;
    },

    async open(optionsOrFilename = {}, maybeVFS = "opfs") {
      await globalThis.sqliteBridge.init();

      let options = optionsOrFilename;
      if (typeof optionsOrFilename === "string") {
        options = { file: optionsOrFilename, vfs: maybeVFS };
      }

      const result = await request("open", options || {});
      return {
        ok: true,
        dbId: result.dbId,
        filename: result.filename,
        vfsType: result.vfs,
        resolvedVFS: result.vfs,
        persistent: !!result.persistent
      };
    },

    async exec(dbId, sql, params = []) {
      const result = await request("exec", { dbId, sql, params });
      return { ok: true, ...result };
    },

    async query(dbId, sql, params = []) {
      const result = await request("query", { dbId, sql, params });
      return {
        ok: true,
        columns: result.columnNames || [],
        rows: result.resultRows || []
      };
    },

    async begin(dbId) {
      await request("begin", { dbId });
      return { ok: true };
    },

    async commit(dbId) {
      await request("commit", { dbId });
      return { ok: true };
    },

    async rollback(dbId) {
      await request("rollback", { dbId });
      return { ok: true };
    },

    async close(dbId) {
      await request("close", { dbId });
      return { ok: true };
    },

    async dump(dbId) {
      const result = await request("dump", { dbId });
      return { ok: true, dump: result.dump || "" };
    },

    async load(dbId, sql) {
      await request("load", { dbId, sql });
      return { ok: true };
    }
  };
})();
