/**
 * Tests for Signal K notes on the chart (work doc #30): collection
 * shaping (position-less entries skipped), resource building, safe
 * body rendering per mimeType, and the map/app wiring smoketests.
 * @file dr-notes.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);
const appSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
  { encoding: "utf8" },
);
const panelSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-note-panel.js", import.meta.url)),
  { encoding: "utf8" },
);

test("notesRenderSpecs: positioned notes shape, position-less skipped", async () => {
  const vm = await loadVm();
  const specs = vm.notesRenderSpecs({
    "urn:sk:note-1": {
      title: "Rocks",
      body: "Shoal patch",
      position: { latitude: 60.1, longitude: 24.2 },
    },
    "urn:sk:note-2": {
      title: "Region-only",
      body: "No point",
      region: "urn:sk:region-9",
    },
    "urn:sk:note-3": { title: "Half", position: { latitude: 60.3 } },
    notAnObject: null,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "urn:sk:note-1");
  assert.deepEqual(specs[0].position, [60.1, 24.2]);
  assert.equal(specs[0].title, "Rocks");
  assert.deepEqual(vm.notesRenderSpecs(null), []);
  // Untitled notes don't crash the chart label.
  const untitled = vm.notesRenderSpecs({
    x: { position: { latitude: 1, longitude: 2 } },
  });
  assert.equal(untitled[0].title, "Note");
});

test("notesRenderSpecs: notes paired with a drawn region stay hidden", async () => {
  const vm = await loadVm();
  const notes = {
    "n-area-1": {
      title: "Gale warning",
      href: "/resources/regions/n-area-1",
      position: { latitude: 60.1, longitude: 24.2 },
    },
    "n-plain": {
      title: "Rocks",
      position: { latitude: 60.2, longitude: 24.3 },
    },
    "n-other-area": {
      title: "Unrelated region pair",
      href: "/resources/regions/other-region",
      position: { latitude: 60.3, longitude: 24.4 },
    },
  };
  // With the region's shape on the chart, the href-paired note stays
  // hidden — the extent renders once.
  const specs = vm.notesRenderSpecs(notes, new Set(["n-area-1"]));
  assert.deepEqual(
    specs.map((s) => s.id),
    ["n-plain", "n-other-area"],
  );
  // Without shapes, every positioned note renders.
  assert.equal(vm.notesRenderSpecs(notes).length, 3);
  assert.equal(vm.notesRenderSpecs(notes, null).length, 3);
});

test("regionShapes: polygons, severity, bbox honesty cue, label fallback", async () => {
  const vm = await loadVm();
  const regions = {
    "metarea-1-area-1": {
      name: "METAREA I",
      description: "GALE WARNING. Winds forecast 30 to 45 kn.",
      feature: {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-10, 40],
              [10, 40],
              [10, 50],
              [-10, 50],
              [-10, 40],
            ],
          ],
        },
        properties: {
          sourcePlugin: "signalk-passage-briefing",
          geometryType: "polygon",
        },
      },
    },
    "cap-2-area-2": {
      description: "CAP area 2 dense fog observed.",
      feature: {
        type: "Feature",
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [20, 40],
                [22, 40],
                [22, 42],
                [20, 42],
                [20, 40],
              ],
            ],
          ],
        },
        properties: {
          sourcePlugin: "signalk-passage-briefing",
          geometryType: "bbox",
        },
      },
    },
    "not-a-shape": {
      description: "Point-only resource",
      feature: {
        type: "Feature",
        geometry: { type: "Point", coordinates: [25, 60] },
      },
    },
  };
  const shapes = vm.regionShapes(regions, 0);
  assert.equal(shapes.length, 2);
  const [metarea, cap] = shapes;
  assert.equal(metarea.id, "metarea-1-area-1");
  assert.equal(metarea.label, "METAREA I");
  assert.equal(metarea.severe, true, "GALE is severe");
  assert.equal(metarea.dashed, false, "polygon areas draw solid");
  assert.equal(metarea.rings.length, 1);
  assert.equal(metarea.rings[0].length, 5, "ring kept closed");
  assert.equal(
    cap.label,
    "CAP area 2 dense fog observed.",
    "name-less label falls back to the description's first line",
  );
  assert.equal(cap.severe, true, "DENSE FOG is severe");
  assert.equal(cap.dashed, true, "our bbox-approximate area draws dashed");
  assert.equal(cap.rings.length, 1, "multipolygon outer rings");
  // Non-severe text renders calm.
  const calm = vm.regionShapes({
    x: {
      description: "Slight seas expected.",
      feature: {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
        properties: {},
      },
    },
  });
  assert.equal(calm[0].severe, false);
  // Third-party regions draw the same (not dashed — the honesty cue
  // is the publishing plugin's own approximation marker).
  const thirdParty = vm.regionShapes({
    y: {
      description: "SQUALL warning.",
      feature: {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
        properties: { sourcePlugin: "someone-else" },
      },
    },
  });
  assert.equal(thirdParty[0].severe, true);
  assert.equal(thirdParty[0].dashed, false);
  assert.deepEqual(vm.regionShapes(null), []);
});

test("unwrapFrame: rings across the antimeridian stay one polygon", async () => {
  const vm = await loadVm();
  // A ring stepping over the dateline: 179 → -179 is one hop, not a
  // 358° smear, once unwrapped against the frame.
  const unwrapped = vm.unwrapFrame(
    [
      [178, 10],
      [179, 10],
      [-179, 10],
      [-178, 10],
    ],
    179,
  );
  assert.deepEqual(unwrapped, [
    [178, 10],
    [179, 10],
    [181, 10],
    [182, 10],
  ]);
  // Already-continuous frames pass through untouched.
  assert.deepEqual(
    vm.unwrapFrame(
      [
        [0, 0],
        [10, 0],
      ],
      null,
    ),
    [
      [0, 0],
      [10, 0],
    ],
  );
  assert.deepEqual(vm.unwrapFrame(null), []);
});

test("isSevereText: the shared severity highlighter", async () => {
  const vm = await loadVm();
  assert.equal(vm.isSevereText("GALE WARNING. Winds 30 to 45 kn."), true);
  assert.equal(vm.isSevereText("HURRICANE FORCE 10 expected."), true);
  assert.equal(vm.isSevereText("slight seas, good visibility"), false);
  assert.equal(vm.isSevereText(""), false);
  assert.equal(vm.isSevereText(null), false);
});

test("noteBodyText: body preferred, description fallback (provider notes)", async () => {
  const vm = await loadVm();
  assert.equal(
    vm.noteBodyText({ body: "v2 body", description: "desc" }),
    "v2 body",
  );
  // Metarea/passage-briefing shape: text in description, title
  // truncated by the source.
  assert.equal(
    vm.noteBodyText({
      title: "IN THE AREA SOUTH OF 10S AND WEST OF 165W,…",
      description:
        "IN THE AREA SOUTH OF 10S AND WEST OF 165W, EXPECT SOUTHEAST WINDS 20\nTO 30 KNOTS.",
    }),
    "IN THE AREA SOUTH OF 10S AND WEST OF 165W, EXPECT SOUTHEAST WINDS 20\nTO 30 KNOTS.",
  );
  assert.equal(vm.noteBodyText({ title: "only" }), "");
  assert.equal(vm.noteBodyText(null), "");
  // Non-string junk is ignored, not stringified.
  assert.equal(vm.noteBodyText({ body: 5, description: {} }), "");
});

test("noteResourceFromForm: trims title, defaults, position object", async () => {
  const vm = await loadVm();
  const r = vm.noteResourceFromForm({
    title: "  Hazard  ",
    body: "Rocks at low water",
    position: [60.1, 24.2],
  });
  assert.deepEqual(r, {
    title: "Hazard",
    body: "Rocks at low water",
    position: { latitude: 60.1, longitude: 24.2 },
  });
  const bare = vm.noteResourceFromForm({
    title: "",
    body: "",
    position: [1, 2],
  });
  assert.equal(bare.title, "Note", "empty title falls back");
  const md = vm.noteResourceFromForm({
    title: "T",
    body: "b",
    mimeType: "text/markdown",
    position: [1, 2],
  });
  assert.equal(md.mimeType, "text/markdown");
});

test("renderNoteBody: plain text renders pre-wrap, escaped", async () => {
  const vm = await loadVm();
  const html = vm.renderNoteBody("Line one\n<b>not html</b>  spaced", null);
  assert.match(html, /<p class="dr-note-plain">/);
  assert.match(html, /&lt;b&gt;not html&lt;\/b&gt;/, "input is escaped");
  assert.match(html, /Line one\n/);
});

test("renderNoteBody: markdown gets minimal structure, still escaped", async () => {
  const vm = await loadVm();
  const html = vm.renderNoteBody(
    "# Heading\nSome **bold** and *ital* and `code`.\n- item one\n- item two\n<script>alert(1)</script>",
    "text/markdown",
  );
  assert.match(html, /<strong>Heading<\/strong>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>ital<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>/, "list wrapped");
  assert.match(html, /<li>item one<\/li>/);
  assert.match(html, /&lt;script&gt;/, "script text never renders as HTML");
  assert.doesNotMatch(html, /<script>/);
  // Links render but are forced safe.
  const link = vm.renderNoteBody(
    "See [chart](https://example.com) thanks",
    "text/markdown",
  );
  assert.match(
    link,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener">chart<\/a>/,
  );
});

test("stampNoteProvenance: create stamps publication, edit preserves it", async () => {
  const vm = await loadVm();
  // Create: who published, when — inside the schema's properties.
  const created = vm.stampNoteProvenance(
    { title: "Hazard", body: "Rocks", position: { latitude: 1, longitude: 2 } },
    "bergie",
    "2026-10-03T09:30:00.000Z",
    false,
  );
  assert.deepEqual(created.properties, {
    publishedBy: "bergie",
    publishedAt: "2026-10-03T09:30:00.000Z",
  });
  // Sessions without a login publish as anonymous.
  const anonymous = vm.stampNoteProvenance(
    { title: "T", body: "", position: { latitude: 1, longitude: 2 } },
    null,
    "2026-10-03T09:30:00.000Z",
    false,
  );
  assert.equal(anonymous.properties.publishedBy, "anonymous");
  // Edit: the original publication is history, not metadata to
  // overwrite — preserved, and the latest edit recorded beside it.
  const edited = vm.stampNoteProvenance(
    {
      title: "Hazard",
      properties: {
        publishedBy: "bergie",
        publishedAt: "2026-10-03T09:30:00.000Z",
        category: "hazard",
      },
    },
    "crew2",
    "2026-10-04T08:00:00.000Z",
    true,
  );
  assert.deepEqual(edited.properties, {
    publishedBy: "bergie",
    publishedAt: "2026-10-03T09:30:00.000Z",
    category: "hazard",
    updatedBy: "crew2",
    updatedAt: "2026-10-04T08:00:00.000Z",
  });
});

test("noteProvenanceText: publication and edit lines, fallbacks", async () => {
  const vm = await loadVm();
  // Metarea note served by signalk-passage-briefing: issuer parsed
  // from the bulletin header rides in properties.
  assert.equal(
    vm.noteProvenanceText({
      properties: {
        publishedBy: "FIJI METEOROLOGICAL SERVICE",
        publishedAt: "2026-10-03T12:00:00.000Z",
      },
    }),
    "Published on 10-03 12:00Z by FIJI METEOROLOGICAL SERVICE",
  );
  // Notes this webapp published itself, later edited by someone else.
  assert.equal(
    vm.noteProvenanceText({
      properties: {
        publishedBy: "bergie",
        publishedAt: "2026-10-03T09:30:00.000Z",
        updatedBy: "crew2",
        updatedAt: "2026-10-04T08:15:00.000Z",
      },
    }),
    "Published on 10-03 09:30Z by bergie · edited on 10-04 08:15Z by crew2",
  );
  // Provider-shaped notes without provenance fall back to the bare
  // resource timestamp (when it parses).
  assert.equal(
    vm.noteProvenanceText({ timestamp: "2026-10-03T12:00:00.000Z" }),
    "Published on 10-03 12:00Z",
  );
  // Malformed or absent provenance: empty — no fake data.
  assert.equal(
    vm.noteProvenanceText({ properties: { publishedAt: "junk" } }),
    "",
  );
  assert.equal(vm.noteProvenanceText({}), "");
  assert.equal(vm.noteProvenanceText(null), "");
  // Non-string junk in properties is ignored, not stringified.
  assert.equal(
    vm.noteProvenanceText({ properties: { publishedBy: 5, publishedAt: {} } }),
    "",
  );
});

test("parseLayerPrefs: malformed storage data falls back per key", async () => {
  const vm = await loadVm();
  assert.deepEqual(vm.parseLayerPrefs(null), { base: null, overlays: {} });
  assert.deepEqual(vm.parseLayerPrefs(""), { base: null, overlays: {} });
  assert.deepEqual(vm.parseLayerPrefs("not json"), {
    base: null,
    overlays: {},
  });
  assert.deepEqual(vm.parseLayerPrefs("42"), { base: null, overlays: {} });
  // Wrong-typed entries dropped individually, valid ones kept.
  assert.deepEqual(
    vm.parseLayerPrefs(
      JSON.stringify({
        base: "__chart_mirror__",
        overlays: { notes: true, ais: "yes", rings: 1, vectors: false },
      }),
    ),
    { base: "__chart_mirror__", overlays: { notes: true, vectors: false } },
  );
  assert.deepEqual(vm.parseLayerPrefs(JSON.stringify({ base: 7 })), {
    base: null,
    overlays: {},
  });
});

test("layer prefs: remembered base + overlay toggles across sessions", () => {
  // Storage key follows the dr-* convention; reads and writes are
  // guarded (localStorage can throw in private modes).
  assert.match(mapSrc, /LAYERS_KEY\(\) \{[\s\S]*?return "dr-layers";/);
  assert.match(mapSrc, /_loadLayerPrefs\(\) \{/);
  assert.match(mapSrc, /_saveLayerPrefs\(prefs\) \{/);
  // Restore: parsed prefs select the base (only when still mounted)
  // and apply per-overlay toggles without disturbing un-flipped keys.
  assert.match(mapSrc, /vm\.parseLayerPrefs\(this\._loadLayerPrefs\(\)\)/);
  assert.match(
    mapSrc,
    /this\.tileLayers\[prefs\.base \?\? ""\] \?\? defaultBase/,
  );
  assert.match(mapSrc, /prefs\.overlays\[key\];/);
  assert.match(mapSrc, /if \(want === undefined\) continue;/);
  // Persist on the layers-control's own events — base picks and
  // overlay add/remove both land in storage.
  assert.match(mapSrc, /this\.map\.on\("baselayerchange"/);
  assert.match(mapSrc, /this\.map\.on\("overlayadd overlayremove"/);
  assert.match(mapSrc, /this\._saveLayerPrefs\(prefs\)/);
});

test("notesViewQuery: Freeboard wire format position=[lon,lat]&distance=m", async () => {
  const vm = await loadVm();
  // A Tonga-area view: position is the view center in [lon, lat]
  // (GeoJSON) order, distance a whole-meter covering radius from the
  // center to the view corner — the request Freeboard-SK sends.
  const view = { west: -175.4, south: -21.4, east: -174.9, north: -20.9 };
  const expectedM = Math.ceil(
    vm.distanceNm([-20.9, -175.4], [-21.15, -175.15]) * 1852,
  );
  assert.equal(
    vm.notesViewQuery(view),
    `position=[-175.15,-21.15]&distance=${expectedM}`,
  );
  // Low-zoom Leaflet views report out-of-range edges; center and
  // corner clamp so the query stays in the valid lat/lon range.
  const wideM = Math.ceil(vm.distanceNm([-90, -180], [0, 0]) * 1852);
  assert.equal(
    vm.notesViewQuery({ west: -260, south: -95, east: 260, north: 95 }),
    `position=[0,0]&distance=${wideM}`,
  );
});

test("notesRefetchNeeded: first fetch, margin containment, pan/zoom out", async () => {
  const vm = await loadVm();
  const view = { west: 24, south: 60, east: 25, north: 60.5 };
  assert.equal(vm.notesRefetchNeeded(view, null), true, "nothing fetched yet");
  // Inside the fetched area (or its 25% margin) — no refetch.
  assert.equal(vm.notesRefetchNeeded(view, view), false);
  assert.equal(
    vm.notesRefetchNeeded(
      { west: 24.2, south: 60.5 - 0.125 - 0.01, east: 24.8, north: 60.5 },
      view,
    ),
    false,
    "slight pan stays within the margin",
  );
  // Panning into unseen water, or zooming out past the fetched area.
  assert.equal(
    vm.notesRefetchNeeded({ ...view, east: 25.5 }, view),
    true,
    "pan past the margin",
  );
  assert.equal(
    vm.notesRefetchNeeded({ west: 10, south: 59, east: 40, north: 62 }, view),
    true,
    "zoomed-out view exceeds the fetched area",
  );
});

test("notes wiring: v2 resources API, layers-control toggle, pick menu integration", () => {
  // Layer wiring: notes has a layers-control entry, but mounts by
  // default (not in the start-detached toggleableLayers set) —
  // navigational warnings must not hide behind a toggle.
  assert.match(mapSrc, /notes: \["Notes", this\.layers\.notes\]/);
  assert.match(
    mapSrc,
    /toggleableLayers = new Set\(\["vectors", "rings", "laylines"\]\)/,
  );
  // Markers + detail surface.
  assert.match(mapSrc, /renderNotes\(specs, resourcesById\) \{/);
  assert.match(mapSrc, /_noteIcon\(\)/);
  // Full note text: the surface shapes body → description fallback.
  assert.match(mapSrc, /renderNoteBody\(vm\.noteBodyText\(note\)/);
  assert.match(mapSrc, /vm\.renderNoteBody\(/);
  assert.match(mapSrc, /"dr-note-new"/);
  assert.match(mapSrc, /"dr-note-edit"/);
  assert.match(mapSrc, /"dr-note-delete"/);
  // App REST wiring: v2 resources API, POST/PUT/DELETE, refetch on reconnect.
  assert.match(appSrc, /\/signalk\/v2\/api\/resources\/notes/);
  assert.match(appSrc, /method: id \? "PUT" : "POST"/);
  assert.match(appSrc, /method: "DELETE"/);
  assert.match(
    appSrc,
    /renderLinkStatus\(status\) \{[\s\S]*this\.fetchNotes\(\);/,
  );
  // Viewport-aware fetching: the map reports view changes, dr-app
  // re-fetches the visible area with Freeboard's position+distance
  // query and merges the result into the cache (providers answer the
  // bare collection query with a provider-shaped area — wider views
  // must fetch for themselves).
  assert.match(mapSrc, /dr-view-changed/);
  assert.match(mapSrc, /getBounds\(\)/);
  assert.match(appSrc, /addEventListener\("dr-view-changed"/);
  assert.match(appSrc, /notesViewQuery\(/);
  assert.match(appSrc, /notesRefetchNeeded\(/);
  assert.match(appSrc, /this\.notesById\.set\(id, note\)/);
  // Panel: quick hazard preset, error surfacing, save dispatch.
  assert.match(panelSrc, /dr-note-hazard/);
  assert.match(panelSrc, /showError\(message\)/);
  assert.match(panelSrc, /vm\.noteResourceFromForm\(/);
  assert.match(panelSrc, /No position/);
  // Edit form seeds from the shaped text (description fallback) and
  // dr-app's save merges the stored resource so provider metadata
  // (properties, url, description) survives the PUT.
  assert.match(panelSrc, /vm\.noteBodyText\(seed\.note\)/);
  assert.match(appSrc, /\{ \.\.\.stored, \.\.\.formResource \}/);
  // Provenance: saves stamp who published / when (session user via
  // loginStatus), and the note detail surface renders the line.
  assert.match(appSrc, /vm\.stampNoteProvenance\(/);
  assert.match(appSrc, /currentUserName\(\)/);
  assert.match(appSrc, /skServer\/loginStatus/);
  assert.match(mapSrc, /vm\.noteProvenanceText\(note\)/);
  // A note pick is an annotation, not an observation target: no
  // "Bearing to" / "Distance CPL" entries, no "Add observation at…"
  // headline — measure and hazard marking stay.
  assert.match(mapSrc, /const items = note\s*\?\s*\[/);
  assert.match(mapSrc, /if \(!note\) \{\s*menu\.textContent/);
});

test("regions wiring: fetched with the notes, drawn as warning shapes, pairing", () => {
  // Regions ride the same view-scoped fetch as the notes (passage-
  // briefing work doc #48): one query, one render path — the paired
  // note stays hidden when its region's shape draws.
  assert.match(appSrc, /resources\/regions/);
  assert.match(appSrc, /regionsById/);
  assert.match(appSrc, /vm\.regionShapes\(/);
  assert.match(appSrc, /renderRegions\(shapes, this\.regionsById\)/);
  assert.match(appSrc, /vm\.notesRenderSpecs\(notes, drawn\)/);
  // Map: a layers-control checkbox, mounted by default like the notes
  // (not in the start-detached set), severity colors, GeoJSON ring
  // order flipped to Leaflet lat/lng, sticky tooltips, click-through
  // to the paired note's detail surface.
  assert.match(mapSrc, /regions: \["Regions", this\.layers\.regions\]/);
  assert.match(mapSrc, /renderRegions\(specs, resourcesById\) \{/);
  assert.match(mapSrc, /severe \? "#ff5c5c" : "#ffb45c"/);
  assert.match(mapSrc, /dashArray: spec\.dashed \? "4 6" : undefined/);
  assert.match(mapSrc, /ring\.map\(\(\[lon, lat\]\) => \[lat, lon\]\)/);
  assert.match(mapSrc, /openRegionDetail\(spec, e\.latlng\)/);
  assert.match(mapSrc, /\/resources\/regions\/\$\{spec\.id\}/);
  // The pick menu shows the clicked coordinates (helm request), in
  // the watchkeeper's own position format.
  assert.match(mapSrc, /dr-pick-coords/);
  assert.match(mapSrc, /posfmt\.fmtPos\(picked\)/);
});
