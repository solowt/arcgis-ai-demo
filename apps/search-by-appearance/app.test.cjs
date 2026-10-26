"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({
  document: { getElementById: () => ({ value: "", addEventListener() {}, setAttribute() {}, querySelectorAll: () => [] }) },
  window: { addEventListener() {}, require() {} },
  setTimeout() {},
  clearTimeout() {},
});
vm.runInContext(readFileSync(join(__dirname, "app.js"), "utf8"), context);
const { createSearchRegions, createRegionImage, createAppearancePrompt, parseAppearanceResult, regionToMapPolygon, filterAppearanceResults } = context;

test("partitions even, odd, and small images into stable regions without gaps or overlap", () => {
  for (const gridSize of [3, 4, 6]) {
    for (const [width, height] of [[200, 100], [201, 101], [gridSize, gridSize]]) {
      const regions = createSearchRegions(width, height, gridSize);
      const coverage = new Uint8Array(width * height);
      assert.equal(regions.length, gridSize * gridSize);
      assert.equal(new Set(regions.map((region) => region.id)).size, regions.length);
      assert.equal(regions[0].id, "A1");
      assert.equal(regions.at(-1).id, `${String.fromCharCode(64 + gridSize)}${gridSize}`);
      for (const region of regions) {
        for (let row = region.ymin; row < region.ymax; row++) {
          for (let column = region.xmin; column < region.xmax; column++) coverage[row * width + column]++;
        }
        const { crop } = region;
        assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= width && crop.y + crop.height <= height);
        assert.ok(crop.x <= region.xmin && crop.y <= region.ymin);
        assert.ok(crop.x + crop.width >= region.xmax && crop.y + crop.height >= region.ymax);
      }
      assert.ok(coverage.every((count) => count === 1));
    }
  }
});

test("rejects unsupported grids and images too small for their grid", () => {
  for (const args of [[100, 100, 5], [2, 100, 3], [100, 3, 4], [100.5, 100, 4]]) {
    assert.throws(() => createSearchRegions(...args), /selected grid/);
  }
});

test("pads interior cells while preserving their exact original bounds", () => {
  const region = createSearchRegions(400, 400, 4)[5];
  assert.deepEqual(structuredClone(region), {
    id: "B2", xmin: 100, ymin: 100, xmax: 200, ymax: 200,
    crop: { x: 80, y: 80, width: 140, height: 140 },
  });
});

test("crops original pixels and outlines only the region, with a clean thumbnail option", () => {
  const region = createSearchRegions(400, 400, 4)[5];
  const imageData = { width: 400, height: 400 };
  for (const outline of [true, false]) {
    const calls = [];
    const drawing = {
      putImageData: (...args) => calls.push(["source", ...args]),
      strokeRect: (...args) => calls.push(["outline", ...args]),
    };
    const canvas = {
      getContext: () => drawing,
      toDataURL: (format) => { assert.equal(format, "image/png"); return "data:image/png;base64,region"; },
    };
    context.document.createElement = () => canvas;
    try {
      assert.equal(createRegionImage(imageData, region, outline), "data:image/png;base64,region");
      assert.equal(canvas.width, 140);
      assert.equal(canvas.height, 140);
      assert.deepEqual(calls, outline ? [
        ["source", imageData, -80, -80, 80, 80, 140, 140], ["outline", 20, 20, 100, 100],
      ] : [["source", imageData, -80, -80, 80, 80, 140, 140]]);
    } finally {
      delete context.document.createElement;
    }
  }
});

test("prompts bind the description to a known region and request evidence instead of geometry", () => {
  const region = { id: "B2" };
  const prompt = createAppearancePrompt('  warehouses beside "large lots"  ', region);
  assert.ok(prompt.includes(JSON.stringify('warehouses beside "large lots"')));
  assert.ok(prompt.includes('"id":"B2"'));
  assert.ok(prompt.includes("outside it is context only"));
  assert.ok(prompt.includes('"uncertain"'));
  assert.ok(prompt.includes("no coordinates"));
});

test("parses all match outcomes as JSON objects, strings, or fenced JSON", () => {
  for (const status of ["match", "no_match", "uncertain"]) {
    const result = { id: "A1", status, evidence: "  Visible rooftops  " };
    const json = JSON.stringify(result);
    for (const value of [result, json, `\`\`\`json\n${json}\n\`\`\``]) {
      assert.deepEqual(structuredClone(parseAppearanceResult(value, { id: "A1" })), { status, evidence: "Visible rooftops" });
    }
  }
});

test("rejects unknown IDs, malformed decisions, and absent visual evidence", () => {
  for (const value of [
    "not JSON", null, {}, [],
    { id: "A2", status: "match", evidence: "Visible" },
    { id: "A1", status: true, evidence: "Visible" },
    { id: "A1", status: "match", evidence: "  " },
    { id: "A1", status: "match", evidence: {} },
  ]) assert.throws(() => parseAppearanceResult(value, { id: "A1" }), /Region A1/);
});

test("maps known regions using captured coordinates, including rotation and scaling", () => {
  const capture = {
    width: 200, height: 100, spatialReference: { wkid: 3857 },
    topLeft: { x: 10, y: 1000 }, topRight: { x: 410, y: 1000 }, bottomLeft: { x: 10, y: 600 },
  };
  const region = { xmin: 50, ymin: 25, xmax: 100, ymax: 75 };
  const polygon = regionToMapPolygon(region, capture);
  assert.equal(polygon.type, "polygon");
  assert.deepEqual(structuredClone(polygon.rings), [[[110, 900], [210, 900], [210, 700], [110, 700], [110, 900]]]);
  assert.deepEqual(structuredClone(regionToMapPolygon({ xmin: 25, ymin: 12.5, xmax: 50, ymax: 37.5 }, {
    ...capture, width: 100, height: 50,
  })), structuredClone(polygon));
  assert.deepEqual(structuredClone(regionToMapPolygon({ xmin: 0, ymin: 0, xmax: 50, ymax: 25 }, {
    ...capture, width: 100, height: 100,
    topLeft: { x: 100, y: 200 }, topRight: { x: 100, y: 300 }, bottomLeft: { x: 200, y: 200 },
  }).rings), [[[100, 200], [100, 250], [125, 250], [125, 200], [100, 200]]]);
});

test("filters and orders results without mutating the stored classification", () => {
  const regions = [
    { id: "B2", status: "uncertain" }, { id: "B1", status: "match" },
    { id: "A2", status: "no_match" }, { id: "A1", status: "match" },
  ];
  assert.deepEqual(structuredClone(filterAppearanceResults(regions, "match")), [regions[3], regions[1]]);
  assert.deepEqual(structuredClone(filterAppearanceResults(regions, "all")), [regions[3], regions[1], regions[0], regions[2]]);
  assert.equal(filterAppearanceResults(regions, "uncertain")[0], regions[0]);
  assert.equal(regions[0].id, "B2");
});