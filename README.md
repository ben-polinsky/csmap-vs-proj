# CS-MAP vs PROJ

Small comparison harness for getting CS-MAP and PROJ running side by side.

## What is here

- `vendor/csmap`: local CS-MAP checkout cloned from `/Users/benjaminpolinsky/source/csmap`.
- `patches/csmap-macos-clang.patch`: portability patch needed for Apple Clang.
- `src/compare.cpp`: C++ smoke comparison using CS-MAP's C API and PROJ's C API.
- `src/live_compare.cpp`: JSON-emitting native runner used by the live web API.
- `src/compare_core.cpp`: shared comparison core used by both the native runner and browser WASM runtime.
- `server/server.ts`: local TypeScript HTTP server for the web app and comparison API.
- `web/app.ts`: TypeScript browser app for report filtering and ad hoc CRS comparisons.
- `web/compare-worker.js`: browser Worker that loads the WASM runtime, runs comparisons off the main thread, and lazy-loads grid resources.
- `wasm/csmap-data-policy.json`: data packaging policy for core preloads and lazy grid packs.
- `Makefile`: top-level build and run targets.

## Quick start

```sh
make bootstrap
make test
```

`make bootstrap` installs Homebrew `proj` if `pkg-config` cannot find it, applies the CS-MAP macOS patch if needed, and runs the full `make test` gate.

After bootstrapping, use:

```sh
make test
```

That runs CS-MAP's bundled quick test, verifies PROJ can resolve `EPSG:3857`, and runs the side-by-side parity suite.

`make run` remains as a small readable demo for the Web Mercator comparison.

## Browser WASM workflow

The browser path is the default live comparison engine. The app loads CS-MAP and PROJ in a Web Worker, preloads the core CS-MAP/PROJ resources, and fetches large grid/data files from the generated manifest only when a transform needs them. The native `/api/compare` route stays available as an oracle and fallback.

The verified local Emscripten setup is repo-local and ignored:

```sh
git clone https://github.com/emscripten-core/emsdk.git wasm/vendor/emsdk
./wasm/vendor/emsdk/emsdk install latest
./wasm/vendor/emsdk/emsdk activate latest
brew install cmake
```

The current local install resolves `latest` to Emscripten `6.0.0`. The build scripts also look for an already-active `EMSDK` or nearby `emsdk` checkout before failing.

Use the WASM targets:

```sh
make wasm-toolchain-check
make wasm
make wasm-test
make app
make serve
```

`make wasm` builds PROJ `9.8.1` from source for Emscripten, builds CS-MAP as a WASM static archive, materializes the browser data manifest, and writes the runtime to `web/wasm/compare-runtime.js`. `make wasm-test` verifies the expected WASM, CS-MAP, PROJ, and manifest artifacts exist.

Generated toolchain, build, runtime, and data outputs are ignored on purpose:

- `wasm/vendor/`
- `wasm/build/`
- `wasm/dist/`
- `web/wasm/`
- `web/wasm-data/`

Do not commit the generated data bundle. Core dictionaries are embedded in the Emscripten `.data` package; large grids are symlinked or copied into `web/wasm-data/` and fetched on demand.

## Current comparison

The first smoke test compares:

- CS-MAP: `LL84` -> `WGS84.PseudoMercator`
- PROJ: `EPSG:4326` -> `EPSG:3857`

Both paths use longitude/latitude input order.

The automated comparison uses explicit tolerances for coordinate results. Extents are reported as exact metadata differences: non-identical extents are labeled `DIFF`, both bboxes are printed, and the summary includes `reported_differences`.

## Web app

```sh
make app
make serve
```

`make app` regenerates `web/report.js`, builds `bin/live_compare`, and compiles the TypeScript server/client. `make serve` hosts the app and live API at `http://127.0.0.1:4173`.

The static server sends the COOP/COEP headers required by pthread-backed WASM, serves `.wasm` as `application/wasm`, and disables static asset caching for reliable local rebuild checks.

The live app exposes:

- `GET /api/crs`: CS-MAP CRS catalog parsed from `coordsys.asc`.
- `POST /api/compare`: runs CS-MAP and PROJ against the supplied source/target CRS and coordinate, then returns raw coordinate deltas and target extent differences. The request can provide `sourceEpsg` and `targetEpsg`; the server resolves those to the best non-legacy CS-MAP CRS names it can find in the vendored dictionary and uses `EPSG:<code>` for PROJ. Explicit `sourceCsmap`, `targetCsmap`, `sourceProj`, and `targetProj` values still override the resolved defaults.

Browser smoke cases verified on this branch:

- `LL84` -> `WGS84.PseudoMercator` vs `EPSG:4326` -> `EPSG:3857`, using browser WASM with no native fallback.
- `LL83` -> `PA83-S` vs `EPSG:4269` -> `EPSG:32129`, using browser WASM with no native fallback.
- `LL27` -> `LL83` vs `EPSG:4267` -> `EPSG:4269`, lazy-loading NADCON and VERTCON resources before retrying successfully in browser WASM.

## Test plan

See `docs/test-plan.md` for the current test strategy and the next comparison areas to add.
