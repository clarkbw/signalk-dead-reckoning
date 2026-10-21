/**
 * DR chartwork **background runtime** (work doc #38): the headless
 * plotter-extension context that keeps Freeboard-SK's chart in step
 * with the DR engine while the extension is enabled — no panel needs
 * to be open.
 *
 * Responsibilities:
 *
 * - **Data overlay** (`overlays.data`, optional capability): renders
 *   the chartwork — ghost track, uncertainty circle, LoPs, CPLs,
 *   fixes, snap vectors, candidate preview, DR position — as GeoJSON
 *   features of the "chartwork" overlay, from the plugin REST rows
 *   plus the live DR deltas. The style is
 *   `dr-ext-overlay-style.json`; geometry conventions come from
 *   `dr-ext-chartwork.js` (pure, Node-tested).
 * - **Override buttons** (`buttons.visibility`): the engage/release
 *   pair mirrors `engine.active` from GET /status; a press publishes
 *   `signalk-dead-reckoning.override` and lands here as a PUT.
 * - **Panel events** (`events.publish`): the sight panel announces
 *   observation changes and candidate previews on
 *   `signalk-dead-reckoning.observations-changed` /
 *   `…candidate`; a slow poll keeps hosts (or sessions) without the
 *   capability in step too — e.g. when the standalone webapp makes
 *   the change.
 * - **Night mode** (`nightMode`, optional): recolors the overlay via
 *   `overlay.setLayer`.
 *
 * All capabilities are optional-guarded: on a host without data
 * overlays (Freeboard < 3.4) the runtime still runs the override
 * buttons; on any host the REST calls are same-origin.
 *
 * @file dr-ext-runtime.js
 */

import * as cw from "./dr-ext-chartwork.js";
import {
  chartWindow,
  fetchHistory,
  mergeHistoryTrack,
  seriesToTrack,
} from "./dr-history.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** Signal K plugin REST mount (same as the webapp components). */
const API = "/plugins/signalk-dead-reckoning";

/** Overlay + source ids — must match the manifest and style JSON. */
const OVERLAY_ID = "chartwork";
const SOURCE_ID = "dr";

/** Cadences: status poll drives the override buttons; the data poll
 * is the fallback sync for changes made outside this extension. */
const STATUS_POLL_MS = 5000;
const DATA_POLL_MS = 10000;
/** Debounce for overlay pushes (bursty delta + poll arrivals). */
const PUSH_DEBOUNCE_MS = 750;
/** Ghost track ring buffer: the recent hour at 1 Hz. */
const GHOST_MAX_POINTS = 3600;

/** SK paths this runtime relays through the host. */
const STREAM_PATHS = [
  "navigation.deadReckoning.position",
  "navigation.deadReckoning.uncertainty",
  "navigation.position",
];

let client = null;
let overlayReady = false;
let pushTimer = null;
/** Features as last pushed to the host (id → feature) — the diff base
 * for the next push. */
let pushedFeatures = null;

/** Live DR state from the stream. */
let drPosition = null;
let drTimeMs = null;
let uncertainty = null;
/** Latest GNSS position — the Confirm GNSS fix button's payload. */
let lastGnss = null;

/** REST snapshots. */
let lops = [];
let cpls = [];
let fixes = [];
let corrections = [];
let candidate = null;
let overrideActive = false;
/** A previous confirmed fix exists at all (all-time, matching the
 * server's running-fix gate) — not the windowed display list. */
let hasFix = false;
/** Trip boundary from GET /status (SPEC §9.2, ms) — anchors the
 * chartwork window: max(7 days, since trip start), exactly like the
 * webapp's overlay loader. Null → plain 7-day window. */
let tripStartMs = null;

/** The inflated view bounds chartwork geometry is clipped against —
 * lines longer than a view diagonal exceed the canvas coordinate
 * precision range at plotter zooms and silently vanish (a 60 nm LoP
 * spans ±46,500 px at z16, past the ~32,767 px limit; the candidate
 * circle, tiny, kept rendering). Null → full geometry. */
let clipBounds = null;
/** Pending window title with the live count — the API has no button
 * badges, so the count rides the title of the open window. */
let lastPendingCount = null;

/** Ghost track: history backfill merged with the live buffer. */
let ghostHistory = [];
const ghostLive = [];

