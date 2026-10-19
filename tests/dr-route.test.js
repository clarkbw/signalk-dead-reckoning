/**
 * Tests for the active-route layer's pure helpers: resource-href
 * parsing (Freeboard-SK's discovery pattern — the trailing segment of
 * `navigation.course.activeRoute.href`), the course→active-route
 * state reducer, the route-resource → map render-spec shaping
 * (GeoJSON [lon, lat] → Leaflet [lat, lon], name fallbacks, target
 * waypoint index), and waypoint labeling from coordinatesMeta.
 * Loads the browser ESM module directly, like dr-ais.test.js.
 * @file dr-route.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const ROUTE_RESOURCE = {
  name: "Summer cruise",
  feature: {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [24.9, 60.1],
        [24.8, 60.2],
        [24.7, 60.3],
      ],
    },
    properties: {
      coordinatesMeta: [{ name: "Helsinki" }, { name: "Porkkala" }, {}],
    },
  },
};

test("resourceIdFromHref extracts the trailing segment", async () => {
  const vm = await loadVm();
  assert.equal(
    vm.resourceIdFromHref(
      "/resources/routes/9d4e6a1c-1111-2222-3333-444455556666",
    ),
    "9d4e6a1c-1111-2222-3333-444455556666",
  );
  assert.equal(vm.resourceIdFromHref("resources/routes/abc"), "abc");
  assert.equal(vm.resourceIdFromHref("/resources/waypoints/w1"), "w1");
});

test("resourceIdFromHref rejects non-hrefs", async () => {
  const vm = await loadVm();
  assert.equal(vm.resourceIdFromHref(null), null);
  assert.equal(vm.resourceIdFromHref(undefined), null);
  assert.equal(vm.resourceIdFromHref(""), null);
  assert.equal(vm.resourceIdFromHref(42), null);
});

test("activeRouteFromCourse parses href and pointIndex", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: "/resources/routes/rte-1",
      pointIndex: 2,
      reverse: false,
    },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: 2 });
});

test("activeRouteFromCourse tolerates a null pointIndex", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: { href: "/resources/routes/rte-1", pointIndex: null },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: -1 });
});

test("activeRouteFromCourse unwraps REST {value} nodes", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: { value: "/resources/routes/rte-1", $source: "course.provider" },
      pointIndex: { value: 1 },
    },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: 1 });
});

test("activeRouteFromCourse parses the wire delta object (whole activeRoute as one value)", async () => {
  const vm = await loadVm();
  // Verbatim shape observed on the stream: the course provider emits
  // the whole activeRoute object as one delta value at
  // `navigation.course.activeRoute`.
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: "/resources/routes/7e59b216-d65f-4fca-a215-04e31de2ea1c",
      name: "Orca route",
      reverse: false,
      pointIndex: 0,
      pointTotal: 14,
    },
  });
  assert.deepEqual(active, {
    id: "7e59b216-d65f-4fca-a215-04e31de2ea1c",
    pointIndex: 0,
  });
  // A whole-node REST wrap also parses.
  const wrapped = vm.activeRouteFromCourse({
    activeRoute: {
      value: { href: "/resources/routes/rte-1", pointIndex: 2 },
      $source: "course.provider",
    },
  });
  assert.deepEqual(wrapped, { id: "rte-1", pointIndex: 2 });
});

test("activeRouteFromCourse returns null without a route", async () => {
  const vm = await loadVm();
  assert.equal(vm.activeRouteFromCourse(null), null);
  assert.equal(vm.activeRouteFromCourse({}), null);
  assert.equal(
    vm.activeRouteFromCourse({
      nextPoint: { position: { latitude: 60, longitude: 25 } },
    }),
    null,
  );
  // A single-waypoint destination is not a route.
  assert.equal(
    vm.activeRouteFromCourse({
      nextPoint: { href: "/resources/waypoints/w1" },
    }),
    null,
  );
});

test("routeRenderSpec swaps GeoJSON order to Leaflet [lat, lon]", async () => {
  const vm = await loadVm();
  const spec = vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", 1);
  assert.deepEqual(spec.points, [
    [60.1, 24.9],
    [60.2, 24.8],
    [60.3, 24.7],
  ]);
  assert.equal(spec.name, "Summer cruise");
  assert.equal(spec.targetIndex, 1);
});

test("routeRenderSpec falls back to properties.name then short-id label", async () => {
  const vm = await loadVm();
  const noName = {
    feature: {
      geometry: {
        coordinates: [
          [25, 60],
          [25.1, 60.1],
        ],
      },
      properties: { name: "From properties" },
    },
  };
  assert.equal(vm.routeRenderSpec(noName, "rte-2").name, "From properties");
  const bare = {
    feature: {
      geometry: {
        coordinates: [
          [25, 60],
          [25.1, 60.1],
        ],
      },
    },
  };
  assert.equal(vm.routeRenderSpec(bare, "9d4e6a1c").name, "Route 4e6a1c");
});

test("routeRenderSpec clamps an out-of-range target index", async () => {
  const vm = await loadVm();
  assert.equal(vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", 99).targetIndex, -1);
  assert.equal(vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", -5).targetIndex, -1);
  assert.equal(
    vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", null).targetIndex,
    -1,
  );
});

test("routeRenderSpec returns null without usable geometry", async () => {
  const vm = await loadVm();
  assert.equal(vm.routeRenderSpec(null, "rte-1"), null);
  assert.equal(vm.routeRenderSpec({}, "rte-1"), null);
  assert.equal(
    vm.routeRenderSpec({ feature: { geometry: { coordinates: [] } } }, "rte-1"),
    null,
  );
  // A single point is a line that isn't there yet.
  assert.equal(
    vm.routeRenderSpec(
      { feature: { geometry: { coordinates: [[25, 60]] } } },
      "rte-1",
    ),
    null,
  );
});

test("routeWaypointLabels uses coordinatesMeta names, 1-based WP fallback", async () => {
  const vm = await loadVm();
  assert.deepEqual(vm.routeWaypointLabels(ROUTE_RESOURCE, 3), [
    "Helsinki",
    "Porkkala",
    "WP 3",
  ]);
  assert.deepEqual(vm.routeWaypointLabels(null, 2), ["WP 1", "WP 2"]);
  assert.deepEqual(vm.routeWaypointLabels({}, 1), ["WP 1"]);
});

test("unwrapLineLongitudes leaves an in-frame line untouched", async () => {
  const vm = await loadVm();
  const line = [
    [60.1, 24.9],
    [60.2, 24.8],
    [60.3, 24.7],
  ];
  assert.deepEqual(vm.unwrapLineLongitudes(line), line);
});

test("unwrapLineLongitudes carries an antimeridian leg the short way", async () => {
  const vm = await loadVm();
  // Fiji → Samoa eastward across the seam: -179.9 must come out as
  // 180.1 so the leg hops the dateline instead of wrapping the planet.
  const crossing = [
    [-17.8, 179.9],
    [-17.7, -179.9],
  ];
  assert.deepEqual(vm.unwrapLineLongitudes(crossing), [
    [-17.8, 179.9],
    [-17.7, 180.1],
  ]);
  // …and westward the mirror image: 179.9 comes out as -180.1.
  assert.deepEqual(vm.unwrapLineLongitudes([...crossing].reverse()), [
    [-17.7, -179.9],
    [-17.8, -180.1],
  ]);
});

test("unwrapLineLongitudes keeps a multi-leg route continuous", async () => {
  const vm = await loadVm();
  // Steps of 1° east from 179°: the whole tail beyond the seam stays
  // on one continuous strip (…, 180, 181, 182, 183), every leg 1°
  // wide, no wrap-around jumps.
  const pts = [
    [0, 179],
    [0, -180],
    [0, -179],
    [0, -178],
    [0, -177],
  ];
  const unwrapped = vm.unwrapLineLongitudes(pts);
  for (let i = 1; i < unwrapped.length; i++) {
    const d = unwrapped[i][1] - unwrapped[i - 1][1];
    assert.ok(Math.abs(d - 1) < 1e-9, `leg ${i} spans ${d}°, expected 1°`);
  }
  assert.equal(unwrapped[unwrapped.length - 1][1], 183);
});

test("worldCopies adds only the neighbours a seam-crossing line needs", async () => {
  const vm = await loadVm();
  // In-frame line: a single copy, the line itself.
  const plain = [
    [60, 24],
    [61, 25],
  ];
  assert.deepEqual(vm.worldCopies(plain), [plain]);
  // Eastward across +180: the -360° sibling covers the west-side view.
  const overEast = [
    [-17.8, 179.9],
    [-17.7, 180.1],
  ];
  assert.deepEqual(vm.worldCopies(overEast), [
    overEast,
    [
      [-17.8, -180.1],
      [-17.7, -179.9],
    ],
  ]);
  // Westward across -180: the +360° sibling covers the east-side view.
  const overWest = [
    [-17.7, -179.9],
    [-17.8, -180.1],
  ];
  assert.deepEqual(vm.worldCopies(overWest), [
    overWest,
    [
      [-17.7, 180.1],
      [-17.8, 179.9],
    ],
  ]);
});

test("dr-map-view draws the route and tracks through the seam helpers", () => {
  // Source smoketest (no DOM in the test env): the Leaflet adapter
  // must run every seam-spanning line — active route, ghost track,
  // GPS track — through unwrapLineLongitudes + worldCopies, or an
  // antimeridian leg renders as a line around the planet again.
  const mapSrc = readFileSync(join(__dirname, "../public/dr-map-view.js"), {
    encoding: "utf8",
  });
  for (const name of [
    "renderRoute(spec) {",
    "renderGhostTrack(pts, movement = null) {",
    "replacePolyline(key, pts, opts) {",
  ]) {
    const at = mapSrc.indexOf(name);
    assert.ok(at > -1, `${name} exists`);
    const body = mapSrc.slice(at, at + 2000);
    assert.match(
      body,
      /vm\.worldCopies\(vm\.unwrapLineLongitudes\(/,
      `${name} must unwrap longitudes and draw world copies`,
    );
  }
});
