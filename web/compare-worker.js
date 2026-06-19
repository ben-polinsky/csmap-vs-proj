const defaultOptions = {
  nativeCompareUrl: "/api/compare",
  wasmAssetBaseUrl: "/wasm/",
  wasmRuntimeUrl: "/wasm/compare-runtime.js",
};

let runtimeCacheKey = "";
let runtimePromise;
let runtimeUnavailableReason;
let manifestPromise;

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!isCompareMessage(message)) return;

  void handleCompare(message);
});

async function handleCompare(message) {
  const options = normalizeOptions(message.options);

  try {
    const wasmRuntime = await getWasmRuntime(options);
    if (wasmRuntime) {
      try {
        const result = await wasmRuntime.compare(message.request);
        postResult(message.id, withRuntime(result, "wasm", undefined, options.wasmRuntimeUrl));
        return;
      } catch (error) {
        runtimeUnavailableReason = `WASM compare failed: ${errorMessage(error)}`;
      }
    }

    const result = await fetchNativeCompare(message.request, options.nativeCompareUrl);
    postResult(message.id, withRuntime(result, "native", runtimeUnavailableReason, options.wasmRuntimeUrl));
  } catch (error) {
    postError(message.id, errorMessage(error));
  }
}

async function getWasmRuntime(options) {
  if (typeof WebAssembly === "undefined") {
    runtimeUnavailableReason = "WebAssembly is not available";
    return undefined;
  }

  if (!options.wasmRuntimeUrl) {
    runtimeUnavailableReason = "No WASM runtime URL is configured";
    return undefined;
  }

  const runtimeUrl = absoluteUrl(options.wasmRuntimeUrl);
  const cacheKey = `${runtimeUrl}\n${absoluteUrl(options.wasmAssetBaseUrl)}`;
  if (runtimePromise && runtimeCacheKey === cacheKey) {
    return runtimePromise;
  }

  runtimeCacheKey = cacheKey;
  runtimeUnavailableReason = undefined;
  runtimePromise = loadWasmRuntime(options, runtimeUrl).catch((error) => {
    runtimeUnavailableReason = `WASM runtime unavailable: ${errorMessage(error)}`;
    return undefined;
  });

  return runtimePromise;
}

async function loadWasmRuntime(options, runtimeUrl) {
  const runtimeModule = await import(runtimeUrl);
  const candidate = await instantiateRuntime(runtimeModule, options);
  const compare = compareFunction(candidate) ?? compareFunction(runtimeModule);

  if (!compare) {
    throw new Error("WASM runtime must export compare(request) or a factory that returns it");
  }

  return { compare };
}

async function instantiateRuntime(runtimeModule, options) {
  const factory =
    runtimeModule.createCompareRuntime ??
    runtimeModule.createRuntime ??
    runtimeModule.default;

  if (typeof factory !== "function") {
    return runtimeModule;
  }

  return factory({
    assetBaseUrl: absoluteUrl(options.wasmAssetBaseUrl),
    locateFile: (fileName) => absoluteUrl(fileName, options.wasmAssetBaseUrl),
  });
}

function compareFunction(candidate) {
  if (typeof candidate === "function") {
    return candidate;
  }

  if (candidate && typeof candidate === "object" && typeof candidate.compare === "function") {
    return (request) => candidate.compare(request);
  }

  if (candidate && typeof candidate === "object" && typeof candidate._compare_json === "function") {
    return async (request) => compareWithEmscripten(candidate, request);
  }

  return undefined;
}

async function compareWithEmscripten(module, request) {
  const firstResult = callCompareJson(module, request);
  const missing = missingResourceText(firstResult);
  if (!missing) return firstResult;

  const loaded = await hydrateMissingResource(module, missing);
  if (!loaded) return firstResult;

  return callCompareJson(module, request);
}

function callCompareJson(module, request) {
  const payload = JSON.stringify({ ...request, csmapDict: "/csmap", projData: "/proj" });
  const length = module.lengthBytesUTF8(payload) + 1;
  const inputPtr = module._malloc(length);
  let resultPtr = 0;

  try {
    module.stringToUTF8(payload, inputPtr, length);
    resultPtr = module._compare_json(inputPtr);
    if (!resultPtr) throw new Error("WASM compare returned a null result");

    return JSON.parse(module.UTF8ToString(resultPtr));
  } finally {
    if (resultPtr) module._free_result(resultPtr);
    module._free(inputPtr);
  }
}

