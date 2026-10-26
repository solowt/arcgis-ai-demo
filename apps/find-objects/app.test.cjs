"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({
  document: { getElementById: () => ({ value: "", addEventListener() {}, setAttribute() {} }) },
  window: { addEventListener() {}, require() {} },
  setTimeout() {},
  clearTimeout() {},
});
vm.runInContext(readFileSync(join(__dirname, "app.js"), "utf8"), context);
const {
  createDetectionPrompt, createVerificationPrompt, parseVerificationResults, selectVisibleBoxes, getBoxStyle, parseHouseBoxes,
  getImageTiles, mergeTileBoxes, createImageTiles, offsetTileBoxes, boxToMapPolygon, drawCaptureOverlay,
  getVerificationCrop, createVerificationSheet,
} = context;

const box = { xmin: 50, ymin: 25, xmax: 100, ymax: 75 };
const capture = {
  width: 200,
  height: 100,
  topLeft: { x: 10, y: 1000 },
  topRight: { x: 410, y: 1000 },
  bottomLeft: { x: 10, y: 600 },
  spatialReference: { wkid: 3857 },
};

test("generates the detection prompt for houses, cars, and other object names", () => {
  for (const objectType of ["house", "car", "cars", "storage tank"]) {
    const prompt = createDetectionPrompt(objectType);
    assert.ok(prompt.startsWith(`Locate all visible objects of type ${JSON.stringify(objectType)} in the image`));
    assert.ok(prompt.includes("Include plausible candidates, including small objects"));
    assert.ok(prompt.includes("(0, 0) at the top-left, x increasing right, and y increasing down"));
    assert.ok(prompt.includes('{"boxes":[{"xmin":10,"ymin":20,"xmax":50,"ymax":60}]}'));
    assert.ok(prompt.endsWith('Return {"boxes":[]} if no matching objects are visible.'));
  }
});

test("trims the object input and quotes its value in the prompt", () => {
  assert.equal(createDetectionPrompt("  parked car  "), createDetectionPrompt("parked car"));
  assert.ok(createDetectionPrompt('building "A"').includes(JSON.stringify('building "A"')));
});

test("does not generate a prompt for an empty object input", () => {
  assert.equal(createDetectionPrompt(""), "");
  assert.equal(createDetectionPrompt("   "), "");
});

test("verification uses a separate prompt with the target, stable IDs, and a decision for every box", () => {
  const boxes = [{ ...box, id: 1 }, { ...box, id: 2 }];
  const prompt = createVerificationPrompt("  car  ", boxes);
  assert.ok(prompt.startsWith('Verify the numbered candidate crops of objects of type "car"'));
  assert.ok(prompt.includes('"status":"confirmed"'));
  assert.ok(prompt.includes('"uncertain"'));
  assert.ok(prompt.includes('"rejected"'));
  assert.ok(prompt.includes("Do not turn uncertainty into rejection"));
  assert.ok(prompt.includes("Evaluate only the object inside the yellow box"));
  assert.ok(prompt.includes("exactly one decision for every supplied box ID"));
  assert.ok(prompt.includes("Do not add objects, change coordinates, or renumber boxes"));
  assert.ok(prompt.endsWith("Candidate IDs: [1,2]"));
  assert.ok(createVerificationPrompt('building "A"', boxes).includes(JSON.stringify('building "A"')));
});

test("verification preserves every decision, original coordinates, IDs, and candidate order", () => {
  const boxes = [1, 2, 3].map((id) => ({ ...box, id }));
  const result = { verifications: [
    { id: 3, status: "uncertain", reason: "  Too few pixels  " },
    { id: 1, status: "rejected", reason: "Road marking" },
    { id: 2, status: "confirmed", reason: "Vehicle outline" },
  ] };
  const json = JSON.stringify(result);
  for (const value of [result, json, `\`\`\`json\n${json}\n\`\`\``]) {
    const verified = parseVerificationResults(value, boxes);
    assert.deepEqual(structuredClone(verified), [
      { ...boxes[0], verification: "rejected", reason: "Road marking" },
      { ...boxes[1], verification: "confirmed", reason: "Vehicle outline" },
      { ...boxes[2], verification: "uncertain", reason: "Too few pixels" },
    ]);
    assert.ok(boxes.every((box) => box.verification === undefined));
  }
});

test("verification can reject every detection", () => {
  const boxes = [{ ...box, id: 1 }];
  const verified = parseVerificationResults({ verifications: [{ id: 1, status: "rejected" }] }, boxes);
  assert.equal(selectVisibleBoxes(verified, true).length, 0);
  assert.equal(parseVerificationResults({ verifications: [] }, []).length, 0);
});

