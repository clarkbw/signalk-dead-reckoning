/**
 * Smoketests for the "follow DR" recenter control relocation: the
 * "Ghost Track" heading above the map was dropped to let the map open
 * higher, and the recenter button moved off that heading into the map
 * view itself — floated over the map's bottom-left corner. The map
 * owns the control now (recenter() is its own method), so dr-app no
 * longer wires it.
 *
 * @file dr-recenter.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
  { encoding: "utf8" },
);
const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);

test('dr-app: the "Ghost Track" heading is gone and the map is bare', () => {
  // The heading above the map wasted vertical space — removed so the
  // map opens higher. Since the plotter layout (work doc #26) the map
  // isn't card-wrapped at all: it fills the viewport edge-to-edge
  // with the controls floating over it.
  assert.doesNotMatch(appSrc, /Ghost Track/);
  assert.doesNotMatch(appSrc, /<h2>[^<]*Ghost Track/);
  assert.match(appSrc, /<dr-map-view id="dr-map"><\/dr-map-view>/);
  assert.doesNotMatch(
    appSrc,
    /<section class="sk-card">\s*<dr-map-view/,
    "map no longer card-wrapped",
  );
});

test("dr-app: no longer wires the recenter button — the map owns it", () => {
  assert.doesNotMatch(appSrc, /querySelector\("#dr-recenter"\)/);
  // recenter() is still reachable through the map element if needed.
  assert.doesNotMatch(appSrc, /\?\.recenter\(\)/);
});

test("dr-map-view: floats a recenter control toggling follow mode", () => {
  // The control is a floating overlay styled like the divergence chip
  // (bottom-left — the only free corner). It toggles follow mode:
  // engage re-centers on the DR position, disengage lets the map stay
  // put. Its bottom rides above the phone bottom bands via the
  // offset var.
  assert.match(mapSrc, /\.dr-recenter\s*\{/);
  assert.match(
    mapSrc,
    /bottom: calc\(8px \+ var\(--dr-map-bottom-offset, 0px\)\);/,
  );
  assert.match(mapSrc, /left: 8px;/);
  assert.match(
    mapSrc,
    /recenterBtn\.addEventListener\("click", \(\) => this\.toggleFollow\(\)\)/,
  );
  // Follow starts off by default — the helm keeps control of the
  // view; the map still opens centered on the vessel via the one-shot
  // fit in render().
  assert.match(mapSrc, /this\.follow = false;/);
  // Engaging follow flips Leaflet's gesture anchors to "center" so
  // pinch and double-click zoom keep the boat dead-center (the wheel
  // handler checks follow itself).
  assert.match(
    mapSrc,
    /setFollow\(on\) \{[\s\S]*?map\.options\.touchZoom = on \? "center" : true;/,
  );
  assert.match(
    mapSrc,
    /map\.options\.doubleClickZoom = on \? "center" : true;/,
  );
  // Keyboard pans never fire dragstart — while following, the keyboard
  // handler stands down entirely so the view can't drift off the DR
  // position.
  assert.match(
    mapSrc,
    /setFollow\(on\) \{[\s\S]*?if \(on\) map\.keyboard\?\.disable\(\);/,
  );
  assert.match(mapSrc, /else map\.keyboard\?\.enable\(\);/);
});

test("dr-map-view: the recenter button reflects the follow flag", () => {
  // Engaged = auto-follow ON. Toggled via setFollow() — the single
  // state mirror shared by the button, the drag pause and recenter()
  // — so a floating button with no heading still reads its state at
  // a glance.
  assert.match(mapSrc, /className = "dr-recenter"/);
  assert.match(
    mapSrc,
    /setFollow\(on\) \{[\s\S]*?classList\.toggle\("engaged", on\)/,
  );
  assert.match(
    mapSrc,
    /dragstart[\s\S]*?this\.setFollow\(false\)/,
    "dragging lets go of follow",
  );
  // aria-pressed mirrors the visual state for assistive tech.
  assert.match(mapSrc, /setAttribute\("aria-pressed", String\(on\)\)/);
  assert.match(mapSrc, /setAttribute\("aria-pressed", "false"\)/);
});
