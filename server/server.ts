import { execFile, type ExecFileException } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

type CsrEntry = {
  name: string;
  desc?: string;
  group?: string;
  epsg?: string;
  srid?: string;
  proj?: string;
  unit?: string;
  datum?: string;
  deprecated?: boolean;
};

type CompareRequest = {
  sourceEpsg?: string;
  targetEpsg?: string;
  sourceCsmap: string;
  targetCsmap: string;
  sourceProj: string;
  targetProj: string;
  x: number;
  y: number;
};

const rootDir = path.resolve(__dirname, "../..");
const webDir = path.join(rootDir, "web");
const csmapDictDir = path.join(rootDir, "vendor/csmap/CsMapDev/Dictionaries");
const coordsysPath = path.join(csmapDictDir, "coordsys.asc");
const liveComparePath = path.join(rootDir, "bin/live_compare");

let crsCache: Promise<CsrEntry[]> | undefined;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readCrsEntries(): Promise<CsrEntry[]> {
  if (!crsCache) {
    crsCache = fs.readFile(coordsysPath, "utf8").then(parseCrsEntries);
  }
  return crsCache;
}

function parseCrsEntries(text: string): CsrEntry[] {
  const entries: CsrEntry[] = [];
  let current: CsrEntry | undefined;

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+):\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (key === "CS_NAME") {
      current = { name: value };
      entries.push(current);
      continue;
    }
    if (!current) continue;

    if (key === "DESC_NM") current.desc = value;
    if (key === "GROUP") current.group = value;
    if (key === "EPSG") current.epsg = normalizeEpsgToken(firstToken(value));
    if (key === "SRID") current.srid = firstToken(value);
    if (key === "PROJ") current.proj = value;
    if (key === "UNIT") current.unit = value;
    if (key === "DT_NAME") current.datum = value;
  }

  return entries
    .filter((entry) => entry.name)
    .map((entry) => ({
      ...entry,
      deprecated: isDeprecatedCrs(entry),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function firstToken(value: string): string {
  return value.split(/\s+/)[0] ?? "";
}

function normalizeEpsgToken(value: string): string | undefined {
  const match = value.trim().match(/^(?:EPSG:)?(\d+)$/i);
  if (!match) return undefined;

  const code = Number(match[1]);
  return code > 0 ? String(code) : undefined;
}

function isDeprecatedCrs(entry: CsrEntry): boolean {
  return entry.group === "LEGACY" || /deprecated/i.test(entry.desc ?? "");
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method === "GET" && pathname === "/api/crs") {
    const items = await readCrsEntries();
    sendJson(response, 200, { items });
    return;
  }

  if (request.method === "POST" && pathname === "/api/compare") {
    try {
      const body = await readJsonBody(request);
      const compareRequest = await normalizeCompareRequest(body);
      const result = await runNativeCompare(compareRequest);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(response, 404, { error: "unknown API route" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }

  const payload = Buffer.concat(chunks).toString("utf8");
  if (!payload.trim()) {
    throw new Error("request body is empty");
  }
  return JSON.parse(payload);
}

async function normalizeCompareRequest(body: unknown): Promise<CompareRequest> {
  if (!body || typeof body !== "object") {
    throw new Error("request body must be an object");
  }

  const record = body as Record<string, unknown>;
  const sourceEpsg = optionalEpsg(record.sourceEpsg, "sourceEpsg");
  const targetEpsg = optionalEpsg(record.targetEpsg, "targetEpsg");
  const entries = await readCrsEntries();
  const crsIndex = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const epsgIndex = indexCrsByEpsg(entries);

  let sourceCsmap = optionalString(record.sourceCsmap);
  let targetCsmap = optionalString(record.targetCsmap);
  let sourceProj = normalizeProjCrs(optionalString(record.sourceProj));
  let targetProj = normalizeProjCrs(optionalString(record.targetProj));

  if (sourceEpsg) {
    sourceCsmap ||= bestCrsForEpsg(epsgIndex, sourceEpsg, "sourceEpsg").name;
    sourceProj ||= `EPSG:${sourceEpsg}`;
  }

  if (targetEpsg) {
    targetCsmap ||= bestCrsForEpsg(epsgIndex, targetEpsg, "targetEpsg").name;
    targetProj ||= `EPSG:${targetEpsg}`;
  }

  sourceCsmap ||= requiredString(record.sourceCsmap, "sourceCsmap");
  targetCsmap ||= requiredString(record.targetCsmap, "targetCsmap");
  sourceProj ||= epsgForCrs(crsIndex, sourceCsmap, "sourceProj");
  targetProj ||= epsgForCrs(crsIndex, targetCsmap, "targetProj");

  return {
    sourceEpsg,
    targetEpsg,
    sourceCsmap,
    targetCsmap,
    sourceProj,
    targetProj,
    x: finiteNumber(record.x, "x"),
    y: finiteNumber(record.y, "y"),
  };
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`${field} is required`);
  }
  return parsed;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalEpsg(value: unknown, field: string): string | undefined {
  const parsed = optionalString(value);
  if (!parsed) return undefined;

  const epsg = normalizeEpsgToken(parsed);
  if (!epsg) {
    throw new Error(`${field} must be an EPSG code such as 4326 or EPSG:4326`);
  }
  return epsg;
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number`);
  }
  return parsed;
}

function normalizeProjCrs(value: string): string {
  const epsg = normalizeEpsgToken(value);
  return epsg ? `EPSG:${epsg}` : value;
}

function indexCrsByEpsg(entries: CsrEntry[]): Map<string, CsrEntry[]> {
  const index = new Map<string, CsrEntry[]>();

  for (const entry of entries) {
    if (!entry.epsg) continue;

    const candidates = index.get(entry.epsg) ?? [];
    candidates.push(entry);
    index.set(entry.epsg, candidates);
  }

  for (const candidates of index.values()) {
    candidates.sort(compareCrsCandidates);
  }

  return index;
}

function bestCrsForEpsg(index: Map<string, CsrEntry[]>, epsg: string, field: string): CsrEntry {
  const candidates = index.get(epsg);
  if (!candidates?.length) {
    throw new Error(`${field} could not be resolved because EPSG:${epsg} is not mapped in the CS-MAP dictionary`);
  }
  return candidates[0];
}

function compareCrsCandidates(left: CsrEntry, right: CsrEntry): number {
  return (
    crsCandidateRank(left) - crsCandidateRank(right) ||
    left.name.length - right.name.length ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function crsCandidateRank(entry: CsrEntry): number {
  let rank = 0;
  if (entry.deprecated) rank += 1000;
  if (entry.group === "WKTSUPPT") rank += 100;
  if (entry.srid && entry.epsg && entry.srid === entry.epsg) rank -= 10;
  return rank;
}

function epsgForCrs(crsIndex: Map<string, CsrEntry>, csmapName: string, field: string): string {
  const entry = crsIndex.get(csmapName.toLowerCase());
  if (entry?.epsg) {
    return `EPSG:${entry.epsg}`;
  }
  throw new Error(`${field} is required because ${csmapName} has no EPSG mapping in the CS-MAP dictionary`);
}

async function runNativeCompare(compareRequest: CompareRequest): Promise<unknown> {
  const args = [
    "--csmap-dict",
    csmapDictDir,
    "--csmap-source",
    compareRequest.sourceCsmap,
    "--csmap-target",
    compareRequest.targetCsmap,
    "--proj-source",
    compareRequest.sourceProj,
    "--proj-target",
    compareRequest.targetProj,
    "--x",
    String(compareRequest.x),
    "--y",
    String(compareRequest.y),
  ];

  const { stdout, stderr, error } = await execFileCapture(liveComparePath, args);
  const parsed = parseNativeJson(stdout);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(stderr.trim() || stdout.trim() || "native comparison did not return JSON");
  }

  return {
    ...parsed,
    native: {
      exitCode: typeof error?.code === "number" ? error.code : 0,
      stderr: stderr.trim() || undefined,
    },
  };
}

function execFileCapture(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; error?: ExecFileException }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: rootDir, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr, error: error ?? undefined });
    });
  });
}

function parseNativeJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const routePath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(routePath);
  } catch {
    sendText(response, 400, "bad request");
    return;
  }

  const filePath = path.resolve(webDir, `.${decodedPath}`);
  if (!filePath.startsWith(`${webDir}${path.sep}`) && filePath !== webDir) {
    sendText(response, 403, "forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
      "content-length": body.byteLength,
    });
    response.end(body);
  } catch {
    sendText(response, 404, "not found");
  }
}

const server = createServer((request, response) => {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);

  Promise.resolve()
    .then(() => {
      if (url.pathname.startsWith("/api/")) {
        return handleApi(request, response, url.pathname);
      }
      return serveStatic(response, url.pathname);
    })
    .catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
});

const port = Number(process.env.PORT ?? "4173");
const host = process.env.HOST ?? "127.0.0.1";

server.listen(port, host, () => {
  console.log(`CS-MAP vs PROJ app listening on http://${host}:${port}`);
});