test("uncertain candidates can be shown without restoring rejected detections", () => {
  const boxes = ["confirmed", "uncertain", "rejected"].map((verification, index) => ({ ...box, id: index + 1, verification }));
  assert.deepEqual(structuredClone(selectVisibleBoxes(boxes, false)), [boxes[0]]);
  assert.deepEqual(structuredClone(selectVisibleBoxes(boxes, true)), [boxes[0], boxes[1]]);
  assert.deepEqual(structuredClone(selectVisibleBoxes([{ ...box, id: 4 }], false)), [{ ...box, id: 4 }]);
  assert.deepEqual(structuredClone(getBoxStyle(boxes[0])), { color: [0, 166, 133], dashed: false });
  assert.deepEqual(structuredClone(getBoxStyle(boxes[1])), { color: [230, 126, 34], dashed: true });
});

test("rejects incomplete, duplicate, unknown, and malformed verification decisions", () => {
  const boxes = [{ ...box, id: 1 }, { ...box, id: 2 }];
  for (const value of [
    "not JSON", null, {}, { verifications: "yes" }, { verifications: [] },
    { verifications: [{ id: 1, status: "confirmed" }] },
    { verifications: [{ id: 1, status: "confirmed" }, { id: 1, status: "rejected" }] },
    { verifications: [{ id: 1, status: "confirmed" }, { id: 3, status: "confirmed" }] },
    { verifications: [{ id: "1", status: "confirmed" }, { id: 2, status: "confirmed" }] },
    { verifications: [{ id: 1, status: true }, { id: 2, status: "confirmed" }] },
    { verifications: [{ id: 1, status: "confirmed" }, { id: 2, status: "maybe" }] },
    { verifications: [{ id: 1, status: "confirmed", reason: {} }, { id: 2, status: "confirmed" }] },
    { verifications: [{ id: 1, status: "confirmed" }, { id: 2 }] },
    { verifications: [null, { id: 2, status: "confirmed" }] },
  ]) {
    assert.throws(() => parseVerificationResults(value, boxes), /Verification/);
  }
});

test("parses JSON, fenced JSON, and structured bounding-box results", () => {
  const json = JSON.stringify({ boxes: [box] });
  for (const value of [json, `Result:\n\`\`\`json\n${json}\n\`\`\``, { boxes: [box] }, [box], [[50, 25, 100, 75]]]) {
    assert.deepEqual(structuredClone(parseHouseBoxes(value, 200, 100)), [box]);
  }
});

test("accepts an empty list when no houses are found", () => {
  assert.equal(parseHouseBoxes('{"boxes":[]}', 200, 100).length, 0);
  assert.equal(parseHouseBoxes([], 200, 100).length, 0);
});

test("rejects malformed JSON and missing box lists", () => {
  for (const value of ["not JSON", "{}", null, { boxes: "none" }]) {
    assert.throws(() => parseHouseBoxes(value, 200, 100));
  }
});

test("rejects nonnumeric, reversed, degenerate, and out-of-image boxes", () => {
  for (const invalid of [
    null, {}, [0, 0, 10], [0, 0, 10, 10, 20],
    { ...box, xmin: "50" }, { ...box, xmin: NaN }, { ...box, xmax: Infinity },
    { ...box, xmin: -1 }, { ...box, ymin: -1 },
    { ...box, xmax: 201 }, { ...box, ymax: 101 },
    { ...box, xmax: 50 }, { ...box, xmax: 40 }, { ...box, ymax: 25 },
  ]) {
    assert.throws(() => parseHouseBoxes({ boxes: [invalid] }, 200, 100), /Bounding box 1/);
  }
});

test("covers even, odd, and small images with overlapping tiles inside the source bounds", () => {
  for (const [width, height] of [[200, 100], [201, 101], [2, 2], [3, 3]]) {
    const tiles = getImageTiles(width, height);
    assert.equal(tiles.length, 4);
    const coverage = new Uint8Array(width * height);
    for (const tile of tiles) {
      assert.ok(tile.width > 0 && tile.height > 0);
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= width && tile.y + tile.height <= height);
      for (let row = tile.y; row < tile.y + tile.height; row++) {
        for (let column = tile.x; column < tile.x + tile.width; column++) {
          coverage[row * width + column]++;
        }
      }
    }
    assert.ok(coverage.every((count) => count >= 1));
    assert.ok(coverage.some((count) => count > 1));
    assert.deepEqual(structuredClone(tiles[3]), {
      name: "Bottom-right", x: width - tiles[0].width, y: height - tiles[0].height,
      width: tiles[0].width, height: tiles[0].height,
    });
  }
});

