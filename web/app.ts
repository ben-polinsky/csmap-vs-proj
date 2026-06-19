type BBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type ReportSummary = {
  coordinateAssertions?: number;
  extentAssertions?: number;
  reportedDifferences?: number;
  failures?: number;
};

type CoordinateSample = {
  name: string;
  delta: number;
  status: string;
};

type CoordinateCase = {
  name: string;
  csmapSource: string;
  csmapTarget: string;
  projSource: string;
  projTarget: string;
  units: string;
  tolerance: number;
  samples?: CoordinateSample[];
};

type ExtentCase = {
  name: string;
  csmapCrs: string;
  projCrs: string;
  status: string;
  containsProjBBox?: boolean;
  csmap?: BBox;
  proj?: BBox;
  deltaCsmapMinusProj?: Partial<BBox>;
};

type Report = {
  projVersion?: string;
  csmapDictionary?: string;
  summary?: ReportSummary;
  coordinateCases?: CoordinateCase[];
  extentCases?: ExtentCase[];
};

type CrsEntry = {
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

type Coord = {
  x: number;
  y: number;
};

type LiveEngineResult = {
  source: string;
  target: string;
  ok: boolean;
  coord?: Coord;
  error?: string;
};

type LiveCompareResult = {
  fatal?: string;
  input?: Coord;
  csmap?: LiveEngineResult;
  proj?: LiveEngineResult;
  delta?: number;
  deltaComponents?: Coord;
  targetExtent?: {
    csmap?: BBox;
    proj?: BBox;
    deltaCsmapMinusProj?: Partial<BBox>;
    containsProjBBox?: boolean;
    error?: string;
  };
  projVersion?: string;
  native?: {
    exitCode?: number;
    stderr?: string;
  };
  runtime?: {
    source: "wasm" | "native";
    fallbackReason?: string;
    runtimeUrl?: string;
  };
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

type CompareWorkerOptions = {
  nativeCompareUrl: string;
  wasmAssetBaseUrl: string;
  wasmRuntimeUrl: string;
};

type CompareWorkerMessage = {
  id: number;
  type: "compare";
  options: CompareWorkerOptions;
  request: CompareRequest;
};

type CompareWorkerResponse =
  | {
      id: number;
      type: "result";
      result: LiveCompareResult;
    }
  | {
      id: number;
      type: "error";
      error: string;
    };

type LiveCompareClient = {
  compare(request: CompareRequest): Promise<LiveCompareResult>;
};

declare global {
  interface Window {
    CSMAP_PROJ_REPORT?: Report;
    CSMAP_PROJ_WORKER_VERSION?: string;
    CSMAP_PROJ_WASM_ASSET_BASE_URL?: string;
    CSMAP_PROJ_WASM_RUNTIME_URL?: string;
  }
}

const report = window.CSMAP_PROJ_REPORT;
const nativeCompareUrl = "/api/compare";
const fallbackCompareWorkerVersion = "wasm-browser-parity";
const fallbackWasmAssetBaseUrl = "/wasm/";
const fallbackWasmRuntimeUrl = "/wasm/compare-runtime.js";

const state = {
  filter: "differences",
  search: "",
  crsEntries: [] as CrsEntry[],
  crsIndex: new Map<string, CrsEntry>(),
  epsgIndex: new Map<string, CrsEntry[]>(),
};

const elements = {
  runline: must<HTMLElement>("#runline"),
  differences: must<HTMLElement>("#metric-differences"),
  failures: must<HTMLElement>("#metric-failures"),
  assertions: must<HTMLElement>("#metric-assertions"),
  summaryBand: must<HTMLElement>("#summary-band"),
  caseList: must<HTMLElement>("#case-list"),
  search: must<HTMLInputElement>("#search"),
  segments: Array.from(document.querySelectorAll<HTMLButtonElement>(".segment")),
  sourceEpsg: must<HTMLInputElement>("#source-epsg"),
  targetEpsg: must<HTMLInputElement>("#target-epsg"),
  sourceCsmap: must<HTMLInputElement>("#source-csmap"),
  targetCsmap: must<HTMLInputElement>("#target-csmap"),
  sourceProj: must<HTMLInputElement>("#source-proj"),
  targetProj: must<HTMLInputElement>("#target-proj"),
  inputXLabel: must<HTMLElement>("#input-x-label"),
  inputYLabel: must<HTMLElement>("#input-y-label"),
  inputX: must<HTMLInputElement>("#input-x"),
  inputY: must<HTMLInputElement>("#input-y"),
  crsOptions: must<HTMLDataListElement>("#crs-options"),
  epsgOptions: must<HTMLDataListElement>("#epsg-options"),
  liveResult: must<HTMLElement>("#live-result"),
  runLive: must<HTMLButtonElement>("#run-live"),
};

const liveCompareClient = createLiveCompareClient();

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing required element ${selector}`);
  }
  return element;
}

function fmt(value: number | null | undefined, digits = 6): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  if (Math.abs(value) >= 1000) return Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
  if (Math.abs(value) < 0.000001 && value !== 0) return Number(value).toExponential(3);
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtUnit(value: number | null | undefined, unit: string, digits = 6): string {
  const text = fmt(value, digits);
  return text === "n/a" ? text : `${text} ${unit}`;
}

function displayUnit(rawUnit: string | undefined, fallback = "target units"): string {
  const normalized = (rawUnit || "").trim().toUpperCase();
  if (!normalized) return fallback;
  if (normalized === "METER" || normalized === "METRE") return "m";
  if (normalized === "FOOT" || normalized === "FOOT_US" || normalized === "USFOOT") return "ft";
  if (normalized === "IFOOT" || normalized === "INTL_FOOT") return "intl ft";
  if (normalized === "DEGREE") return "deg";
  return rawUnit || fallback;
}

function unitForCsmapName(name: string | undefined, fallback = "target units"): string {
  if (!name) return fallback;

  const entry = state.crsIndex.get(name.toLowerCase());
  return displayUnit(entry?.unit, fallback);
}

function titleize(value: string): string {
  return value.replaceAll("_", " ");
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssStatusClass(status: string): string {
  if (status === "different") return "diff";
  if (status === "same" || status === "within_tolerance") return "ok";
  return "fail";
}

function statusLabel(status: string, kind: "coordinate" | "extent" | "live"): string {
  if (kind === "live" && status === "different") return "coordinate delta";
  if (kind === "live" && status === "same") return "coordinates match";
  if (kind === "live" && status === "failed") return "transform failed";
  if (kind === "extent" && status === "different") return "extent bbox differs";
  if (kind === "extent" && status === "same") return "extent bbox matches";
  if (kind === "coordinate" && status === "outside_tolerance") return "outside tolerance";
  if (kind === "coordinate" && status === "within_tolerance") return "within tolerance";
  return titleize(status);
}

function coordinateCaseSummary(item: CoordinateCase): { maxDelta: number; failures: number } {
  const samples = item.samples || [];
  const maxDelta = samples.reduce((max, sample) => Math.max(max, sample.delta || 0), 0);
  const failures = samples.filter((sample) => sample.status !== "within_tolerance").length;
  return { maxDelta, failures };
}

function allItems(): Array<{
  type: "coordinate" | "extent";
  key: string;
  isDifference: boolean;
  haystack: string;
  item: CoordinateCase | ExtentCase;
}> {
  const coordinates = (report?.coordinateCases || []).map((item) => ({
    type: "coordinate" as const,
    key: `coordinate:${item.name}`,
    isDifference: (item.samples || []).some((sample) => sample.status !== "within_tolerance"),
    haystack: `${item.name} ${item.csmapSource} ${item.csmapTarget} ${item.projSource} ${item.projTarget}`.toLowerCase(),
    item,
  }));

  const extents = (report?.extentCases || []).map((item) => ({
    type: "extent" as const,
    key: `extent:${item.name}`,
    isDifference: item.status === "different",
    haystack: `${item.name} ${item.csmapCrs} ${item.projCrs}`.toLowerCase(),
    item,
  }));

  return [...coordinates, ...extents];
}

function filteredItems(): ReturnType<typeof allItems> {
  const query = state.search.trim().toLowerCase();
  return allItems().filter((entry) => {
    if (state.filter === "differences" && !entry.isDifference) return false;
    if (state.filter === "extents" && entry.type !== "extent") return false;
    if (state.filter === "coordinates" && entry.type !== "coordinate") return false;
    if (query && !entry.haystack.includes(query)) return false;
    return true;
  });
}

function setMetrics(): void {
  const summary = report?.summary || {};
  const assertions = (summary.coordinateAssertions || 0) + (summary.extentAssertions || 0);
  elements.runline.textContent = `PROJ ${report?.projVersion || "unknown"} / ${report?.csmapDictionary || "CS-MAP"}`;
  elements.differences.textContent = String(summary.reportedDifferences || 0);
  elements.failures.textContent = String(summary.failures || 0);
  elements.assertions.textContent = String(assertions);
}

function renderSummaryBand(): void {
  const summary = report?.summary || {};
  const coordinateCases = report?.coordinateCases || [];
  const extentCases = report?.extentCases || [];
  const extentDiffs = extentCases.filter((item) => item.status === "different").length;

  elements.summaryBand.innerHTML = [
    finding("Coordinate max delta", coordinateMaxByUnit(coordinateCases), "clean"),
    finding("Extent bbox differences", `${extentDiffs} of ${extentCases.length} extent bboxes`, extentDiffs ? "difference" : "clean"),
    finding("API failures", `${summary.failures || 0} failed transform runs`, summary.failures ? "difference" : "clean"),
  ].join("");
}

function finding(label: string, value: string, tone: string): string {
  return `<article class="finding ${tone}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
}

function coordinateMaxByUnit(cases: CoordinateCase[]): string {
  const maxByUnit = new Map<string, number>();

  for (const item of cases) {
    const unit = item.units || "target units";
    const previous = maxByUnit.get(unit) ?? 0;
    maxByUnit.set(unit, Math.max(previous, coordinateCaseSummary(item).maxDelta));
  }

  if (maxByUnit.size === 0) return "0 coordinate cases";

  return Array.from(maxByUnit.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, max]) => `${fmtUnit(max, unit, 12)} max`)
    .join(" / ");
}

