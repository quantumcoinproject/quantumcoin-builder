/* eslint-disable */
/*
 * QuantumCoin Platform Builder — Solidity 7.6 compiler worker (PD §6).
 *
 * Classic Web Worker. Loads the vendored, same-origin soljson compiler via
 * importScripts and exposes a tiny request/response protocol:
 *   { id, type: 'ping' }    -> { id, type: 'pong' }  (after soljson is ready)
 *   { id, type: 'compile', sources, settings } -> { id, type: 'result' | 'error' }
 *
 * The compiler is NEVER fetched from the network at runtime — only the vendored
 * same-origin asset is used (worker-src 'self' per CSP).
 */

var SOLJSON_URL = "assets/compilers/soljson-v32b.8.12.js";
var readyPromise = null;
var compileFn = null;

function loadSoljson() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        reject(new Error("Compiler runtime did not initialize in time"));
      }
    }, 60000);

    // Emscripten module hook — set before importScripts.
    self.Module = {
      print: function () {},
      printErr: function () {},
      onRuntimeInitialized: function () {
        try {
          compileFn = makeCompile(self.Module);
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (e) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(e);
          }
        }
      },
    };

    try {
      importScripts(SOLJSON_URL);
    } catch (e) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error("Failed to load compiler asset: " + (e && e.message ? e.message : e)));
      }
      return;
    }

    // Fallback: some soljson builds are already initialized synchronously after
    // importScripts (or never call onRuntimeInitialized). Poll for cwrap.
    var poll = setInterval(function () {
      if (settled) {
        clearInterval(poll);
        return;
      }
      if (self.Module && typeof self.Module.cwrap === "function" && (self.Module.calledRun || self.Module._solidity_compile)) {
        try {
          compileFn = makeCompile(self.Module);
          settled = true;
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        } catch (_) {
          /* keep polling until timeout */
        }
      }
    }, 50);
  });
  return readyPromise;
}

function makeCompile(Module) {
  // Newer soljson: solidity_compile(input, callbackPtr). callbackPtr 0 == no
  // import callback (all sources are provided inline, so relative imports resolve).
  if ("_solidity_compile" in Module || typeof Module.cwrap === "function") {
    try {
      var c = Module.cwrap("solidity_compile", "string", ["string", "number"]);
      return function (input) {
        return c(input, 0);
      };
    } catch (_) {
      /* fall through to legacy */
    }
  }
  if (typeof Module.compileStandard === "function") {
    return function (input) {
      return Module.compileStandard(input);
    };
  }
  if (typeof Module.compile === "function") {
    return function (input) {
      return Module.compile(input);
    };
  }
  throw new Error("Unsupported soljson build: no compile entry point found");
}

function lineColFromOffset(source, offset) {
  if (typeof offset !== "number" || offset < 0) return { line: 1, column: 1 };
  var line = 1;
  var lastNl = -1;
  for (var i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line: line, column: offset - lastNl };
}

function mapDiagnostics(output, sources) {
  var diags = [];
  var errorCount = 0;
  var warningCount = 0;
  var errors = output.errors || [];
  for (var i = 0; i < errors.length; i++) {
    var e = errors[i];
    var severity = e.severity === "error" ? "error" : e.severity === "warning" ? "warning" : null;
    if (!severity) continue; // skip 'info'
    if (severity === "error") errorCount++;
    else warningCount++;

    var loc = e.sourceLocation || {};
    var file = loc.file || (e.sourceLocation && e.sourceLocation.file) || firstKey(sources) || "";
    var src = sources[file] || "";
    var startPos = lineColFromOffset(src, loc.start);
    var diag = {
      file: file,
      line: startPos.line,
      column: startPos.column,
      severity: severity,
      message: e.message || e.formattedMessage || "Compilation diagnostic",
    };
    if (typeof loc.end === "number" && loc.end >= 0) {
      var endPos = lineColFromOffset(src, loc.end);
      diag.endLine = endPos.line;
      diag.endColumn = endPos.column;
    }
    diags.push(diag);
  }
  return { diagnostics: diags, errorCount: errorCount, warningCount: warningCount };
}

function firstKey(obj) {
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) return k;
  return null;
}

function with0x(hex) {
  if (!hex) return "";
  return hex.indexOf("0x") === 0 ? hex : "0x" + hex;
}

function extractContracts(output) {
  var result = [];
  var contracts = output.contracts || {};
  for (var file in contracts) {
    if (!Object.prototype.hasOwnProperty.call(contracts, file)) continue;
    var byName = contracts[file];
    for (var name in byName) {
      if (!Object.prototype.hasOwnProperty.call(byName, name)) continue;
      var c = byName[name];
      var evm = c.evm || {};
      result.push({
        contractName: name,
        abi: c.abi || [],
        bytecode: with0x(evm.bytecode && evm.bytecode.object ? evm.bytecode.object : ""),
        deployedBytecode: with0x(evm.deployedBytecode && evm.deployedBytecode.object ? evm.deployedBytecode.object : ""),
        metadata: c.metadata || "",
        sourcePath: file,
      });
    }
  }
  return result;
}

function buildStandardInput(sources, settings) {
  var inputSources = {};
  for (var path in sources) {
    if (Object.prototype.hasOwnProperty.call(sources, path)) {
      inputSources[path] = { content: sources[path] };
    }
  }
  var s = settings || {};
  var input = {
    language: "Solidity",
    sources: inputSources,
    settings: {
      optimizer: {
        enabled: s.optimizer ? !!s.optimizer.enabled : true,
        runs: s.optimizer && s.optimizer.runs ? s.optimizer.runs : 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };
  if (s.evmVersion) input.settings.evmVersion = s.evmVersion;
  if (Array.isArray(s.remappings) && s.remappings.length) {
    input.settings.remappings = s.remappings.slice();
  }
  return input;
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  var id = msg.id;

  if (msg.type === "ping") {
    loadSoljson().then(
      function () {
        self.postMessage({ id: id, type: "pong" });
      },
      function (err) {
        self.postMessage({ id: id, type: "error", message: err.message || String(err) });
      }
    );
    return;
  }

  if (msg.type === "compile") {
    self.postMessage({ id: id, type: "progress", stage: "loading-compiler" });
    loadSoljson().then(
      function () {
        try {
          self.postMessage({ id: id, type: "progress", stage: "compiling" });
          var input = buildStandardInput(msg.sources, msg.settings);
          var outStr = compileFn(JSON.stringify(input));
          var output = JSON.parse(outStr);
          var mapped = mapDiagnostics(output, msg.sources);
          var contracts = extractContracts(output);
          self.postMessage({
            id: id,
            type: "result",
            result: {
              contracts: contracts,
              diagnostics: mapped.diagnostics,
              errorCount: mapped.errorCount,
              warningCount: mapped.warningCount,
            },
          });
        } catch (e) {
          self.postMessage({ id: id, type: "error", message: "Compile failed: " + (e && e.message ? e.message : e) });
        }
      },
      function (err) {
        self.postMessage({ id: id, type: "error", message: err.message || String(err) });
      }
    );
    return;
  }

  self.postMessage({ id: id, type: "error", message: "Unknown request type: " + msg.type });
};
