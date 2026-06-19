#!/usr/bin/env node
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPolicyPath = path.join(root, "wasm/csmap-data-policy.json");
const options = parseArgs(process.argv.slice(2));
const policyPath = path.resolve(options.policy ?? defaultPolicyPath);
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const csmapDict = path.resolve(process.env.CSMAP_DICT ?? path.join(root, policy.sourceDictionaryDir));
const outputRoot = path.resolve(process.env.WASM_DATA_DIR ?? path.join(root, policy.assetDir));
const mode = options.mode ?? "symlink";

if (!["copy", "symlink"].includes(mode)) {
  throw new Error(`Unsupported materialization mode: ${mode}`);
}

const csmapManifest = await buildCsmapManifest();
const projManifest = await buildProjManifest();
const manifest = {
  schemaVersion: policy.schemaVersion,
  generatedAt: new Date().toISOString(),
  strategy: mode === "copy" ? "core-preload-with-copied-lazy-packs" : "core-preload-with-symlinked-lazy-packs",
  policyFile: relativeToRoot(policyPath),
  assetRoot: relativeToRoot(outputRoot),
  assetMountPath: policy.assetMountPath,
  materialization: {
    mode,
    dryRun: options.dryRun,
    csmap: csmapManifest.materialization,
    proj: projManifest.materialization,
  },
  csmap: omitMaterialization(csmapManifest),
  proj: omitMaterialization(projManifest),
};

if (!options.dryRun) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, policy.manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
}

const manifestPath = relativeToRoot(path.join(outputRoot, policy.manifestFile));
console.log(`${options.dryRun ? "Validated" : "Wrote"} ${manifestPath}`);
console.log(
  `CS-MAP preload files: ${manifest.csmap.preloadFiles.length}; ` +
    `lazy grid files: ${manifest.csmap.summary.lazyGridFiles}; ` +
    `packs: ${manifest.csmap.lazyGridPacks.length}; ` +
    `missing references: ${manifest.csmap.missingReferences.length}`,
);
if (manifest.proj.warning) console.warn(manifest.proj.warning);