function debug(...args) {
  console.debug("[dr-ext-runtime]", ...args);
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    // The body's message is the point — the plugin's 400/422 replies
    // (sanity caps, running-fix coverage, …) carry the guidance the
    // watchkeeper needs; a bare status code does not.
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) message = body.message;
    } catch {
      // no JSON body — the status code is all there is
    }
    throw new Error(`${url}: ${message}`);
  }
  return res.json();
}

/**
 * Rebuilds the FeatureCollection from current state and (debounced)
 * pushes it at the overlay. No-op on hosts without `overlays.data`.
 */
function pushOverlay() {
  if (!overlayReady) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const fc = cw.chartworkFeatures({
        lops,
        cpls,
        fixes,
        corrections,
        ghostTrack: mergeHistoryTrack(ghostHistory, ghostLive),
        drPosition,
        drTimeMs,
        uncertainty,
        candidate,
        error: errorNote,
        clipBounds,
      });
      // Diff against what the host already holds: after the first
      // push, a DR tick upserts the ghost tail (and whatever changed)
      // instead of clearing and refilling the whole source every
      // second — full replacements churned the host's vector source
      // hard enough that chartwork flickered out of view through zoom
      // gestures.
      const { upsert, remove, next } = cw.diffFeatures(
        pushedFeatures,
        fc.features,
      );
      if (upsert.length === 0 && remove.length === 0) return;
      // Sea-trial diagnostic for the vanishing-LoP report (the style
      // function is exonerated by a headless repro — it draws every
      // feature at every zoom): the console shows what the runtime
      // pushed and when, so a disappearance can be split between the
      // data (pushes stopped / counts dropped) and the host renderer.
      const kinds = {};
      for (const f of upsert) {
        kinds[f.properties.kind] = (kinds[f.properties.kind] ?? 0) + 1;
      }
      debug(
        `push ${upsert.length} upsert / ${remove.length} remove [${Object.entries(
          kinds,
        )
          .map(([k, n]) => `${k}×${n}`)
          .join(", ")}] clip ${clipBounds ? "view" : "off"}`,
      );
      const params = { overlayId: OVERLAY_ID, source: SOURCE_ID, upsert };
      if (remove.length > 0) params.remove = remove;
      await client.overlays.setData(params);
      // Commit the diff base only on success — a failed push must not
      // make the next one think the host already holds this state.
      pushedFeatures = next;
    } catch (err) {
      debug("overlay push failed", err);
    }
  }, PUSH_DEBOUNCE_MS);
}

/** Refetches the REST snapshots (observations, fixes, corrections),
 * window-filtered to max(7 days, since trip start) so old chartwork
 * outside the window stops cluttering the plotter — the same rule the
 * webapp's overlay loader applies. */
async function refreshData() {
  try {
    const since = new Date(
      chartWindow(Date.now(), tripStartMs).sinceMs,
    ).toISOString();
    const q = `?since=${encodeURIComponent(since)}&`;
    const [obs, fx, corr, latest] = await Promise.all([
      fetchJson(`${API}/observations${q}limit=200`),
      fetchJson(`${API}/fixes${q}limit=100`),
      fetchJson(`${API}/corrections${q}limit=50`),
      // Unfiltered latest fix drives hasFixes — the running-fix gate
      // must match the server's own (latestFixAsPreviousFix looks at
      // all-time latest, not the display window).
      fetchJson(`${API}/fixes?limit=1`),
    ]);
    lops = obs.lops ?? [];
    cpls = obs.cpls ?? [];
    fixes = fx.fixes ?? [];
    corrections = corr.corrections ?? [];
    hasFix = (latest.fixes ?? []).length > 0;
    pushOverlay();
    refreshButtons();
    refreshPendingTitle();
  } catch (err) {
    debug("data refresh failed", err);
  }
}

/** The API has no button badges, so the count rides the open pending
 * window's title: "DR Pending observations (3)". Skipped when the
 * window is closed (the button visibility already says "there are
 * some"). */
