/**
 * Tests for the plotter-extension host's window phase (work doc #27):
 * the pure geometry/policy in dr-ext-host-core.js (length parsing,
 * geometry resolution and clamping, presentation breakpoint, the
 * remembered-geometry store) and the host-side window API (with
 * stubbed chrome — no DOM — following the overlays test pattern).
 *
 * @file dr-ext-host-windows.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PlotterExtHost } from "../public/dr-ext-host.js";
import * as core from "../public/dr-ext-host-core.js";

const read = (f) =>
  readFileSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)), {
    encoding: "utf8",
  });
const hostSrc = read("dr-ext-host.js");

// ---- fakes --------------------------------------------------------------

function fakeStorage() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  return {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => backing.set(k, v),
    backing,
  };
}

function fakeStream() {
  return {
    stream: {
      selfContext: "vessels.urn:self",
      on() {},
      subscribeShared() {},
      unsubscribeShared() {},
    },
  };
}

/** A sounder-shaped manifest: one panel a window can show. */
function windowManifest(overrides = {}) {
  return {
    name: "Sounder",
    description: "",
    version: "1.0.0",
    apiVersion: "1",
    requires: ["panels.iframe", "windows"],
    panels: [
      {
        id: "sounder",
        title: "Echo sounder",
        type: "iframe",
        url: "/plotterext/sounder/panel.html",
      },
    ],
    ...overrides,
  };
}

/**
 * A host whose window chrome is stubbed (no DOM): `makeWindowEl`
 * leaves the record DOM-less (the chrome methods guard on el) and
 * `connectCtx` attaches a recording fake connection.
 *
 * @param {object} [opts]
 * @returns {{host: PlotterExtHost, storage: object}}
 */
function makeWindowHost(opts = {}) {
  const storage = opts.storage ?? fakeStorage();
  const { stream } = fakeStream();
  class StubHost extends PlotterExtHost {
    makeWindowEl(record) {
      record.el = null; // chrome-dependent methods guard on this
    }

    connectCtx(ctx) {
      const published = [];
      ctx.conn = {
        published,
        publish(name, params) {
          published.push({ name, params });
        },
        close() {},
      };
    }
  }
  const host = new StubHost({
    stream,
    mount: null,
    storage,
    fetchImpl: null,
    origin: "http://sk.test",
    getArea: opts.getArea ?? (() => ({ width: 1200, height: 800 })),
    ...opts,
  });
  return { host, storage };
}

function fakeCtx(overrides = {}) {
  return {
    kind: "widget",
    extId: "ext",
    id: "w",
    instanceId: "inst-1",
    targetInstance: null,
    targetWidget: null,
    windowId: null,
    params: null,
    ...overrides,
  };
}

/** Registers the sounder manifest and returns its panel. */
function enableExt(host, extId = "ext") {
  host.compatible.set(extId, {
    manifest: windowManifest(),
    widgets: [],
    panels: windowManifest().panels,
    overlays: [],
    background: [],
    buttons: [],
  });
  return host.compatible.get(extId).panels[0];
}

/** Events a context's fake connection recorded, by name. */
const eventsOf = (ctx, name) =>
  ctx.conn.published.filter((e) => e.name === name).map((e) => e.params);

// ---- core: geometry -------------------------------------------------------

test("parseWindowLength: px numbers and percentage strings only", () => {
  assert.deepEqual(core.parseWindowLength(480), { v: 480, unit: "px" });
  assert.deepEqual(core.parseWindowLength("40%"), { v: 40, unit: "pct" });
  assert.deepEqual(core.parseWindowLength(-16), { v: -16, unit: "px" });
  assert.equal(core.parseWindowLength("abc"), null);
  assert.equal(core.parseWindowLength("40"), null);
  assert.equal(core.parseWindowLength(Number.NaN), null);
  assert.equal(core.parseWindowLength(true), null);
});