function missingResourceText(result) {
  const text = [
    result?.fatal,
    result?.csmap?.error,
    result?.proj?.error,
    result?.targetExtent?.error,
  ]
    .filter(Boolean)
    .join("\n");

  return /missing|not found|no such file|failed to open|could not open|grid/i.test(text) ? text : "";
}

async function hydrateMissingResource(module, message) {
  if (!module.FS) return false;

  const manifest = await loadManifest();
  const candidates = lazyManifestEntries(manifest);
  const match = candidates.find((entry) => resourceMessageMatches(message, entry));
  if (!match) return false;

  const response = await fetch(match.url);
  if (!response.ok) return false;

  const bytes = new Uint8Array(await response.arrayBuffer());
  const virtualPath = `${match.root}/${match.path}`;
  ensureVirtualDir(module.FS, virtualPath.slice(0, virtualPath.lastIndexOf("/")));
  module.FS.writeFile(virtualPath, bytes);
  return true;
}

function lazyManifestEntries(manifest) {
  const entries = [];

  for (const entry of manifest?.csmap?.lazy ?? []) {
    pushLazyEntry(entries, entry, "/csmap");
  }

  for (const pack of manifest?.csmap?.lazyGridPacks ?? []) {
    for (const entry of pack.files ?? []) {
      pushLazyEntry(entries, entry, "/csmap");
    }
  }

  for (const entry of manifest?.proj?.lazy ?? manifest?.proj?.lazyFiles ?? []) {
    pushLazyEntry(entries, entry, "/proj");
  }

  return entries;
}

function pushLazyEntry(entries, entry, root) {
  const resourcePath = resourcePathForEntry(entry);
  if (!resourcePath || !entry?.url) return;
  entries.push({ root, path: resourcePath, url: entry.url });
}

function resourcePathForEntry(entry) {
  return String(entry?.path ?? entry?.dictionaryPath ?? entry?.name ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function resourceMessageMatches(message, entry) {
  const normalizedMessage = String(message).replace(/\\/g, "/").toLowerCase();
  const normalizedPath = entry.path.toLowerCase();
  return normalizedMessage.includes(normalizedPath) || normalizedMessage.includes(fileName(normalizedPath));
}

async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch("/wasm-data/manifest.json")
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
  }
  return manifestPromise;
}

function ensureVirtualDir(fs, dirPath) {
  const parts = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      fs.mkdir(current);
    } catch {
      // Existing directories are fine; Emscripten throws for them.
    }
  }
}

function fileName(value) {
  return String(value).split(/[\\/]/).pop() ?? String(value);
}

async function fetchNativeCompare(request, nativeCompareUrl) {
  const response = await fetch(nativeCompareUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || `comparison failed with HTTP ${response.status}`);
  }

  return data;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function withRuntime(result, source, fallbackReason, runtimeUrl) {
  if (!result || typeof result !== "object") {
    return {
      fatal: "comparison did not return an object",
      runtime: { fallbackReason, runtimeUrl, source },
    };
  }

  return {
    ...result,
    runtime: { fallbackReason, runtimeUrl, source },
  };
}

function normalizeOptions(options) {
  const record = options && typeof options === "object" ? options : {};

  return {
    nativeCompareUrl: stringOption(record.nativeCompareUrl, defaultOptions.nativeCompareUrl),
    wasmAssetBaseUrl: trailingSlash(stringOption(record.wasmAssetBaseUrl, defaultOptions.wasmAssetBaseUrl)),
    wasmRuntimeUrl: stringOption(record.wasmRuntimeUrl, defaultOptions.wasmRuntimeUrl),
  };
}

function stringOption(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function trailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function absoluteUrl(value, base = self.location.href) {
  return new URL(value, new URL(base, self.location.href)).toString();
}

function isCompareMessage(value) {
  if (!value || typeof value !== "object") return false;

  const record = value;
  return record.type === "compare" && typeof record.id === "number" && !!record.request;
}

function postResult(id, result) {
  self.postMessage({ id, type: "result", result });
}

function postError(id, error) {
  self.postMessage({ id, type: "error", error });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
