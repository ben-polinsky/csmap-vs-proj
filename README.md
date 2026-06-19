# CS-MAP vs PROJ

Small comparison harness for getting CS-MAP and PROJ running side by side.

## What is here

- `vendor/csmap`: local CS-MAP checkout cloned from `/Users/benjaminpolinsky/source/csmap`.
- `patches/csmap-macos-clang.patch`: portability patch needed for Apple Clang.
- `src/compare.cpp`: C++ smoke comparison using CS-MAP's C API and PROJ's C API.
- `src/live_compare.cpp`: JSON-emitting native runner used by the live web API.
- `server/server.ts`: local TypeScript HTTP server for the web app and comparison API.
- `web/app.ts`: TypeScript browser app for report filtering and ad hoc CRS comparisons.
- `package.json`: npm-managed TypeScript toolchain plus the Leaflet browser map dependency.
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

`make app` installs npm dependencies as needed, regenerates `web/report.js`, builds `bin/live_compare`, and compiles the TypeScript server/client. `make serve` hosts the app and live API at `http://127.0.0.1:4173`.

The live app exposes:

- `GET /api/crs`: CS-MAP CRS catalog parsed from `coordsys.asc`.
- `POST /api/compare`: runs CS-MAP and PROJ against the supplied source/target CRS and coordinate, then returns raw coordinate deltas and target extent differences. The request can provide `sourceEpsg` and `targetEpsg`; the server resolves those to the best non-legacy CS-MAP CRS names it can find in the vendored dictionary and uses `EPSG:<code>` for PROJ. Explicit `sourceCsmap`, `targetCsmap`, `sourceProj`, and `targetProj` values still override the resolved defaults.

Extent comparisons render with Leaflet and OpenStreetMap tiles, while the adjacent bbox tables remain the exact data source for CS-MAP and PROJ edge values.

## Test plan

See `docs/test-plan.md` for the current test strategy and the next comparison areas to add.