test("parseWindowGeometry: defaults fill in, malformed is null", () => {
  const g = core.parseWindowGeometry({ anchor: "bottom-left", width: 480 });
  assert.equal(g.anchor, "bottom-left");
  assert.deepEqual(g.offsetX, { v: 0, unit: "px" });
  assert.deepEqual(g.offsetY, { v: 0, unit: "px" });
  assert.deepEqual(g.width, { v: 480, unit: "px" });
  assert.equal(g.height, null);
  assert.equal(g.maxWidth, null);
  // Absent anchor defaults to top-right (corner-inward, like widgets).
  assert.equal(core.parseWindowGeometry({ width: "40%" }).anchor, "top-right");
  // Malformed: not an object, unknown anchor, junk sizes, no sizes.
  assert.equal(core.parseWindowGeometry(null), null);
  assert.equal(core.parseWindowGeometry("40%"), null);
  assert.equal(core.parseWindowGeometry({ anchor: "left", width: 480 }), null);
  assert.equal(core.parseWindowGeometry({ width: "wide" }), null);
  assert.equal(core.parseWindowGeometry({ offset: "16" }), null);
  assert.equal(core.parseWindowGeometry({ offset: { x: "z" } }), null);
  assert.equal(core.parseWindowGeometry({ anchor: "center" }), null);
});

test("resolveWindowGeometry: sizes, limits, anchoring and clamping", () => {
  const area = { width: 1200, height: 800 };
  // Percentages resolve against the area; anchors position inward.
  const tl = core.resolveWindowGeometry(
    core.parseWindowGeometry({
      anchor: "top-left",
      width: "40%",
      height: "50%",
    }),
    area,
  );
  assert.deepEqual(tl, { x: 0, y: 0, width: 480, height: 400 });

  const br = core.resolveWindowGeometry(
    core.parseWindowGeometry({
      anchor: "bottom-right",
      offset: { x: 16, y: 16 },
      width: 480,
      height: 240,
    }),
    area,
  );
  assert.deepEqual(br, { x: 704, y: 544, width: 480, height: 240 });

  // Centered axes: a positive offset moves right / down.
  const c = core.resolveWindowGeometry(
    core.parseWindowGeometry({
      anchor: "center",
      offset: { x: 100, y: -50 },
      width: 200,
      height: 200,
    }),
    area,
  );
  assert.deepEqual(c, { x: 600, y: 250, width: 200, height: 200 });

  // min/max limits apply after the size; a ceiling caps the floor in
  // a contradictory request; the area always wins over everything.
  const clamped = core.resolveWindowGeometry(
    core.parseWindowGeometry({
      anchor: "top-left",
      width: 50,
      height: 50,
      minWidth: 240,
      maxHeight: 100,
    }),
    area,
  );
  assert.deepEqual(clamped, { x: 0, y: 0, width: 240, height: 100 });

  const tiny = core.resolveWindowGeometry(
    core.parseWindowGeometry({ anchor: "top-left", width: 4000, height: 4000 }),
    { width: 300, height: 200 },
  );
  assert.deepEqual(tiny, { x: 0, y: 0, width: 300, height: 200 });
});

test("clampWindowBounds: a resized area re-clamps size and position", () => {
  const clamped = core.clampWindowBounds(
    { x: 1100, y: 700, width: 480, height: 240 },
    { width: 1000, height: 600 },
  );
  assert.deepEqual(clamped, { x: 520, y: 360, width: 480, height: 240 });
  const grown = core.clampWindowBounds(
    { x: -20, y: 0, width: 100, height: 100 },
    { width: 1200, height: 800 },
  );
  assert.deepEqual(grown, { x: 0, y: 0, width: 160, height: 120 });
});

test("presentationFor: the phone breakpoint goes fullscreen", () => {
  assert.equal(core.presentationFor(600), "fullscreen");
  assert.equal(core.presentationFor(480), "fullscreen");
  assert.equal(core.presentationFor(601), "floating");
  assert.equal(core.presentationFor(1920), "floating");
});

test("geometryFromBounds: settled bounds become the anchored request", () => {
  const area = { width: 1200, height: 800 };
  for (const anchor of ["top-left", "top-right", "bottom-center", "center"]) {
    const g = core.geometryFromBounds(
      { x: 100, y: 50, width: 480, height: 240 },
      area,
      anchor,
    );
    assert.equal(g.anchor, anchor);
    // The stored request re-resolves to the same bounds.
    const resolved = core.resolveWindowGeometry(
      core.parseWindowGeometry(g),
      area,
    );
    assert.deepEqual(resolved, { x: 100, y: 50, width: 480, height: 240 });
  }
});

test("WindowGeometryStore: remembers per extension + key, drops per extension", () => {
  const storage = fakeStorage();
  const store = new core.WindowGeometryStore(storage);
  assert.equal(store.get("ext", "sounder"), null);
  store.set("ext", "sounder", { anchor: "top-left", width: 300 });
  assert.deepEqual(store.get("ext", "sounder"), {
    anchor: "top-left",
    width: 300,
  });
  // Persisted under the documented key, reloadable from storage.
  const reloaded = new core.WindowGeometryStore(storage);
  assert.deepEqual(reloaded.get("ext", "sounder").anchor, "top-left");
  store.set("other", "x", { anchor: "center", width: 100 });
  store.dropExtension("ext");
  assert.equal(store.get("ext", "sounder"), null);
  assert.ok(store.get("other", "x"));
});