async function refreshPendingTitle() {
  if (!client.hasCapability("windows")) return;
  const count = cw.pendingCount(lops, cpls);
  if (count === lastPendingCount) return;
  lastPendingCount = count;
  try {
    const { windows } = await client.call("ui.listWindows");
    for (const w of windows) {
      if (w.panel !== "pending") continue;
      await client.call("ui.updateWindow", {
        windowId: w.windowId,
        title:
          count > 0
            ? `DR Pending observations (${count})`
            : "DR Pending observations",
      });
    }
  } catch (err) {
    debug("pending title failed", err);
  }
}

/** Pushes the toolbar button set (override pair + confirm/resolve +
 * pending window) from the current state. */
async function refreshButtons() {
  // The setVisibility methods take ONE `{ ids, visible }` object per
  // call — an array of pairs is `params must be object`, and every
  // visibility state silently never applied (the bug the console
  // caught on sea trial). Buttons and actions are separate surfaces
  // with separate capability gates and separate id namespaces — a
  // button id in actions.setVisibility is `actions.unknownId`.
  const visibility = cw.toolbarVisibility({
    active: overrideActive === true,
    hasCandidate: candidate != null,
    hasFixes: hasFix === true,
    hasPending: cw.pendingCount(lops, cpls) > 0,
    hasGnss: lastGnss != null,
  });
  if (client.hasCapability("buttons.visibility")) {
    for (const entry of visibility.buttons) {
      try {
        await client.call("buttons.setVisibility", entry);
      } catch (err) {
        debug("button visibility failed", err);
      }
    }
  }
  if (client.hasCapability("actions")) {
    for (const entry of visibility.actions) {
      try {
        await client.call("actions.setVisibility", entry);
      } catch (err) {
        debug("action visibility failed", err);
      }
    }
  }
}

/** Polls /status for the override state and trip boundary → button
 * visibility. */
async function refreshStatus() {
  try {
    const status = await fetchJson(`${API}/status`);
    overrideActive = status.active === true;
    tripStartMs = status.tripStartMs ?? null;
    refreshButtons();
  } catch (err) {
    debug("status poll failed", err);
  }
}

/**
 * Backfills the ghost track from the History API (best-effort — no
 * provider configured means the live buffer alone), over the same
 * window as the chartwork REST rows.
 */
async function backfillGhost() {
  try {
    const { durationSec } = chartWindow(Date.now(), tripStartMs);
    const series = await fetchHistory({
      paths: ["navigation.deadReckoning.position"],
      durationSec,
      resolutionSec: 600,
    });
    const track = series.find(
      (s) => s.path === "navigation.deadReckoning.position",
    );
    if (track && track.points.length > 0) {
      ghostHistory = seriesToTrack(track.points);
      pushOverlay();
    }
  } catch {
    // no history provider — live-session buffer only
  }
}

/** Applies the day/night palette to every palette-colored layer,
 * each through the paint property its layer type takes. Text recolors
 * with its halo; the fix circles keep their per-feature fill and only
 * the stroke follows the theme. */
async function applyPalette(night) {
  if (!overlayReady) return;
  for (const layerId of cw.PALETTE_LAYER_IDS) {
    const prop = cw.PAINT_PROPERTY[layerId] ?? "line-color";
    const paint = { [prop]: cw.paletteColor(layerId, night) };
    if (layerId === "dr-labels" || layerId === "dr-error") {
      paint["text-halo-color"] = cw.paletteColor("dr-pos", night);
    }
    try {
      await client.overlays.setLayer({
        overlayId: OVERLAY_ID,
        layer: layerId,
        paint,
      });
    } catch {
      // a layer the host skips is reported via skippedLayers —
      // recolor whatever it accepts
    }
  }
}

/** Handles one published event from the extension's own topics. */
function onExtensionEvent(topic, params) {
  switch (topic) {
    case "signalk-dead-reckoning.override": {
      const active = params?.active === true;
      fetchJson(`${API}/override`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      })
        .then(refreshStatus)
        .catch((err) => debug("override PUT failed", err));
      break;
    }
    case "signalk-dead-reckoning.confirm":
      confirmCandidate();
      break;
    case "signalk-dead-reckoning.resolve":
      resolveFrom(params?.target);
      break;
    case "signalk-dead-reckoning.delete":
      deleteObservation(params?.target);
      break;
    case "signalk-dead-reckoning.confirm-gnss":
      confirmGnss();
      break;
    case "signalk-dead-reckoning.observations-changed":
      refreshData();
      break;
    case "signalk-dead-reckoning.candidate":
      candidate = params?.candidate ?? null;
      pushOverlay();
      refreshButtons();
      break;
    default:
      break;
  }
}

