#!/usr/bin/env node
"use strict";

const baseUrl = (process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:4173").replace(/\/+$/, "");

async function requestJson(path, init, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const health = await requestJson("/api/health");
  if (health.status !== "ok") {
    throw new Error(`/api/health returned unexpected status: ${JSON.stringify(health)}`);
  }

  const crs = await requestJson("/api/crs");
  if (!Array.isArray(crs.items) || crs.items.length < 1000) {
    throw new Error(`/api/crs returned too few CRS entries: ${crs.items?.length ?? "missing"}`);
  }

  const compare = await requestJson("/api/compare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEpsg: "4326",
      targetEpsg: "3857",
      x: -75.1652,
      y: 39.9526,
    }),
  });

  if (!compare.csmap?.ok || !compare.proj?.ok) {
    throw new Error(`/api/compare failed: ${JSON.stringify(compare)}`);
  }

  if (typeof compare.delta !== "number" || compare.delta > 1) {
    throw new Error(`/api/compare returned unexpected delta: ${JSON.stringify(compare.delta)}`);
  }

  const invalidCompare = await requestJson(
    "/api/compare",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceEpsg: "not-an-epsg",
        targetEpsg: "3857",
        x: -75.1652,
        y: 39.9526,
      }),
    },
    400,
  );
  if (!/sourceEpsg/.test(String(invalidCompare.error))) {
    throw new Error(`/api/compare invalid-input error was unexpected: ${JSON.stringify(invalidCompare)}`);
  }

  console.log(`Deploy smoke passed for ${baseUrl}`);
  console.log(`CRS entries: ${crs.items.length}`);
  console.log(`EPSG:4326 -> EPSG:3857 delta: ${compare.delta}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