// ---- core: capability gating ----------------------------------------------

test("windows joins the advertised capabilities", () => {
  assert.ok(core.HOST_CAPABILITIES.includes("windows"));
  const compat = core.compatibleExtensions(
    { sounder: windowManifest() },
    core.HOST_CAPABILITIES,
  );
  assert.deepEqual([...compat.keys()], ["sounder"]);
  // Without `windows` a manifest requiring it is not offered at all.
  const caps = core.HOST_CAPABILITIES.filter((c) => c !== "windows");
  assert.equal(
    core.compatibleExtensions({ sounder: windowManifest() }, caps).size,
    0,
  );
});

// ---- host: openWindow -------------------------------------------------------

test("openWindow: state shape, defaults, and the window context", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", {
    panel: "sounder",
    title: "My sounder",
    params: { app: "/signalk-wifish/" },
  });
  assert.match(state.windowId, /^w-\d+$/);
  assert.equal(state.panel, "sounder");
  assert.equal(state.title, "My sounder");
  assert.equal(state.presentation, "floating");
  // Default geometry: top-right, 16 px inset, 40% of the area.
  assert.deepEqual(state.bounds, { x: 704, y: 16, width: 480, height: 320 });
  assert.deepEqual(state.area, { width: 1200, height: 800 });
  assert.equal(state.visible, true);
  assert.equal(state.collapsed, false);
  assert.equal(state.poppedOut, false);
  assert.equal(state.modal, false);

  const ctx = host.windowCtxs.get(state.windowId);
  assert.equal(ctx.kind, "window");
  assert.equal(ctx.id, "sounder");
  assert.equal(ctx.windowId, state.windowId);
  assert.deepEqual(ctx.params, { app: "/signalk-wifish/" });
  assert.equal(ctx.instanceId, null);
});

test("openWindow: UNKNOWN_PANEL and windows.badRequest", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  assert.throws(
    () => host.openWindowFor("ext", { panel: "nope" }),
    (err) => err.reason === "UNKNOWN_PANEL",
  );
  assert.throws(
    () =>
      host.openWindowFor("ext", {
        panel: "sounder",
        geometry: { anchor: "left" },
      }),
    (err) => err.reason === "windows.badRequest",
  );
  assert.throws(
    () =>
      host.openWindowFor("ext", {
        panel: "sounder",
        geometry: { width: "wide" },
      }),
    (err) => err.reason === "windows.badRequest",
  );
});

test("openWindow: the host's window limit", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  for (let i = 0; i < core.WINDOW_LIMIT; i++) {
    host.openWindowFor("ext", { panel: "sounder" });
  }
  assert.throws(
    () => host.openWindowFor("ext", { panel: "sounder" }),
    (err) => err.reason === "windows.limit",
  );
});

test("openWindow: modal rules — one at a time, no hiding", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  host.openWindowFor("ext", { panel: "sounder", modal: true });
  assert.throws(
    () => host.openWindowFor("ext", { panel: "sounder", modal: true }),
    (err) => err.reason === "windows.modalOpen",
  );
  assert.throws(
    () =>
      host.openWindowFor("ext", {
        panel: "sounder",
        modal: true,
        visible: false,
      }),
    (err) => err.reason === "windows.badRequest",
  );
  assert.throws(
    () =>
      host.openWindowFor("ext", {
        panel: "sounder",
        modal: true,
        userClose: "hide",
      }),
    (err) => err.reason === "windows.badRequest",
  );
});

test("openWindow: single adopts the open window (shown and raised)", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const first = host.openWindowFor("ext", {
    panel: "sounder",
    params: { a: 1 },
  });
  const second = host.openWindowFor("ext", {
    panel: "sounder",
    single: true,
    params: { a: 2 },
    geometry: { anchor: "top-left", width: 99, height: 99 },
  });
  assert.equal(second.windowId, first.windowId);
  assert.equal(second.visible, true);
  // The adopted window keeps its own params; the call's are ignored.
  assert.deepEqual(host.windowCtxs.get(first.windowId).params, { a: 1 });

  // A hidden window comes back shown.
  host.updateWindow(fakeCtx(), {
    windowId: first.windowId,
    visible: false,
  });
  const third = host.openWindowFor("ext", { panel: "sounder", single: true });
  assert.equal(third.windowId, first.windowId);
  assert.equal(third.visible, true);
});

