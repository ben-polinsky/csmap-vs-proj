# Deployment Plan

This app has two deployment tracks:

- Current native-server track: deploy a small containerized web service.
- Browser-native track: compile the comparison engine to WASM, then deploy as static files.

The current recommendation is to ship the verified Docker path first, then run a separate WASM-native spike. WASM can become the best long-term free-hosting answer, but it is an architecture slice, not a deploy-only change.

The current runtime is a Node HTTP server that serves the browser app and shells out to a native `bin/live_compare` binary for each live comparison. That binary links CS-MAP and PROJ, and the server reads CS-MAP dictionaries from `vendor/csmap/CsMapDev/Dictionaries`. The deployable unit therefore needs Node, the compiled native binary, PROJ runtime data, and the CS-MAP dictionary files in one filesystem layout.

## Recommendation

Use Docker as the deployment contract for the current app, then deploy the same image to one free or near-free host first.

Ranked targets:

1. Google Cloud Run
   - Best technical fit for this app: it runs a normal container, supports public HTTPS services, scales to zero, and has a documented monthly free tier.
   - Best when a billing-enabled Google Cloud project is acceptable.
   - Caveat: more account/project setup than the hobby PaaS options.
   - Source: https://cloud.google.com/run/pricing and https://docs.cloud.google.com/run/docs/deploying

2. Render Free Web Service
   - Best low-friction demo host: Git-backed web service, Dockerfile support, managed TLS, custom domains, and no database needed.
   - Caveat: free services spin down after 15 minutes without inbound traffic and can take about a minute to wake back up. Render also grants 750 free instance hours per workspace per month.
   - Source: https://render.com/docs/free and https://render.com/docs/docker

3. Koyeb Free Instance
   - Good alternate free container host. The free instance is a web service with 512 MB RAM, 0.1 vCPU, 2 GB SSD, one free instance per organization, and scale-to-zero after one hour without traffic.
   - Caveat: the 2 GB local SSD and small CPU budget make image size and native build/runtime cost worth checking early.
   - Source: https://www.koyeb.com/docs/reference/instances and https://www.koyeb.com/docs/build-and-deploy/prebuilt-docker-images

4. Fly.io
   - Strong technical fit for the current Docker image: normal container runtime, no database required, public HTTPS app, and autostop/autostart for sporadic demo traffic.
   - Best when "very low cost" is acceptable and developer ergonomics matter more than a strict zero-dollar guarantee.
   - Caveat: Fly is not a primary free-hosting target. Fly's docs state there is no free account/free tier, free allowances do not cap bills, the free trial is limited to 2 VM runtime hours or 7 days, stopped Machines still incur root filesystem charges, and dedicated IPv4 addresses cost extra.
   - Source: https://fly.io/docs/about/cost-management/, https://fly.io/docs/about/free-trial/, https://fly.io/docs/about/pricing/, and https://fly.io/docs/launch/autostop-autostart/

5. Oracle Cloud Always Free VM
   - Best no-sleep zero-dollar option: an Always Free VM gives full Linux control for Docker/systemd/nginx and avoids PaaS idle sleep.
   - Best when always-on matters more than deployment simplicity.
   - Caveat: this is real VM ops. It needs firewalling, TLS/reverse proxy setup, patching, process supervision, and ARM testing if using the Ampere A1 shape. Oracle also notes idle Always Free compute instances may be reclaimed.
   - Source: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

6. Railway Free
   - Usable for a short test, but not the best "free forever" answer. Railway lists a 30-day trial with $5 credits and then $1 per month on the Free plan.
   - Source: https://railway.com/pricing and https://docs.railway.com/builds/dockerfiles

Avoid as primary targets for the current app:

- Vercel, Netlify, Cloudflare Pages/Workers, and GitHub Pages are excellent for static/front-end deployment, but this app currently needs a long-running Node process plus a native executable. They become attractive only if the compare engine is moved to WASM, split behind a separate backend, or reduced to precomputed/static reports.
- Fly.io should not be described as free. It belongs in the near-free Docker lane, not the strict free-hosting lane.

## Deployment Readiness Work

1. Make CS-MAP fetch deterministic.
   - Current `.gitmodules` points `vendor/csmap` at `../csmap`, and the worktree submodule config points at a local absolute path. Hosted builders need either a public absolute URL or a build script that clones the intended CS-MAP source explicitly.
   - Implemented: `.gitmodules` now points to `https://github.com/eharris/csmap.git`, and the Dockerfile clones that repo at the recorded submodule commit.
   - Implemented: `.gcloudignore` excludes the local vendored checkout and generated artifacts so Cloud Build uploads only source files; the Dockerfile still clones the pinned CS-MAP ref during the image build.