test("overlaps neighboring tiles by approximately fifteen percent", () => {
  const tiles = getImageTiles(1600, 1200);
  const horizontalOverlap = (tiles[0].width - tiles[1].x) / tiles[0].width;
  const verticalOverlap = (tiles[0].height - tiles[2].y) / tiles[0].height;
  assert.ok(horizontalOverlap >= 0.15 && horizontalOverlap < 0.16);
  assert.ok(verticalOverlap >= 0.15 && verticalOverlap < 0.16);
  const boundaryBox = { xmin: 780, ymin: 580, xmax: 820, ymax: 620 };
  assert.ok(tiles.every((tile) => boundaryBox.xmin >= tile.x && boundaryBox.ymin >= tile.y
    && boundaryBox.xmax <= tile.x + tile.width && boundaryBox.ymax <= tile.y + tile.height));
});

test("merges cross-tile duplicates while preserving full coordinates and stable ordering", () => {
  const largerBox = { xmin: 48, ymin: 23, xmax: 102, ymax: 77 };
  const neighbor = { xmin: 120, ymin: 25, xmax: 150, ymax: 75 };
  const tileBoxes = [[box, neighbor], [{ ...box }], [largerBox], []];
  const snapshot = structuredClone(tileBoxes);
  assert.deepEqual(structuredClone(mergeTileBoxes(tileBoxes)), [largerBox, neighbor]);
  assert.deepEqual(tileBoxes, snapshot);
  assert.equal(mergeTileBoxes([[], [], [], []]).length, 0);
});

test("does not merge neighboring objects or collapse two detections from one tile", () => {
  const adjacent = { xmin: 99, ymin: 25, xmax: 149, ymax: 75 };
  assert.deepEqual(structuredClone(mergeTileBoxes([[box], [adjacent]])), [box, adjacent]);
  const overlapping = { xmin: 55, ymin: 25, xmax: 105, ymax: 75 };
  assert.equal(mergeTileBoxes([[box, overlapping], [{ ...box }]]).length, 2);
});

test("rejects images that cannot produce four nonempty tiles", () => {
  for (const [width, height] of [[1, 100], [200, 1], [0, 0], [2.5, 100]]) {
    assert.throws(() => getImageTiles(width, height), /too small/);
  }
});

test("crops four PNGs directly from the source pixels without resizing", () => {
  const calls = [];
  const imageData = { width: 201, height: 101 };
  const canvas = {
    getContext: () => ({ putImageData: (...args) => calls.push(args) }),
    toDataURL: (format) => {
      assert.equal(format, "image/png");
      return `data:image/png;base64,${canvas.width}x${canvas.height}`;
    },
  };
  context.document.createElement = (tag) => {
    assert.equal(tag, "canvas");
    return canvas;
  };
  try {
    const tiles = createImageTiles(imageData);
    assert.equal(calls.length, 4);
    for (const [index, tile] of tiles.entries()) {
      assert.deepEqual(calls[index], [imageData, -tile.x, -tile.y, tile.x, tile.y, tile.width, tile.height]);
      assert.equal(tile.dataUrl, `data:image/png;base64,${tile.width}x${tile.height}`);
    }
  } finally {
    delete context.document.createElement;
  }
});

test("offsets tile-local boxes into the original image before map conversion", () => {
  const localBox = { xmin: 10, ymin: 5, xmax: 30, ymax: 25 };
  const tiles = getImageTiles(capture.width, capture.height);
  for (const tile of tiles) {
    const boxes = parseHouseBoxes({ boxes: [localBox] }, tile.width, tile.height);
    const shifted = offsetTileBoxes(boxes, tile)[0];
    assert.deepEqual(structuredClone(shifted), {
      xmin: 10 + tile.x, ymin: 5 + tile.y, xmax: 30 + tile.x, ymax: 25 + tile.y,
    });
    const polygon = boxToMapPolygon(shifted, capture);
    assert.deepEqual(structuredClone(polygon.rings[0][0]), [
      10 + (10 + tile.x) * 2, 1000 - (5 + tile.y) * 4,
    ]);
  }
  assert.deepEqual(localBox, { xmin: 10, ymin: 5, xmax: 30, ymax: 25 });
});