test("openWindow: remembered geometry wins over the request", () => {
  const { host, storage } = makeWindowHost();
  enableExt(host);
  const first = host.openWindowFor("ext", {
    panel: "sounder",
    restoreKey: "sounder",
  });
  assert.deepEqual(first.bounds, { x: 704, y: 16, width: 480, height: 320 });
  // The user settles it elsewhere (as the drag would).
  host.updateWindow(fakeCtx(), {
    windowId: first.windowId,
    geometry: {
      anchor: "top-left",
      offset: { x: 20, y: 30 },
      width: 200,
      height: 150,
    },
  });
  const stored = JSON.parse(storage.backing.get("dr.plotterext.windows.v1"));
  assert.equal(stored.ext.sounder.anchor, "top-left");
  host.teardownWindow(first.windowId, "user");
  const second = host.openWindowFor("ext", {
    panel: "sounder",
    restoreKey: "sounder",
    // This request is ignored — the remembered geometry wins.
    geometry: { anchor: "bottom-right", width: 600, height: 400 },
  });
  assert.deepEqual(second.bounds, { x: 20, y: 30, width: 200, height: 150 });
});

// ---- host: updateWindow / closeWindow / listWindows ------------------------

test("updateWindow: geometry fields merge, title and visibility publish state", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", { panel: "sounder" });
  const ctx = host.windowCtxs.get(state.windowId);

  const patched = host.updateWindow(fakeCtx(), {
    windowId: state.windowId,
    geometry: { height: 100 },
  });
  // Only height changed: the rest of the geometry stands. A request
  // below the host's minimum usable size renders at the floor — the
  // bounds report the truth.
  assert.equal(patched.bounds.height, 120);
  assert.equal(patched.bounds.width, 480);
  // A geometry change is a bounds change.
  assert.equal(eventsOf(ctx, "window.bounds").length, 1);
  assert.equal(eventsOf(ctx, "window.state").length, 0);

  host.updateWindow(fakeCtx(), { windowId: state.windowId, title: "Renamed" });
  const states = eventsOf(ctx, "window.state");
  assert.equal(states.length, 1);
  assert.equal(states[0].title, "Renamed");

  host.updateWindow(fakeCtx(), { windowId: state.windowId, visible: false });
  assert.equal(eventsOf(ctx, "window.state").at(-1).visible, false);
  // Hidden windows are listed.
  const list = host.listWindows(fakeCtx());
  assert.equal(list.windows.length, 1);
  assert.equal(list.windows[0].visible, false);

  // Malformed patches are rejected without tearing anything down.
  assert.throws(
    () =>
      host.updateWindow(fakeCtx(), {
        windowId: state.windowId,
        geometry: "nope",
      }),
    (err) => err.reason === "windows.badRequest",
  );
  assert.throws(
    () => host.updateWindow(fakeCtx(), { windowId: state.windowId, title: 42 }),
    (err) => err.reason === "windows.badRequest",
  );
});

test("updateWindow: a modal window cannot hide", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", { panel: "sounder", modal: true });
  assert.throws(
    () =>
      host.updateWindow(fakeCtx(), {
        windowId: state.windowId,
        visible: false,
      }),
    (err) => err.reason === "windows.badRequest",
  );
});

test("window identity: self-form resolves, foreign and unknown are refused", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", { panel: "sounder" });
  const winCtx = host.windowCtxs.get(state.windowId);

  // A window context may omit the windowId — the window itself.
  host.closeWindow(winCtx, {});
  assert.equal(host.windowRecords.size, 0);

  // Other extensions' windows are invisible to the caller.
  const a = host.openWindowFor("ext", { panel: "sounder" });
  assert.throws(
    () =>
      host.closeWindow(fakeCtx({ extId: "other" }), { windowId: a.windowId }),
    (err) => err.reason === "windows.unknownId",
  );
  assert.throws(
    () => host.closeWindow(fakeCtx(), { windowId: "w-9999" }),
    (err) => err.reason === "windows.unknownId",
  );
  // A non-window context without a windowId has no self to mean.
  assert.throws(
    () => host.closeWindow(fakeCtx(), {}),
    (err) => err.reason === "windows.badRequest",
  );
});