2. Add a container build.
   - Start with a simple, reliable Dockerfile before optimizing image size.
   - Build stage should install `git`, `make`, `clang`, `pkg-config`, Node, and PROJ development packages.
   - Build stage should initialize CS-MAP, apply the existing patch if needed, run `make app`, and verify the binary exists.
   - Runtime stage should include Node, PROJ runtime packages/data, `dist/server`, `web`, `bin/live_compare`, and CS-MAP dictionaries.
   - Implemented: `Dockerfile` builds `make test` in a Debian/Node image and copies only the runtime artifacts into the final image.

3. Make the server PaaS-friendly.
   - Add an npm `start` script for `node dist/server/server.js`.
   - Set runtime env as `HOST=0.0.0.0` and `PORT=$PORT`.
   - Consider keeping the local default `127.0.0.1`, but document that hosted services must override it.
   - Implemented: `npm start` exists, `render.yaml` sets `HOST=0.0.0.0`, and the Docker image defaults `HOST=0.0.0.0`.
   - Implemented: `/api/health` verifies the web directory, CS-MAP `coordsys.asc`, and native `bin/live_compare` are present.

4. Add a deploy smoke check.
   - `GET /api/crs` should return a non-empty `items` array.
   - `POST /api/compare` should validate `EPSG:4326` to `EPSG:3857` for a known longitude/latitude input.
   - This can be a small script that accepts `BASE_URL` so it works locally and after deployment.
   - Implemented: `npm run smoke:deploy` runs `scripts/deploy-smoke.js` against `BASE_URL` or a URL argument.

5. Fix docs/build drift.
   - `docs/test-plan.md` currently says `make test` includes `make app`, but the Makefile does not. Before deployment, either make that true or adjust the docs so the verification gate is unambiguous.
   - Implemented: `make test` now includes the `app` target.

6. Bound live comparison work.
   - Public hosts should not allow unlimited native child processes per instance.
   - Implemented: the server uses `COMPARE_CONCURRENCY` and `COMPARE_QUEUE_LIMIT`; Render and Docker default to `2` active native comparisons with a queue of `16`.

7. Make PROJ runtime behavior explicit.
   - The first public build keeps `PROJ_NETWORK=OFF` and `PROJ_DATA=/usr/share/proj` so the container uses bundled PROJ data rather than network grid downloads. Grid-dependent transforms should be added later as an explicit product/test slice.

## First Deploy Path

1. Create the Dockerfile and `.dockerignore`.
2. Build locally: `docker build -t csmap-vs-proj .`
3. Run locally: `docker run --rm -p 4173:4173 -e HOST=0.0.0.0 -e PORT=4173 csmap-vs-proj`
4. Smoke test:
   - `curl http://127.0.0.1:4173/api/crs`
   - `curl -X POST http://127.0.0.1:4173/api/compare ...`
5. Deploy to Render first if the goal is the fastest public demo.
6. Deploy to Cloud Run first if the goal is the most production-shaped free path.
7. Deploy to Fly first if the goal is the smoothest low-cost Docker experience and a billable account is acceptable.
8. Record the selected host, public URL, cold-start behavior, and smoke-test output in this doc.

## Fly.io Path

Fly is ready to evaluate from the existing Docker image. The repo includes `fly.toml.example` as a starting point with:

- `internal_port = 4173`, matching the Docker image.
- `auto_stop_machines = "stop"`, `auto_start_machines = true`, and `min_machines_running = 0` for low-traffic demos.
- `/api/health` as the health check.
- The same PROJ and compare-concurrency env vars as the Render/Docker path.

Expected commands:

```sh
cp fly.toml.example fly.toml
fly launch --no-deploy
fly deploy
npm run smoke:deploy -- https://<app-name>.fly.dev
```

Do not choose a dedicated IPv4 address unless it is needed. Keep the public URL on the default Fly hostname for the first pass.

## Current Verification

Verified locally on 2026-06-19:

- `npm run build` passed.
- `make test` passed after initializing `vendor/csmap` from `https://github.com/eharris/csmap.git`; the gate reported `summary assertions=30 failures=0 reported_differences=6`.
- `npm run smoke:deploy -- http://127.0.0.1:4173` passed against the local Node server, reporting `CRS entries: 7836` and `EPSG:4326 -> EPSG:3857 delta: 0`.
- `docker build -t csmap-vs-proj .` passed; the Docker build runs `make test` inside the image.
- `npm run smoke:deploy -- http://127.0.0.1:4173` passed against the built Docker container with the same `7836` CRS entries and `0` compare delta.

Verified on Cloud Run on 2026-06-23:

- Project: `csmap-vs-proj`
- Region: `us-central1`
- Service: `csmap-vs-proj`
- Revision: `csmap-vs-proj-00001-bnj`
- Image: `us-central1-docker.pkg.dev/csmap-vs-proj/csmap-vs-proj/csmap-vs-proj:ae597ac`
- Public URL: `https://csmap-vs-proj-7ohnhfokpa-uc.a.run.app`
- `npm run smoke:deploy -- https://csmap-vs-proj-7ohnhfokpa-uc.a.run.app` passed, reporting `CRS entries: 7836` and `EPSG:4326 -> EPSG:3857 delta: 0`.
- Cloud Run settings: `512Mi` memory, `1` CPU, `min-instances=0`, `max-instances=1`, container concurrency `16`, and compare env vars `COMPARE_CONCURRENCY=2`, `COMPARE_QUEUE_LIMIT=16`.

Not yet done:

- Cold-start latency and sustained request latency should still be measured from a clean idle service.
- Render/Koyeb runtime behavior has not been measured.

## WASM-Native Static Track

If we move the live comparison engine into the browser, the host ranking changes. The app becomes static HTML, CSS, JS, WASM, and data files, so Cloudflare Pages, GitHub Pages, Netlify, and Vercel become strong free targets.

Likely static-host ranking after a working WASM build:

1. Cloudflare Pages
   - Strong free static fit: global static hosting, unlimited static requests/bandwidth in the public pricing copy, and documented Free plan file/build limits.
   - Source: https://pages.cloudflare.com/ and https://developers.cloudflare.com/pages/platform/limits/

2. GitHub Pages
   - Simplest zero-dollar path for a public repo or project demo. GitHub Pages is explicitly static hosting for HTML, CSS, and JavaScript files from a repository.
   - Caveat: less flexible for headers and build/runtime customization than Cloudflare/Netlify/Vercel.
   - Source: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages

3. Netlify or Vercel
   - Good developer experience, previews, domains, and CDN behavior for static output.
   - Caveat: plan constraints and commercial-use rules need a final read before choosing either as the canonical free host.
   - Source: https://www.netlify.com/pricing/ and https://vercel.com/docs/plans/hobby

WASM-native M0 should be deliberately narrow:

1. Build a `wasm/` proof that compiles a small CS-MAP/PROJ comparison wrapper with Emscripten.
   - Emscripten supports replacing normal C/C++ compiler flows with `emconfigure`, `emmake`, and `emcc`.
   - Source: https://emscripten.org/docs/compiling/Building-Projects.html

2. Package only the minimum data required for current parity cases.
   - CS-MAP needs dictionary files.
   - PROJ needs `proj.db`; official PROJ docs state the database must be accessible for the library to work properly.
   - Source: https://proj.org/en/stable/resource_files.html

3. Keep PROJ network/grid behavior explicit.
   - The first WASM proof should keep remote grid downloads out of scope and only support transforms covered by packaged data.
   - PROJ can use network grid access in native environments, but browser/static deployment should treat grid downloads as a separate feature and test slice.
   - Source: https://proj.org/en/stable/usage/network.html

4. Run the WASM module in a Web Worker behind the same logical API shape as `POST /api/compare`.
   - The UI should be able to switch between server compare and worker compare with minimal changes.
   - Heavy transforms should not block the main thread.

5. Add a parity gate before changing the canonical deployment.
   - Native `bin/live_compare` remains the oracle.
   - WASM output must match the existing smoke and parity cases before static hosting replaces the container path.

Main risks:

- Building PROJ plus its dependencies for browser WASM may take more work than compiling the small project wrapper.
- `proj.db`, CS-MAP dictionaries, and any future grid files can turn into a payload-size problem.
- Some datum/grid-dependent transforms may be unavailable until selected grids are packaged or a browser-safe network-data policy exists.
- Browser CPU and memory limits may require caching, lazy loading, and careful worker lifecycle management.

Decision: keep Docker as the fastest public-demo path. Start WASM-native as the next product/architecture spike if the goal is a durable zero-dollar static deployment.