test("validates boxes against tile bounds, not full-image bounds", () => {
  const tile = getImageTiles(201, 101)[3];
  const fullTile = { xmin: 0, ymin: 0, xmax: tile.width, ymax: tile.height };
  const boxes = parseHouseBoxes({ boxes: [fullTile] }, tile.width, tile.height);
  assert.deepEqual(structuredClone(offsetTileBoxes(boxes, tile)), [{ xmin: tile.x, ymin: tile.y, xmax: 201, ymax: 101 }]);
  assert.throws(() => parseHouseBoxes({ boxes: [{ ...fullTile, xmax: 200 }] }, tile.width, tile.height));
  assert.equal(offsetTileBoxes([], tile).length, 0);
});

test("maps top-left image coordinates into a closed clockwise polygon", () => {
  const polygon = structuredClone(boxToMapPolygon(box, capture));
  assert.equal(polygon.type, "polygon");
  assert.deepEqual(polygon.spatialReference, { wkid: 3857 });
  assert.deepEqual(polygon.rings, [[[110, 900], [210, 900], [210, 700], [110, 700], [110, 900]]]);
});

test("maps image boundaries to the captured map corners", () => {
  const polygon = structuredClone(boxToMapPolygon({ xmin: 0, ymin: 0, xmax: 200, ymax: 100 }, capture));
  assert.deepEqual(polygon.rings, [[[10, 1000], [410, 1000], [410, 600], [10, 600], [10, 1000]]]);
});

test("uses screenshot dimensions when the screenshot is scaled down", () => {
  const smallerCapture = { ...capture, width: 100, height: 50 };
  const smallerBox = { xmin: 25, ymin: 12.5, xmax: 50, ymax: 37.5 };
  assert.deepEqual(
    structuredClone(boxToMapPolygon(smallerBox, smallerCapture)),
    structuredClone(boxToMapPolygon(box, capture)),
  );
});

test("preserves alignment when the captured map is rotated", () => {
  const rotatedCapture = {
    ...capture,
    width: 100,
    height: 100,
    topLeft: { x: 100, y: 200 },
    topRight: { x: 100, y: 300 },
    bottomLeft: { x: 200, y: 200 },
  };
  const polygon = structuredClone(boxToMapPolygon({ xmin: 0, ymin: 0, xmax: 50, ymax: 25 }, rotatedCapture));
  assert.deepEqual(polygon.rings, [[[100, 200], [100, 250], [125, 250], [125, 200], [100, 200]]]);
});

test("draws the original image and overlays raw pixel coordinates without map conversion", () => {
  const calls = [];
  const drawingContext = {
    putImageData: (...args) => calls.push(["image", ...args]),
    setLineDash() {},
    strokeRect: (...args) => calls.push(["box", ...args]),
  };
  const canvas = { getContext: () => drawingContext };
  const imageData = { width: 200, height: 100 };
  drawCaptureOverlay(canvas, imageData, [box, { xmin: 0, ymin: 0, xmax: 200, ymax: 100 }]);
  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 100);
  assert.deepEqual(calls, [["image", imageData, 0, 0], ["box", 50, 25, 50, 50], ["box", 0, 0, 200, 100]]);
  assert.equal(drawingContext.strokeStyle, "rgb(255,208,0)");
});

test("draws original pixels with readable stable box numbers in the full-image preview", () => {
  const calls = [];
  const imageData = { width: 200, height: 100 };
  const boxes = [{ ...box, id: 1 }, { xmin: 190, ymin: 5, xmax: 200, ymax: 10, id: 12 }];
  const drawingContext = {
    putImageData: (...args) => calls.push(["image", ...args]),
    setLineDash() {},
    strokeRect: (...args) => calls.push(["box", ...args]),
    measureText: (label) => ({ width: label.length * 8 }),
    fillRect: (...args) => calls.push(["label", ...args]),
    fillText: (...args) => calls.push(["text", ...args]),
  };
  const canvas = { getContext: () => drawingContext };
  drawCaptureOverlay(canvas, imageData, boxes, true, true);
  assert.equal(canvas.width, imageData.width);
  assert.equal(canvas.height, imageData.height);
  assert.deepEqual(calls, [
    ["image", imageData, 0, 0], ["box", 50, 25, 50, 50], ["box", 190, 5, 10, 5],
    ["label", 50, 3, 16, 22], ["text", "1", 54, 6],
    ["label", 176, 10, 24, 22], ["text", "12", 180, 13],
  ]);
  assert.equal(drawingContext.font, "bold 16px sans-serif");
});