test("closeWindow: window.closed reaches the owning extension's contexts", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", { panel: "sounder" });
  const ownCtx = host.windowCtxs.get(state.windowId);
  // Capture the window's own connection: teardown nulls ctx.conn.
  const ownConn = ownCtx.conn;
  // A second context of the same extension, and a bystander's.
  const peer = fakeCtx({
    conn: {
      published: [],
      publish(name, params) {
        this.published.push({ name, params });
      },
      close() {},
    },
  });
  host.allCtxs.add(peer);
  const stranger = fakeCtx({
    extId: "other",
    conn: {
      published: [],
      publish(name, params) {
        this.published.push({ name, params });
      },
      close() {},
    },
  });
  host.allCtxs.add(stranger);

  host.closeWindow(fakeCtx(), { windowId: state.windowId });
  const closed = eventsOf(peer, "window.closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].windowId, state.windowId);
  assert.equal(closed[0].reason, "extension");
  assert.equal(eventsOf(stranger, "window.closed").length, 0);
  // The window's own context received it too — then went away.
  assert.equal(
    ownConn.published.filter((e) => e.name === "window.closed").length,
    1,
  );
  assert.equal(host.windowCtxs.size, 0);
  assert.equal(host.allCtxs.has(ownCtx), false);
});

test("closeWindow: userClose hide makes the close control hide instead", () => {
  const { host } = makeWindowHost();
  enableExt(host);
  const state = host.openWindowFor("ext", {
    panel: "sounder",
    userClose: "hide",
  });
  const ctx = host.windowCtxs.get(state.windowId);
  host.userCloseWindow(host.windowRecords.get(state.windowId));
  // Hidden, still running (the record and context live on).
  assert.equal(host.windowRecords.get(state.windowId).visible, false);
  assert.equal(eventsOf(ctx, "window.state").at(-1).visible, false);
  assert.equal(host.windowCtxs.size, 1);
});

// ---- host: reconciliation and the viewport ---------------------------------

test("refresh: a vanished extension loses its windows silently", async () => {
  const { host, storage } = makeWindowHost({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ext: windowManifest() }),
    }),
  });
  await host.refresh();
  const state = host.openWindowFor("ext", {
    panel: "sounder",
    restoreKey: "k",
  });
  const ctx = host.windowCtxs.get(state.windowId);
  const conn = ctx.conn; // teardown nulls ctx.conn — capture first

  // The plugin is disabled: the extension leaves the collection.
  host.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  await host.refresh();
  assert.equal(host.windowRecords.size, 0);
  assert.equal(host.windowCtxs.size, 0);
  assert.equal(
    conn.published.filter((e) => e.name === "window.closed").length,
    0,
  );
  // Remembered geometry goes with the extension.
  assert.equal(host.geometryStore.get("ext", "k"), null);
});

test("syncWindowsToArea: presentation flips at the breakpoint and back", () => {
  let area = { width: 1200, height: 800 };
  const { host } = makeWindowHost({ getArea: () => area });
  enableExt(host);
  const state = host.openWindowFor("ext", { panel: "sounder" });
  const ctx = host.windowCtxs.get(state.windowId);
  assert.equal(eventsOf(ctx, "window.state").length, 0);

  // Down to phone size: fullscreen, bounds = the area.
  area = { width: 480, height: 700 };
  host.syncWindowsToArea();
  let st = eventsOf(ctx, "window.state").at(-1);
  assert.equal(st.presentation, "fullscreen");
  assert.deepEqual(st.bounds, { x: 0, y: 0, width: 480, height: 700 });
  assert.deepEqual(host.windowRecords.get(state.windowId).bounds, st.bounds);

  // Back up: floating again, geometry re-resolved from the request.
  area = { width: 1200, height: 800 };
  host.syncWindowsToArea();
  st = eventsOf(ctx, "window.state").at(-1);
  assert.equal(st.presentation, "floating");
  assert.deepEqual(st.bounds, { x: 704, y: 16, width: 480, height: 320 });
  assert.equal(eventsOf(ctx, "window.bounds").length, 2);

  // A pure resize (still floating) only re-clamps — the window keeps
  // its size, pulled back inside the area.
  area = { width: 900, height: 600 };
  host.syncWindowsToArea();
  const rec = host.windowRecords.get(state.windowId);
  assert.deepEqual(rec.bounds, { x: 420, y: 16, width: 480, height: 320 });
});

// ---- host: toolbar buttons ---------------------------------------------------

