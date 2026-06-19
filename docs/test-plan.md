# Test Plan

The suite should answer three questions:

1. Can both libraries be built and loaded on this machine?
2. Does CS-MAP still pass its own dictionary and conversion smoke tests?
3. Do CS-MAP and PROJ agree on equivalent CRS transforms within explicit tolerances?
4. Where do CS-MAP useful ranges differ from the corresponding PROJ/EPSG area-of-use bboxes?

## Current Automated Gate

`make test` runs:

- `csmap-test`: builds CS-MAP, compiles dictionaries, and runs the upstream `QuickTest`.
- `proj-smoke`: verifies PROJ can resolve `EPSG:3857`.
- `bin/parity_tests`: compares CS-MAP C API results with PROJ C API results and reports CRS extent metadata differences.
- `make app`: builds the native `bin/live_compare` runner and TypeScript web app so arbitrary CRS pairs can be compared through the local browser UI.

The initial parity cases intentionally avoid datum-grid-dependent transforms. That keeps the first gate deterministic while we are still evaluating library behavior.

## Current Parity Cases

- WGS84 geographic to Web Mercator, forward and inverse.
- NAD83 geographic to UTM zone 18, forward and inverse.
- NAD83 geographic to Pennsylvania South State Plane.
- NAD83 geographic to Colorado Central State Plane.
- NAD83 geographic to California Zone III State Plane.

## Current Extent Cases

The extent comparison is intentionally difference-oriented. CS-MAP stores a useful range, while PROJ exposes the EPSG area of use. The runner labels non-identical extents as `DIFF`, prints both bboxes, and includes `reported_differences` in the summary. It still records whether the CS-MAP bbox contains the PROJ bbox, but containment is context, not a pass condition that hides the difference.

- WGS84 geographic.
- WGS84 Web Mercator.
- NAD83 UTM zone 18.
- NAD83 Pennsylvania South State Plane.
- NAD83 Colorado Central State Plane.
- NAD83 California Zone III State Plane.

## Next Cases To Add

- Datum shifts with required grids, with tests split by grid availability.
- CRS name and EPSG mapping tests, especially CS-MAP names that do not map one-to-one to EPSG names.
- WKT import/export tests for definitions that both libraries should parse.
- Out-of-domain and invalid-input tests so error behavior is captured explicitly.
- Antimeridian-crossing extent tests, such as NAD83 geographic.
- Saved live-comparison fixtures for CRS pairs discovered through the web app.
- Performance smoke tests once correctness cases are stable.