test("pads candidate crops with context and clips them to the original image", () => {
  assert.deepEqual(structuredClone(getVerificationCrop(box, 200, 100)), { x: 25, y: 0, width: 100, height: 100 });
  assert.deepEqual(structuredClone(getVerificationCrop({ xmin: 190, ymin: 90, xmax: 200, ymax: 100 }, 200, 100)), {
    x: 178, y: 78, width: 22, height: 22,
  });
  for (const edgeBox of [
    { xmin: 0, ymin: 0, xmax: 10, ymax: 5 },
    { xmin: 0.5, ymin: 0.5, xmax: 199.5, ymax: 99.5 },
    { xmin: 198, ymin: 98, xmax: 200, ymax: 100 },
  ]) {
    const crop = getVerificationCrop(edgeBox, 200, 100);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 200 && crop.y + crop.height <= 100);
    assert.ok(crop.x <= edgeBox.xmin && crop.y <= edgeBox.ymin);
    assert.ok(crop.x + crop.width >= edgeBox.xmax && crop.y + crop.height >= edgeBox.ymax);
    assert.ok([crop.x, crop.y, crop.width, crop.height].every(Number.isInteger));
  }
});

test("builds bounded crop sheets with stable labels outside the source imagery", () => {
  const imageData = { width: 200, height: 100 };
  for (const count of [1, 2, 3, 4]) {
    const calls = [];
    const canvases = [];
    context.document.createElement = () => {
      const canvas = {
        getContext: () => ({
          putImageData: (...args) => calls.push(["source", ...args]),
          fillRect: (...args) => calls.push(["background", ...args]),
          drawImage: (...args) => calls.push(["crop", ...args]),
          strokeRect: (...args) => calls.push(["outline", ...args]),
          fillText: (...args) => calls.push(["label", ...args]),
        }),
        toDataURL: (format) => {
          assert.equal(format, "image/png");
          return "data:image/png;base64,crop-sheet";
        },
      };
      canvases.push(canvas);
      return canvas;
    };
    try {
      const boxes = Array.from({ length: count }, (_, index) => ({ ...box, id: index * 2 + 1 }));
      const sheet = createVerificationSheet(imageData, boxes);
      assert.equal(sheet.dataUrl, "data:image/png;base64,crop-sheet");
      assert.equal(sheet.width, count === 1 ? 320 : 640);
      assert.equal(sheet.height, count <= 2 ? 352 : 704);
      assert.deepEqual(calls[0], ["source", imageData, 0, 0]);
      assert.equal(canvases[0].width, imageData.width);
      assert.equal(canvases[0].height, imageData.height);
      for (const [index, panel] of sheet.panels.entries()) {
        assert.equal(panel.id, boxes[index].id);
        assert.deepEqual(calls.filter((call) => call[0] === "crop")[index], [
          "crop", canvases[0], panel.crop.x, panel.crop.y, panel.crop.width, panel.crop.height,
          panel.image.x, panel.image.y, panel.image.width, panel.image.height,
        ]);
        const label = calls.filter((call) => call[0] === "label")[index];
        assert.equal(label[1], `#${panel.id}`);
        assert.ok(label[3] + 18 < panel.image.y);
        assert.ok(panel.image.x >= 0 && panel.image.y >= 0);
        assert.ok(panel.image.x + panel.image.width <= sheet.width && panel.image.y + panel.image.height <= sheet.height);
        const scale = panel.image.width / panel.crop.width;
        assert.ok(scale <= 4);
        assert.equal(scale, panel.image.height / panel.crop.height);
        assert.equal(panel.outline.xmin, panel.image.x + (box.xmin - panel.crop.x) * scale);
        assert.equal(panel.outline.ymin, panel.image.y + (box.ymin - panel.crop.y) * scale);
      }
    } finally {
      delete context.document.createElement;
    }
  }
});

test("rejects empty or oversized verification sheets", () => {
  assert.throws(() => createVerificationSheet({}, []), /one to four/);
  assert.throws(() => createVerificationSheet({}, Array(5).fill(box)), /one to four/);
});

test("redraws the untouched image when boxes are switched off or no boxes exist", () => {
  for (const [boxes, showBoxes] of [[[box], false], [[], true]]) {
    const calls = [];
    const canvas = {
      getContext: () => ({
        putImageData: (...args) => calls.push(args),
        strokeRect: () => assert.fail("No boxes should be drawn"),
      }),
    };
    const imageData = { width: 200, height: 100 };
    drawCaptureOverlay(canvas, imageData, boxes, showBoxes, true);
    assert.deepEqual(calls, [[imageData, 0, 0]]);
  }
});