/** Confirms the pending candidate — the deliberate second step
 * (SPEC §9.1), driven from the toolbar button or a tap on the
 * candidate ring. A no-op without a candidate (e.g. a press on a host
 * that ignores button visibility). */
async function confirmCandidate() {
  if (!candidate) {
    // A press with nothing pending (a host without button visibility):
    // say so where the user is looking, not just in a console.
    reportError(
      "confirm",
      new Error("nothing to confirm — no candidate fix is pending"),
    );
    return;
  }
  try {
    await fetchJson(`${API}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate }),
    });
    candidate = null;
    pushOverlay();
    await refreshData();
  } catch (err) {
    reportError("confirm", err);
  }
}

/** The DR origin's bootstrap: confirm the latest GNSS position as a
 * fix, which snaps the DR origin to truth — a months-old origin from a
 * test server must not veto the first real fix through the sanity cap.
 * During OVERRIDE `navigation.position` is the DR position itself;
 * confirming it re-anchors the origin to the current best estimate,
 * which is the legitimate use here. */
async function confirmGnss() {
  if (!lastGnss) {
    reportError("confirm-gnss", new Error("no GNSS position available yet"));
    return;
  }
  try {
    await fetchJson(`${API}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: lastGnss.latitude,
        longitude: lastGnss.longitude,
        source_type: "gps",
      }),
    });
    candidate = null;
    pushOverlay();
    await refreshData();
  } catch (err) {
    reportError("confirm-gnss", err);
  }
}

/** Publishes a failure to the extension's panels (scope extension) AND
 * draws it on the chart as a transient red note at the DR position —
 * the surface chart-driven errors need when no panel window is open:
 * a confirm the server rejected, a resolve without coverage, must be
 * visible where the watchkeeper is looking, not only in a console. */
let errorNote = null;
let errorTimer = null;
function reportError(where, err) {
  debug(where, err);
  const message = err?.message ?? String(err);
  errorNote = cw.errorFeature(message, drPosition);
  pushOverlay();
  client
    .publish("signalk-dead-reckoning.error", { where, message }, "extension")
    .catch(() => {});
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorNote = null;
    pushOverlay();
  }, 8000);
}

/** Chart-driven one-observation resolve (running fix): resolves a
 * clicked LoP/CPL against the previous confirmed fix. Requires one —
 * the server's honest 400 explains it, and reaches the panels as an
 * error event; no candidate appears. */