test("button actions: openWindow tracks, toggleWindow hides and closes", () => {
  const { host } = makeWindowHost();
  const button = {
    id: "show-sounder",
    title: "Sounder",
    slot: "mapToolbar",
    action: {
      type: "toggleWindow",
      panel: "sounder",
      userClose: "hide",
      restoreKey: "sounder",
      geometry: { anchor: "bottom-right", width: 480, height: 240 },
    },
  };
  host.compatible.set("ext", {
    manifest: windowManifest({
      buttons: [button],
      panels: [
        {
          id: "sounder",
          title: "Echo sounder",
          type: "iframe",
          url: "/plotterext/sounder/panel.html",
          userClose: undefined,
        },
      ],
    }),
    widgets: [],
    panels: windowManifest().panels,
    overlays: [],
    background: [],
    buttons: [button],
  });

  host.runButtonAction("ext", button);
  assert.equal(host.windowRecords.size, 1);
  const [wid] = host.windowRecords.keys();
  assert.equal(host.buttonWindows.get("ext/show-sounder"), wid);

  // Press again while shown: the close control's behavior — hide.
  host.runButtonAction("ext", button);
  assert.equal(host.windowRecords.get(wid).visible, false);
  // Press while hidden: back it comes, as it was.
  host.runButtonAction("ext", button);
  assert.equal(host.windowRecords.get(wid).visible, true);

  // The extension closes the window itself: the button forgets, and
  // the next press opens a fresh window.
  host.closeWindow(fakeCtx(), { windowId: wid });
  assert.equal(host.buttonWindows.has("ext/show-sounder"), false);
  host.runButtonAction("ext", button);
  assert.equal(host.windowRecords.size, 1);
  assert.notEqual([...host.windowRecords.keys()][0], wid);

  // A close-mode toggleWindow closes instead of hiding.
  const closer = {
    id: "b2",
    slot: "mapToolbar",
    action: { type: "toggleWindow", panel: "sounder" },
  };
  host.runButtonAction("ext", closer);
  const wid2 = host.buttonWindows.get("ext/b2");
  host.runButtonAction("ext", closer);
  assert.equal(host.windowRecords.has(wid2), false);
  const ctx = host.windowCtxs.get(wid2);
  assert.equal(ctx, undefined); // its context went with it
});

test("button actions: a bad manifest entry is a console matter, not a crash", () => {
  const { host } = makeWindowHost();
  const button = {
    id: "b",
    slot: "mapToolbar",
    action: { type: "openWindow", panel: "missing" },
  };
  host.compatible.set("ext", {
    manifest: windowManifest({ buttons: [button] }),
    widgets: [],
    panels: windowManifest().panels,
    overlays: [],
    background: [],
    buttons: [button],
  });
  assert.doesNotThrow(() => host.runButtonAction("ext", button));
  assert.equal(host.windowRecords.size, 0);
});

// ---- host: panel lifecycle settlement ----------------------------------------

test("panels: whileEnabled is no longer a preload lifecycle", async () => {
  const manifest = windowManifest({
    requires: ["panels.iframe"],
    panels: [
      {
        id: "always",
        title: "Always",
        type: "iframe",
        url: "/plotterext/ext/always.html",
        lifecycle: "whileEnabled",
      },
    ],
  });
  const { host } = makeWindowHost({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ext: manifest }),
    }),
  });
  let created = 0;
  host.ensurePanelCtx = () => {
    created++;
    return null;
  };
  await host.refresh();
  // Upstream dropped whileEnabled for panels (absent/unknown = onOpen):
  // a panel is never loaded before it is first opened.
  assert.equal(created, 0);
});

// ---- structural pins ----------------------------------------------------------

test("the host wires the window surface structurally", () => {
  // The handshake carries the window's id and params.
  assert.match(hostSrc, /windowId: ctx\.windowId \?\? null/);
  assert.match(hostSrc, /params: ctx\.params \?\? null/);
  // The window methods are on the host's method table.
  for (const method of [
    "ui.openWindow",
    "ui.updateWindow",
    "ui.focusWindow",
    "ui.closeWindow",
    "ui.listWindows",
  ]) {
    assert.ok(hostSrc.includes(`"${method}"`), `method table lacks ${method}`);
  }
  // The window chrome mounts onto the prototype like the overlays.
  assert.match(
    hostSrc,
    /Object\.assign\(PlotterExtHost\.prototype, WINDOW_METHODS\)/,
  );
  // Windows of a vanished extension close in refresh().
  assert.match(hostSrc, /closeWindowsFor\(record\.extId\)/);
});