if (manifest.csmap.missingReferences.length > 0) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const parsed = { dryRun: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--copy" || arg === "--copy-lazy") {
      parsed.mode = "copy";
      continue;
    }
    if (arg === "--symlink") {
      parsed.mode = "symlink";
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (key === "--policy") {
      parsed.policy = inlineValue ?? args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/wasm-data.mjs [options]

Options:
  --symlink          Materialize preload and lazy files as symlinks. Default.
  --copy            Copy preload and lazy files.
  --copy-lazy       Legacy alias for --copy.
  --policy <path>   Policy JSON path. Default: wasm/csmap-data-policy.json.
  --dry-run         Validate and print counts without writing files.
`);
}

async function buildCsmapManifest() {
  const files = await walk(csmapDict);
  const fileIndex = new Map(files.map((file) => [normalizeKey(file), file]));
  const preloadSet = resolvePreloadFiles(fileIndex);
  const references = await collectCsmapReferences();
  const expandedReferences = expandReferences(references, files, fileIndex);
  const discoveredGridFiles = discoverGridFiles(files, preloadSet);
  const lazySet = new Set([...discoveredGridFiles, ...expandedReferences.files.keys()]);
  const lazyFiles = [...lazySet].sort();
  const packAssignments = assignPacks(lazyFiles, expandedReferences.explicitPacks);
  const csmapRoot = path.join(outputRoot, policy.csmap.assetSubdir);
  const coreRoot = path.join(csmapRoot, policy.csmap.coreSubdir);
  const lazyRoot = path.join(csmapRoot, policy.csmap.lazySubdir);

  let materialization = emptyMaterialization();
  if (!options.dryRun) {
    await rm(csmapRoot, { recursive: true, force: true });
    materialization = mergeMaterialization(
      await materializeMany([...preloadSet].sort(), csmapDict, coreRoot),
      await materializeMany(lazyFiles, csmapDict, lazyRoot),
    );
  }

  const preloadFiles = await assetEntries([...preloadSet].sort(), csmapDict, coreRoot, [
    policy.csmap.assetSubdir,
    policy.csmap.coreSubdir,
  ]);

  const lazyEntries = await assetEntries(lazyFiles, csmapDict, lazyRoot, [
    policy.csmap.assetSubdir,
    policy.csmap.lazySubdir,
  ]);
  for (const entry of lazyEntries) {
    entry.references = expandedReferences.files.get(entry.dictionaryPath) ?? [];
  }

  const lazyGridPacks = buildLazyGridPacks(packAssignments, lazyEntries, expandedReferences.patterns);

  return {
    root: joinUrl(policy.assetMountPath, policy.csmap.assetSubdir),
    sourceRoot: relativeToRoot(csmapDict),
    summary: {
      preloadFiles: preloadFiles.length,
      preloadBytes: sumBytes(preloadFiles),
      lazyGridFiles: lazyEntries.length,
      lazyGridBytes: sumBytes(lazyEntries),
      lazyGridPacks: lazyGridPacks.length,
      referencedGridFiles: expandedReferences.files.size,
      discoveredGridLikeFiles: discoveredGridFiles.length,
      missingReferences: expandedReferences.missing.length,
    },
    classification: {
      coreDictionaryFiles: preloadFiles.map((file) => file.dictionaryPath),
      gridExtensions: policy.gridExtensions,
      knownTextGridFiles: policy.knownTextGridFiles,
    },
    preloadFiles,
    lazyGridPacks,
    missingReferences: expandedReferences.missing,
    materialization,
  };
}

async function buildProjManifest() {
  const candidates = [
    process.env.PROJ_DATA,
    "/opt/homebrew/share/proj",
    "/usr/local/share/proj",
    "/usr/share/proj",
  ].filter(Boolean);
  const sourceRoot = await firstExisting(candidates);
  const projRoot = path.join(outputRoot, "proj");
  const coreRoot = path.join(projRoot, "core");
  let materialization = emptyMaterialization();

  if (!sourceRoot) {
    if (!options.dryRun) await rm(coreRoot, { recursive: true, force: true });
    return {
      root: joinUrl(policy.assetMountPath, "proj"),
      preloadFiles: [],
      lazyFiles: [],
      warning: "PROJ data directory not found",
      materialization,
    };
  }

  const preloadNames = [];
  for (const name of ["proj.db", "proj.ini"]) {
    if (await exists(path.join(sourceRoot, name))) preloadNames.push(name);
  }

  if (!options.dryRun) {
    await rm(coreRoot, { recursive: true, force: true });
    materialization = await materializeMany(preloadNames, sourceRoot, coreRoot);
  }

  return {
    root: joinUrl(policy.assetMountPath, "proj"),
    sourceRoot,
    preloadFiles: await assetEntries(preloadNames, sourceRoot, coreRoot, ["proj", "core"]),
    lazyFiles: [],
    materialization,
  };
}

function resolvePreloadFiles(fileIndex) {
  const preload = new Set();
  const configured = [
    ...(policy.preload.sourceDictionaries ?? []),
    ...(policy.preload.catalogs ?? []),
    ...(policy.preload.compiledDictionaries ?? []),
  ];

  for (const candidate of configured.map(normalizeDictionaryPath)) {
    const actual = fileIndex.get(normalizeKey(candidate));
    if (actual) preload.add(actual);
  }

  return preload;
}

async function collectCsmapReferences() {
  const references = [
    ...(await parseGeodeticTransformReferences()),
    ...(await parseGdcReferences("GeoidHeight.gdc")),
    ...(await parseGdcReferences("Vertcon.gdc")),
  ];

  for (const item of policy.additionalLazyFiles ?? []) {
    references.push({
      kind: "policy",
      sourceFile: relativeToRoot(policyPath),
      rawPath: item.path,
      normalizedPath: normalizeDictionaryPath(item.path),
      reason: item.reason,
      explicitPack: item.pack,
    });
  }

  return references;
}

async function parseGeodeticTransformReferences() {
  const sourceFile = "GeodeticTransformation.asc";
  const text = await readFile(path.join(csmapDict, sourceFile), "utf8");
  const references = [];
  let transform = {};

  text.split(/\r?\n/).forEach((line, index) => {
    const active = stripComment(line).trim();
    if (!active) return;

    const field = active.match(/^([A-Z0-9_]+):\s*(.*?)\s*$/);
    if (!field) return;
    const [, key, value] = field;

    if (key === "GX_NAME") {
      transform = { name: value };
      return;
    }
    if (key === "SRC_DTM") {
      transform.sourceDatum = value;
      return;
    }
    if (key === "TRG_DTM") {
      transform.targetDatum = value;
      return;
    }
    if (key === "METHOD") {
      transform.method = value;
      return;
    }
    if (key !== "GRID_FILE") return;

    const parts = value.split(",").map((part) => part.trim());
    if (parts.length < 3) return;
    const rawPath = parts.slice(2).join(",");
    references.push({
      kind: "geodetic-transform",
      sourceFile,
      line: index + 1,
      rawPath,
      normalizedPath: normalizeDictionaryPath(rawPath),
      gridFormat: parts[0],
      direction: parts[1],
      transform: { ...transform },
    });
  });

  return references;
}

async function parseGdcReferences(sourceFile) {
  const filePath = path.join(csmapDict, sourceFile);
  if (!(await exists(filePath))) return [];

  const text = await readFile(filePath, "utf8");
  const references = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const active = stripComment(line).trim();
    if (!active) return;
    const rawPath = active.split(/\s+/)[0];
    references.push({
      kind: "catalog",
      catalog: sourceFile,
      sourceFile,
      line: index + 1,
      rawPath,
      normalizedPath: normalizeDictionaryPath(rawPath),
    });
  });
  return references;
}

function expandReferences(references, allFiles, fileIndex) {
  const files = new Map();
  const missing = [];
  const patternsByName = new Map();
  const explicitPacks = new Map();

  for (const reference of references) {
    const matches = expandReferencePath(reference.normalizedPath, allFiles, fileIndex);
    if (matches.length === 0) {
      missing.push(compactReference(reference));
      continue;
    }

    patternsByName.set(reference.normalizedPath, {
      pattern: reference.normalizedPath,
      fileCount: matches.length,
      reference: compactReference(reference),
    });

    for (const match of matches) {
      const refs = files.get(match) ?? [];
      refs.push(compactReference(reference));
      files.set(match, uniqueBy(refs, referenceKey));
      if (reference.explicitPack) explicitPacks.set(match, reference.explicitPack);
    }
  }

  return {
    files,
    missing,
    patterns: [...patternsByName.values()].sort((left, right) => left.pattern.localeCompare(right.pattern)),
    explicitPacks,
  };
}

function discoverGridFiles(files, preloadSet) {
  const gridExtensions = new Set((policy.gridExtensions ?? []).map((extension) => extension.toLowerCase()));
  const knownTextGrids = new Set((policy.knownTextGridFiles ?? []).map(normalizeKey));

  return files
    .filter((file) => !preloadSet.has(file))
    .filter((file) => gridExtensions.has(extensionOf(file).toLowerCase()) || knownTextGrids.has(normalizeKey(file)))
    .sort();
}

function expandReferencePath(referencePath, allFiles, fileIndex) {
  if (hasWildcard(referencePath)) {
    const matcher = wildcardToRegExp(referencePath);
    return allFiles.filter((file) => matcher.test(file)).sort();
  }

  const exact = fileIndex.get(normalizeKey(referencePath));
  return exact ? [exact] : [];
}

function assignPacks(lazyFiles, explicitPacks) {
  const assignments = new Map();
  for (const file of lazyFiles) {
    const explicitPack = explicitPacks.get(file);
    const pack = explicitPack ? packById(explicitPack) : matchingPack(file);
    const packId = pack?.id ?? "misc-grid-files";
    const files = assignments.get(packId) ?? [];
    files.push(file);
    assignments.set(packId, files);
  }
  return assignments;
}

function buildLazyGridPacks(assignments, lazyEntries, patterns) {
  const byPath = new Map(lazyEntries.map((entry) => [entry.dictionaryPath, entry]));
  const packs = [];

  for (const configuredPack of policy.lazyGridPacks ?? []) {
    const files = (assignments.get(configuredPack.id) ?? [])
      .map((file) => byPath.get(file))
      .filter(Boolean)
      .sort((left, right) => left.dictionaryPath.localeCompare(right.dictionaryPath));
    if (files.length === 0) continue;

    packs.push({
      id: configuredPack.id,
      label: configuredPack.label,
      description: configuredPack.description,
      fileCount: files.length,
      sizeBytes: sumBytes(files),
      referencedPatterns: patterns.filter((pattern) =>
        files.some((file) => file.references.some((reference) => reference.normalizedPath === pattern.pattern)),
      ),
      files,
    });
  }

  return packs;
}

async function materializeMany(files, sourceRoot, targetRoot) {
  const counts = emptyMaterialization();
  for (const file of files) {
    const result = await materializeOne(path.join(sourceRoot, file), path.join(targetRoot, file));
    counts[result] += 1;
  }
  return counts;
}

async function materializeOne(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await lstatMaybe(target);

  if (existing?.isDirectory()) {
    throw new Error(`Refusing to replace generated directory with file: ${relativeToRoot(target)}`);
  }

  if (existing) {
    if (mode === "symlink" && existing.isSymbolicLink()) {
      const targetPath = await readlinkTarget(target);
      if (targetPath === path.relative(path.dirname(target), source)) return "reused";
    }
    await rm(target, { force: true });
  }

  if (mode === "copy") {
    await copyFile(source, target);
    return "copied";
  }

  try {
    await symlink(path.relative(path.dirname(target), source), target);
    return "symlinked";
  } catch {
    await copyFile(source, target);
    return "fallbackCopied";
  }
}

async function assetEntries(files, sourceRoot, targetRoot, urlPrefixParts) {
  const entries = [];
  for (const file of files) {
    const source = path.join(sourceRoot, file);
    const info = await stat(source);
    entries.push({
      dictionaryPath: toPosix(file),
      sourcePath: relativeToRoot(source),
      assetPath: toPosix(path.relative(outputRoot, path.join(targetRoot, file))),
      url: joinUrl(policy.assetMountPath, ...urlPrefixParts, ...toPosix(file).split("/")),
      sizeBytes: info.size,
    });
  }
  return entries;
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      files.push(toPosix(path.relative(base, full)));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function lstatMaybe(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readlinkTarget(filePath) {
  const { readlink } = await import("node:fs/promises");
  return readlink(filePath);
}

function matchingPack(dictionaryPath) {
  for (const pack of policy.lazyGridPacks ?? []) {
    if (matchesRules(dictionaryPath, pack.rules ?? {})) return pack;
  }
  return undefined;
}

function packById(id) {
  return (policy.lazyGridPacks ?? []).find((pack) => pack.id === id);
}

function matchesRules(dictionaryPath, rules) {
  const key = normalizeKey(dictionaryPath);
  if ((rules.files ?? []).some((file) => normalizeKey(file) === key)) return true;
  if ((rules.prefixes ?? []).some((prefix) => key.startsWith(normalizeKey(prefix)))) return true;
  if ((rules.extensions ?? []).some((extension) => extensionOf(dictionaryPath).toLowerCase() === extension.toLowerCase())) {
    return true;
  }
  return false;
}

function compactReference(reference) {
  return removeUndefined({
    kind: reference.kind,
    sourceFile: reference.sourceFile,
    line: reference.line,
    rawPath: reference.rawPath,
    normalizedPath: reference.normalizedPath,
    gridFormat: reference.gridFormat,
    direction: reference.direction,
    catalog: reference.catalog,
    reason: reference.reason,
    transformName: reference.transform?.name,
    sourceDatum: reference.transform?.sourceDatum,
    targetDatum: reference.transform?.targetDatum,
    method: reference.transform?.method,
  });
}

function stripComment(line) {
  return line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
}

function normalizeDictionaryPath(value) {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function normalizeKey(value) {
  return normalizeDictionaryPath(value).toLowerCase();
}

function hasWildcard(value) {
  return /[*?]/.test(value);
}

function wildcardToRegExp(value) {
  const escaped = normalizeDictionaryPath(value)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function extensionOf(file) {
  const base = path.posix.basename(file).toLowerCase();
  for (const special of ["._par", "._nt", "._02"]) {
    if (base.endsWith(special)) return special;
  }
  return path.posix.extname(file);
}

function referenceKey(reference) {
  return JSON.stringify(reference);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function joinUrl(...parts) {
  return `/${parts.flatMap((part) => String(part).split("/").filter(Boolean)).map(encodeURIComponent).join("/")}`;
}

function emptyMaterialization() {
  return { copied: 0, symlinked: 0, reused: 0, fallbackCopied: 0 };
}

function mergeMaterialization(...items) {
  const merged = emptyMaterialization();
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      merged[key] += value;
    }
  }
  return merged;
}

function omitMaterialization(value) {
  const { materialization, ...rest } = value;
  return rest;
}

function sumBytes(files) {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function relativeToRoot(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  return relative.startsWith("..") ? absolute : toPosix(relative);
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}