function renderCases(): void {
  const entries = filteredItems();
  if (entries.length === 0) {
    elements.caseList.innerHTML = `<div class="empty">No cases match the current filter.</div>`;
    return;
  }

  elements.caseList.innerHTML = entries
    .map((entry) => (entry.type === "extent" ? extentCard(entry.item as ExtentCase) : coordinateCard(entry.item as CoordinateCase)))
    .join("");
}

function coordinateCard(item: CoordinateCase): string {
  const summary = coordinateCaseSummary(item);
  const status = summary.failures ? "outside_tolerance" : "within_tolerance";
  return `
    <article class="case-card coordinate ${summary.failures ? "different" : ""}">
      <div>
        <p class="case-kicker">coordinate parity</p>
        <h2 class="case-title">${escapeHtml(titleize(item.name))}</h2>
        <p class="case-route">CS-MAP ${escapeHtml(item.csmapSource)} -> ${escapeHtml(item.csmapTarget)}</p>
        <p class="case-route">PROJ ${escapeHtml(item.projSource)} -> ${escapeHtml(item.projTarget)}</p>
        <p class="case-note">Delta is the distance between CS-MAP and PROJ output coordinates in ${escapeHtml(item.units)}.</p>
        <span class="status ${cssStatusClass(status)}">${escapeHtml(statusLabel(status, "coordinate"))}</span>
      </div>
      <div>
        <table class="sample-table">
          <caption>Coordinate sample deltas, ${escapeHtml(item.units)}</caption>
          <thead>
            <tr><th>sample</th><th>delta</th><th>tolerance</th><th>status</th></tr>
          </thead>
          <tbody>
            ${(item.samples || [])
              .map(
                (sample) => `
                  <tr>
                    <td>${escapeHtml(sample.name)}</td>
                    <td>${fmtUnit(sample.delta, item.units, 12)}</td>
                    <td>${fmtUnit(item.tolerance, item.units, 12)}</td>
                    <td>${escapeHtml(statusLabel(sample.status, "coordinate"))}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function extentCard(item: ExtentCase): string {
  return `
    <article class="case-card extent ${escapeHtml(item.status)}">
      <div>
        <p class="case-kicker">extent metadata</p>
        <h2 class="case-title">${escapeHtml(titleize(item.name))}</h2>
        <p class="case-route">CS-MAP ${escapeHtml(item.csmapCrs)}</p>
        <p class="case-route">PROJ ${escapeHtml(item.projCrs)}</p>
        <p class="case-note">BBox edges are west/south/east/north in deg; delta is CS-MAP edge minus PROJ edge.</p>
        <p class="case-note">contains PROJ bbox: ${item.containsProjBBox ? "yes" : "no"}</p>
        <span class="status ${cssStatusClass(item.status)}">${escapeHtml(statusLabel(item.status, "extent"))}</span>
      </div>
      <div>
        ${extentSvg(item.csmap, item.proj)}
        ${bboxTable(item)}
      </div>
    </article>
  `;
}

function bboxTable(item: ExtentCase): string {
  const d = item.deltaCsmapMinusProj || {};
  return `
    <table class="bbox-grid">
      <caption>Extent bbox edges, deg</caption>
      <thead>
        <tr><th>edge</th><th>CS-MAP</th><th>PROJ</th><th>delta</th></tr>
      </thead>
      <tbody>
        ${(["west", "south", "east", "north"] as const)
          .map(
            (edge) => `
              <tr>
                <td>${edge}</td>
                <td>${fmtUnit(item.csmap?.[edge], "deg", 9)}</td>
                <td>${fmtUnit(item.proj?.[edge], "deg", 9)}</td>
                <td class="delta-cell">${fmtUnit(d[edge], "deg", 9)}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function extentSvg(csmap: BBox | undefined, proj: BBox | undefined): string {
  const width = 720;
  const height = 320;
  const rects = [
    { bbox: csmap, className: "csmap-rect" },
    { bbox: proj, className: "proj-rect" },
  ];
  const grid: string[] = [];
  for (let lon = -120; lon <= 120; lon += 60) {
    const x = projectX(lon, width);
    grid.push(`<line class="graticule" x1="${x}" y1="0" x2="${x}" y2="${height}" />`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = projectY(lat, height);
    grid.push(`<line class="graticule" x1="0" y1="${y}" x2="${width}" y2="${y}" />`);
  }

  return `
    <div class="extent-visual">
      <svg class="extent-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Extent bbox comparison map with approximate land basemap">
        <rect class="world" x="0" y="0" width="${width}" height="${height}" />
        ${worldLandPaths(width, height)}
        ${grid.join("")}
        ${rects.map(({ bbox, className }) => bboxRect(bbox, className, width, height)).join("")}
      </svg>
      <p class="map-unit-note">extent overlay uses longitude/latitude degrees</p>
    </div>
  `;
}

const worldLandPolygons: Array<Array<[number, number]>> = [
  [
    [-168, 72],
    [-140, 70],
    [-128, 56],
    [-112, 50],
    [-96, 49],
    [-82, 42],
    [-68, 46],
    [-54, 58],
    [-62, 70],
    [-96, 76],
    [-132, 74],
  ],
  [
    [-83, 30],
    [-72, 23],
    [-78, 9],
    [-64, -4],
    [-54, -18],
    [-60, -38],
    [-72, -55],
    [-81, -38],
    [-79, -14],
    [-88, 8],
  ],
  [
    [-52, 60],
    [-38, 70],
    [-24, 76],
    [-18, 66],
    [-30, 58],
  ],
  [
    [-18, 36],
    [0, 57],
    [34, 58],
    [48, 42],
    [43, 12],
    [32, -34],
    [18, -35],
    [6, -18],
    [-10, 4],
    [-18, 24],
  ],
  [
    [-10, 36],
    [12, 46],
    [40, 45],
    [76, 56],
    [112, 48],
    [150, 60],
    [168, 52],
    [146, 30],
    [118, 24],
    [102, 8],
    [72, 8],
    [50, 24],
    [30, 30],
    [10, 36],
  ],
  [
    [112, -10],
    [154, -10],
    [154, -40],
    [132, -44],
    [112, -28],
  ],
  [
    [-180, -62],
    [180, -62],
    [180, -84],
    [-180, -84],
  ],
];

function worldLandPaths(width: number, height: number): string {
  return worldLandPolygons.map((points) => `<path class="land" d="${polygonPath(points, width, height)}" />`).join("");
}

function polygonPath(points: Array<[number, number]>, width: number, height: number): string {
  return points
    .map(([lon, lat], index) => `${index === 0 ? "M" : "L"} ${projectX(lon, width)} ${projectY(lat, height)}`)
    .join(" ")
    .concat(" Z");
}

function bboxRect(bbox: BBox | undefined, className: string, width: number, height: number): string {
  if (!bbox) return "";
  const west = clamp(bbox.west, -180, 180);
  const east = clamp(bbox.east, -180, 180);
  const south = clamp(bbox.south, -90, 90);
  const north = clamp(bbox.north, -90, 90);
  const x = projectX(west, width);
  const y = projectY(north, height);
  const w = Math.max(1, projectX(east, width) - x);
  const h = Math.max(1, projectY(south, height) - y);
  return `<rect class="${className}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
}

function projectX(lon: number, width: number): number {
  return ((lon + 180) / 360) * width;
}

function projectY(lat: number, height: number): number {
  return ((90 - lat) / 180) * height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function loadCrsCatalog(): Promise<void> {
  elements.liveResult.innerHTML = `<div class="live-empty">Loading CRS catalog</div>`;

  try {
    const response = await fetch("/api/crs");
    if (!response.ok) throw new Error(`CRS catalog request failed with HTTP ${response.status}`);

    const data = (await response.json()) as { items?: CrsEntry[] };
    state.crsEntries = data.items || [];
    state.crsIndex = new Map(state.crsEntries.map((entry) => [entry.name.toLowerCase(), entry]));
    state.epsgIndex = indexCrsByEpsg(state.crsEntries);

    elements.crsOptions.replaceChildren(
      ...state.crsEntries.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.name;
        option.label = crsOptionLabel(entry);
        return option;
      }),
    );
    elements.epsgOptions.replaceChildren(...epsgOptions());

    setLiveDefaults();
    elements.liveResult.innerHTML = `<div class="live-empty">Ready</div>`;
    await runLiveComparison();
  } catch (error) {
    elements.liveResult.innerHTML = liveError(error instanceof Error ? error.message : String(error));
  }
}

function crsOptionLabel(entry: CrsEntry): string {
  const details = [entry.epsg ? `EPSG:${entry.epsg}` : "", entry.group || "", entry.desc || ""].filter(Boolean);
  return details.length ? `${entry.name} - ${details.join(" / ")}` : entry.name;
}

function normalizeEpsgInput(value: string): string {
  const match = value.trim().match(/^(?:EPSG:)?(\d+)$/i);
  if (!match) return "";

  const code = Number(match[1]);
  return code > 0 ? String(code) : "";
}

function epsgDisplay(value: string): string {
  const epsg = normalizeEpsgInput(value);
  return epsg ? `EPSG:${epsg}` : value.trim();
}

function indexCrsByEpsg(entries: CrsEntry[]): Map<string, CrsEntry[]> {
  const index = new Map<string, CrsEntry[]>();

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

function epsgOptions(): HTMLOptionElement[] {
  return Array.from(state.epsgIndex.entries())
    .sort(([left], [right]) => Number(left) - Number(right) || left.localeCompare(right))
    .map(([epsg, candidates]) => {
      const best = candidates[0];
      const option = document.createElement("option");
      option.value = `EPSG:${epsg}`;
      option.label = epsgOptionLabel(epsg, candidates, best);
      return option;
    });
}

function epsgOptionLabel(epsg: string, candidates: CrsEntry[], best: CrsEntry | undefined): string {
  const summary = [best?.name, best?.desc].filter(Boolean).join(" / ");
  const suffix = candidates.length > 1 ? ` / ${candidates.length} CS-MAP matches` : "";
  return summary ? `EPSG:${epsg} - ${summary}${suffix}` : `EPSG:${epsg}`;
}

function compareCrsCandidates(left: CrsEntry, right: CrsEntry): number {
  return (
    crsCandidateRank(left) - crsCandidateRank(right) ||
    left.name.length - right.name.length ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

function crsCandidateRank(entry: CrsEntry): number {
  let rank = 0;
  if (isDeprecatedCrs(entry)) rank += 1000;
  if (entry.group === "WKTSUPPT") rank += 100;
  if (entry.srid && entry.epsg && entry.srid === entry.epsg) rank -= 10;
  return rank;
}

function isDeprecatedCrs(entry: CrsEntry): boolean {
  return entry.deprecated === true || entry.group === "LEGACY" || /deprecated/i.test(entry.desc ?? "");
}

function setLiveDefaults(): void {
  elements.sourceEpsg.value ||= "EPSG:4326";
  elements.targetEpsg.value ||= "EPSG:3857";
  syncFromEpsg("source");
  syncFromEpsg("target");
  elements.inputX.value ||= "-75.165222";
  elements.inputY.value ||= "39.952583";
  updateInputUnitLabels();
}

function syncFromEpsg(role: "source" | "target"): void {
  const controls = controlsForRole(role);
  const epsg = normalizeEpsgInput(controls.epsg.value);
  if (!epsg || epsg.length < 4) return;

  const best = state.epsgIndex.get(epsg)?.[0];
  controls.epsg.value = `EPSG:${epsg}`;
  controls.csmap.value = best?.name ?? "";
  controls.proj.value = `EPSG:${epsg}`;
  if (role === "source") updateInputUnitLabels();
}

function syncEpsgFromCsmap(role: "source" | "target"): void {
  const controls = controlsForRole(role);
  const entry = state.crsIndex.get(controls.csmap.value.trim().toLowerCase());
  if (entry?.epsg) {
    controls.epsg.value = `EPSG:${entry.epsg}`;
    controls.proj.value = `EPSG:${entry.epsg}`;
  }
  if (role === "source") updateInputUnitLabels();
}

function updateInputUnitLabels(): void {
  const sourceUnit = unitForCsmapName(elements.sourceCsmap.value, "source units");
  elements.inputXLabel.textContent = `Input X, ${sourceUnit}`;
  elements.inputYLabel.textContent = `Input Y, ${sourceUnit}`;
}

function controlsForRole(role: "source" | "target"): {
  epsg: HTMLInputElement;
  csmap: HTMLInputElement;
  proj: HTMLInputElement;
} {
  return role === "source"
    ? { epsg: elements.sourceEpsg, csmap: elements.sourceCsmap, proj: elements.sourceProj }
    : { epsg: elements.targetEpsg, csmap: elements.targetCsmap, proj: elements.targetProj };
}

function createLiveCompareClient(): LiveCompareClient {
  if (!("Worker" in window)) {
    return {
      compare: (request) => fetchNativeCompare(request, "Web Workers are not available in this browser"),
    };
  }

  let worker: Worker | undefined;
  let workerUnavailableReason: string | undefined;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (result: LiveCompareResult) => void;
      timeoutId: number;
    }
  >();

  function getWorker(): Worker | undefined {
    if (worker) return worker;
    if (workerUnavailableReason) return undefined;

    try {
      worker = new Worker(compareWorkerUrl(), { type: "module" });
    } catch (error) {
      workerUnavailableReason = errorMessage(error);
      return undefined;
    }

    worker.addEventListener("message", (event: MessageEvent<CompareWorkerResponse>) => {
      const message = event.data;
      if (!isCompareWorkerResponse(message)) return;

      const active = pending.get(message.id);
      if (!active) return;

      window.clearTimeout(active.timeoutId);
      pending.delete(message.id);
      if (message.type === "result") {
        active.resolve(message.result);
      } else {
        active.reject(new Error(message.error));
      }
    });

    worker.addEventListener("error", () => {
      workerUnavailableReason = "compare worker failed";
      rejectPending(workerUnavailableReason);
      worker?.terminate();
      worker = undefined;
    });

    return worker;
  }

  async function compare(request: CompareRequest): Promise<LiveCompareResult> {
    const activeWorker = getWorker();
    if (!activeWorker) {
      return fetchNativeCompare(request, workerUnavailableReason ?? "compare worker is unavailable");
    }

    try {
      return await postWorkerCompare(activeWorker, request);
    } catch (error) {
      return fetchNativeCompare(request, `compare worker failed: ${errorMessage(error)}`);
    }
  }

  function postWorkerCompare(activeWorker: Worker, request: CompareRequest): Promise<LiveCompareResult> {
    return new Promise((resolve, reject) => {
      const id = nextRequestId;
      nextRequestId += 1;

      const timeoutId = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error("compare worker timed out"));
      }, 30000);

      pending.set(id, { reject, resolve, timeoutId });

      try {
        activeWorker.postMessage({
          id,
          type: "compare",
          options: compareWorkerOptions(),
          request,
        } satisfies CompareWorkerMessage);
      } catch (error) {
        window.clearTimeout(timeoutId);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function rejectPending(reason: string): void {
    for (const active of pending.values()) {
      window.clearTimeout(active.timeoutId);
      active.reject(new Error(reason));
    }
    pending.clear();
  }

  return { compare };
}

function compareWorkerUrl(): URL {
  const url = new URL("../compare-worker.js", import.meta.url);
  url.searchParams.set("v", window.CSMAP_PROJ_WORKER_VERSION?.trim() || fallbackCompareWorkerVersion);
  return url;
}

function compareWorkerOptions(): CompareWorkerOptions {
  return {
    nativeCompareUrl,
    wasmAssetBaseUrl: normalizeAssetBaseUrl(window.CSMAP_PROJ_WASM_ASSET_BASE_URL),
    wasmRuntimeUrl: window.CSMAP_PROJ_WASM_RUNTIME_URL?.trim() || fallbackWasmRuntimeUrl,
  };
}

function normalizeAssetBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim() || fallbackWasmAssetBaseUrl;
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function fetchNativeCompare(request: CompareRequest, fallbackReason?: string): Promise<LiveCompareResult> {
  const response = await fetch(nativeCompareUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `comparison failed with HTTP ${response.status}`);

  return {
    ...(data as LiveCompareResult),
    runtime: {
      source: "native",
      fallbackReason,
    },
  };
}

function isCompareWorkerResponse(value: unknown): value is CompareWorkerResponse {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return typeof record.id === "number" && (record.type === "result" || record.type === "error");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCompareRequest(): CompareRequest {
  return {
    sourceEpsg: epsgDisplay(elements.sourceEpsg.value),
    targetEpsg: epsgDisplay(elements.targetEpsg.value),
    sourceCsmap: elements.sourceCsmap.value,
    targetCsmap: elements.targetCsmap.value,
    sourceProj: elements.sourceProj.value,
    targetProj: elements.targetProj.value,
    x: Number(elements.inputX.value),
    y: Number(elements.inputY.value),
  };
}

async function runLiveComparison(): Promise<void> {
  elements.runLive.disabled = true;
  elements.runLive.textContent = "Running";
  elements.liveResult.innerHTML = `<div class="live-empty">Running comparison</div>`;

  try {
    renderLiveResult(await liveCompareClient.compare(buildCompareRequest()));
  } catch (error) {
    elements.liveResult.innerHTML = liveError(error instanceof Error ? error.message : String(error));
  } finally {
    elements.runLive.disabled = false;
    elements.runLive.textContent = "Run";
  }
}

function renderLiveResult(result: LiveCompareResult): void {
  if (result.fatal) {
    elements.liveResult.innerHTML = liveError(result.fatal);
    return;
  }

  const csmapOk = result.csmap?.ok === true;
  const projOk = result.proj?.ok === true;
  const hasDifference = typeof result.delta === "number" && result.delta !== 0;
  const status = !csmapOk || !projOk ? "failed" : hasDifference ? "different" : "same";
  const outputUnit = unitForCsmapName(result.csmap?.target || elements.targetCsmap.value);

  elements.liveResult.innerHTML = `
    <article class="live-output ${cssStatusClass(status)}">
      <div class="live-status-row">
        <span class="status ${cssStatusClass(status)}">${escapeHtml(statusLabel(status, "live"))}</span>
        <span class="status-note">${escapeHtml(liveStatusNote(status, result, outputUnit))}</span>
        <span class="case-route">PROJ ${escapeHtml(result.projVersion || "unknown")}</span>
        ${runtimeBadge(result)}
      </div>
      <div class="coordinate-grid">
        ${engineCard("CS-MAP", result.csmap, outputUnit)}
        ${engineCard("PROJ", result.proj, outputUnit)}
        <section class="coord-card delta-card">
          <h3>Coordinate delta</h3>
          <strong>${fmtUnit(result.delta, outputUnit, 12)}</strong>
          <p>x ${fmtUnit(result.deltaComponents?.x, outputUnit, 12)}</p>
          <p>y ${fmtUnit(result.deltaComponents?.y, outputUnit, 12)}</p>
        </section>
      </div>
      ${liveExtentBlock(result.targetExtent)}
    </article>
  `;
}

function liveStatusNote(status: string, result: LiveCompareResult, outputUnit: string): string {
  if (status === "failed") return "At least one engine did not return a coordinate.";
  return `CS-MAP output minus PROJ output: ${fmtUnit(result.delta, outputUnit, 12)}.`;
}

function runtimeBadge(result: LiveCompareResult): string {
  if (!result.runtime) return "";

  const label =
    result.runtime.source === "wasm"
      ? "browser WASM"
      : result.runtime.fallbackReason
        ? `native fallback: ${result.runtime.fallbackReason}`
        : "native fallback";

  return `<span class="case-route">${escapeHtml(label)}</span>`;
}

function engineCard(label: string, engine: LiveEngineResult | undefined, outputUnit: string): string {
  return `
    <section class="coord-card">
      <h3>${escapeHtml(label)}</h3>
      <p>${escapeHtml(engine?.source || "")} -> ${escapeHtml(engine?.target || "")}</p>
      ${
        engine?.ok && engine.coord
          ? `<dl class="coord-values">
              <div><dt>X</dt><dd>${fmtUnit(engine.coord.x, outputUnit, 12)}</dd></div>
              <div><dt>Y</dt><dd>${fmtUnit(engine.coord.y, outputUnit, 12)}</dd></div>
            </dl>`
          : `<strong class="engine-error">${escapeHtml(engine?.error || "not run")}</strong>`
      }
    </section>
  `;
}

function liveExtentBlock(extent: LiveCompareResult["targetExtent"]): string {
  if (!extent) return "";
  if (extent.error) {
    return `<div class="extent-error">${escapeHtml(extent.error)}</div>`;
  }
  return `
    <div class="live-extent">
      ${extentSvg(extent.csmap, extent.proj)}
      <table class="bbox-grid">
        <caption>Target extent bbox edges, deg</caption>
        <thead>
          <tr><th>edge</th><th>CS-MAP</th><th>PROJ</th><th>delta</th></tr>
        </thead>
        <tbody>
          ${(["west", "south", "east", "north"] as const)
            .map(
              (edge) => `
                <tr>
                  <td>${edge}</td>
                  <td>${fmtUnit(extent.csmap?.[edge], "deg", 9)}</td>
                  <td>${fmtUnit(extent.proj?.[edge], "deg", 9)}</td>
                  <td class="delta-cell">${fmtUnit(extent.deltaCsmapMinusProj?.[edge], "deg", 9)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
      <p class="case-note">target extent contains PROJ bbox: ${extent.containsProjBBox ? "yes" : "no"}</p>
    </div>
  `;
}

function liveError(message: string): string {
  return `<div class="live-error">${escapeHtml(message)}</div>`;
}

function render(): void {
  if (!report) {
    elements.caseList.innerHTML = `<div class="empty">Report data is missing.</div>`;
    return;
  }
  setMetrics();
  renderSummaryBand();
  renderCases();
}

elements.segments.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter || "differences";
    elements.segments.forEach((item) => item.classList.toggle("active", item === button));
    renderCases();
  });
});

elements.search.addEventListener("input", (event) => {
  state.search = (event.target as HTMLInputElement).value;
  renderCases();
});

elements.sourceEpsg.addEventListener("input", () => syncFromEpsg("source"));
elements.targetEpsg.addEventListener("input", () => syncFromEpsg("target"));
elements.sourceEpsg.addEventListener("change", () => syncFromEpsg("source"));
elements.targetEpsg.addEventListener("change", () => syncFromEpsg("target"));
elements.sourceCsmap.addEventListener("change", () => syncEpsgFromCsmap("source"));
elements.targetCsmap.addEventListener("change", () => syncEpsgFromCsmap("target"));
elements.runLive.addEventListener("click", () => {
  void runLiveComparison();
});

render();
void loadCrsCatalog();

export {};