async function resolveFrom(target) {
  const featureId = String(target?.featureId ?? "");
  const sep = featureId.indexOf(":");
  if (sep < 0) return;
  const kind = featureId.slice(0, sep);
  const id = Number(featureId.slice(sep + 1));
  if (!Number.isFinite(id)) return;
  const body =
    kind === "lop"
      ? { lop_ids: [id] }
      : kind === "cpl"
        ? { cpl_ids: [id] }
        : null;
  if (!body) return;
  try {
    const data = await fetchJson(`${API}/fix/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    candidate = data.candidate ?? null;
    pushOverlay();
    refreshButtons();
  } catch (err) {
    reportError("resolve", err);
  }
}

/** Chart-driven delete of a clicked LoP/CPL. The pending candidate is
 * dropped with it — conservative, since it may have been resolved from
 * the observation just removed. */
async function deleteObservation(target) {
  const featureId = String(target?.featureId ?? "");
  const sep = featureId.indexOf(":");
  if (sep < 0) return;
  const kind = featureId.slice(0, sep);
  const id = Number(featureId.slice(sep + 1));
  if (!Number.isFinite(id) || (kind !== "lop" && kind !== "cpl")) return;
  try {
    await fetchJson(`${API}/fix/${kind}/${id}`, { method: "DELETE" });
    candidate = null;
    await refreshData();
  } catch (err) {
    reportError("delete", err);
  }
}

async function start() {
  client = await connectExtension();
  debug("connected; capabilities:", client.capabilities);

  await client.subscribe(
    ["signalk-dead-reckoning.**", "nightMode.changed", "action.invoked"],
    (_topic, params) => {
      if (_topic === "nightMode.changed") {
        applyPalette(params?.enabled === true);
        return;
      }
      if (_topic === "action.invoked") {
        // The candidate ring's default action (primary select) opens
        // the fix-resolution window. The host performs the action's
        // own openWindow too; this runtime-side open is the belt to
        // its braces — single:true adopts an already-open window, so
        // the double delivery lands as one raised window.
        if (params?.actionId === "review-fix") {
          client
            .call("ui.openWindow", {
              panel: "pending",
              geometry: { anchor: "bottom-right", width: 380, height: "90%" },
              single: true,
              restoreKey: "pending-v2",
            })
            .catch((err) => debug("review window failed", err));
        }
        return;
      }
      onExtensionEvent(_topic, params);
    },
  );

  await client.signalk.subscribe(STREAM_PATHS, (ev) => {
    if (ev.path === "navigation.deadReckoning.position") {
      if (ev.value?.latitude == null) return;
      drPosition = [ev.value.latitude, ev.value.longitude];
      const t = Date.parse(ev.timestamp);
      drTimeMs = Number.isFinite(t) ? t : Date.now();
      const n = ghostLive.length;
      const [pLat, pLon, pT] = n > 0 ? ghostLive[n - 1] : [null, null, 0];
      if (
        pLat !== drPosition[0] ||
        pLon !== drPosition[1] ||
        drTimeMs - pT >= 1000
      ) {
        ghostLive.push([drPosition[0], drPosition[1], drTimeMs]);
        if (ghostLive.length > GHOST_MAX_POINTS) ghostLive.shift();
      }
      pushOverlay();
      return;
    }
    if (ev.path === "navigation.deadReckoning.uncertainty") {
      uncertainty = ev.value ?? null;
      pushOverlay();
      return;
    }
    if (ev.path === "navigation.position") {
      // The Confirm GNSS fix button's payload.
      if (ev.value?.latitude == null) return;
      const wasNull = lastGnss == null;
      lastGnss = { latitude: ev.value.latitude, longitude: ev.value.longitude };
      if (wasNull) refreshButtons();
    }
  });

  if (client.hasCapability("overlays.data")) {
    try {
      const overlays = await client.overlays.list();
      overlayReady = overlays.some((o) => o.id === OVERLAY_ID);
      // What the host declined to draw, on the record: a style layer
      // it cannot reproduce exactly is skipped, not approximated —
      // and a skipped chartwork layer would silently thin out the
      // plot.
      for (const o of overlays) {
        for (const s of o.skippedLayers ?? []) {
          console.warn(
            `[dr-ext-runtime] host skipped overlay layer ${s.id} (${s.reason}${s.detail ? `: ${s.detail}` : ""})`,
          );
        }
      }
    } catch (err) {
      debug("overlay.list failed", err);
    }
    if (overlayReady) {
      try {
        const { enabled } = await client.nightMode.get();
        applyPalette(enabled === true);
      } catch {
        // nightMode optional — day palette stays
      }
    } else {
      debug(`overlay ${OVERLAY_ID} not offered by host`);
    }
  }

  await refreshStatus();
  await refreshView();
  await refreshData();
  if (overlayReady) backfillGhost();
  if (client.hasCapability("map")) {
    // The view moved: re-clip the chartwork to the new bounds (the
    // diff push only upserts the features whose clipped geometry
    // changed).
    await client.subscribe(["map.view"], (_t, view) => {
      updateClipBounds(view?.bounds ?? null);
      pushOverlay();
    });
  }
  setInterval(refreshStatus, STATUS_POLL_MS);
  setInterval(refreshData, DATA_POLL_MS);
}

/** Reads the current view (seed-then-follow: subscribe first would
 * miss nothing, but the initial read is needed before the first
 * push). */
async function refreshView() {
  if (!client.hasCapability("map")) return;
  try {
    const view = await client.call("map.getView");
    updateClipBounds(view?.bounds ?? null);
  } catch (err) {
    debug("view read failed", err);
  }
}

/** @param {[number, number, number, number]|null} bounds */
function updateClipBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds[0])) {
    clipBounds = null;
    return;
  }
  clipBounds = cw.inflateBounds(bounds, 0.5);
}

start().catch((err) => console.warn("[dr-ext-runtime] start failed", err));
