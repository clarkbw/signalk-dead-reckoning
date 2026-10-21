/**
 * DR Sight / Fix **panel page** (work doc #38): the plotter-extension
 * front end for sight entry and fix resolution, served into a
 * Freeboard-SK panel or floating window.
 *
 * The page is a thin adapter — the actual UI is the standalone
 * webapp's own components, reused verbatim: `<dr-pending-list>`,
 * `<dr-sight-panel>` and `<dr-fix-panel>` do their own same-origin
 * REST calls against the plugin; this wrapper only:
 *
 * - seeds them with live data the way dr-app.js does (default
 *   position: DR first, GPS fallback; magnetic variation; GNSS
 *   quality; position format from the plugin configuration; celestial
 *   body list);
 * - bridges host interactions the webapp got from its own map:
 *   chart-object actions and picks arrive as `context.invocation` /
 *   `action.invoked` targets (coordinates + charted name) or through
 *   `map.pick` from the toolbar button, and land in
 *   `sight.seedObjectPosition()`;
 * - forwards the components' events to the background runtime
 *   (`events.publish`, extension scope): observation changes and
 *   candidate previews keep the chartwork overlay in step instantly;
 * - closes its window/panel when a component asks to (`dr-close`).
 *
 * @file dr-ext-panel.js
 */

import * as posfmt from "./dr-position-format.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";
import "./dr-pending-list.js";
import "./dr-sight-panel.js";
import "./dr-fix-panel.js";

const API = "/plugins/signalk-dead-reckoning";
const CONFIG_PATH = "/signalk/v2/api/signalk-dead-reckoning/configuration";

/** Action id → sight-entry mode (dr-sight-panel tabs). */
const ACTION_MODES = {
  "sight-bearing": "bearing",
  "sight-vertical": "vertical",
  "sight-radar": "radar",
  "sight-hangle": "hangle",
};

/** Pending-list refresh cadence while the panel is loaded but idle:
 * keeps the list honest against REST changes made elsewhere (the
 * standalone webapp, another station). */
const PENDING_POLL_MS = 30000;

let client = null;
let sight = null;
let pending = null;
let fixat = null;
let drSeen = false;
const gnss = {};

/** The `?view=pending` mount: the pending observations window (own
 * toolbar button, own panel id) — no sight forms live here. */
const PENDING_VIEW =
  new URLSearchParams(window.location.search).get("view") === "pending";

const els = {};

function $(id) {
  return document.getElementById(id);
}

function debug(...args) {
  console.debug("[dr-ext-panel]", ...args);
}

/** Publishes to the runtime when the host carries events.publish;
 * without it the runtime's poll catches up on its own. */
function publish(topic, params) {
  if (!client.hasCapability("events.publish")) return;
  client.publish(topic, params, "extension").catch((err) => debug(err));
}

/** Keeps the runtime's candidate (and its Confirm fix toolbar button)
 * in step with the pending list's own: every selection change and
 * refresh re-publishes what is (no longer) pending confirmation. */
function publishCandidate() {
  publish("signalk-dead-reckoning.candidate", {
    candidate: pending?.candidate ?? null,
  });
}

/** Refreshes the pending list (the components don't self-fetch), then
 * syncs the runtime — observations and candidate state together. */
async function observationsChanged() {
  await pending?.refresh?.();
  publish("signalk-dead-reckoning.observations-changed", {});
  publishCandidate();
}

/** Pins the panel to one sight method (chart-object actions): only
 * that form renders — no pending list, no fix-at section. */
function applyMode(mode) {
  document.body.classList.toggle("single", mode != null);
  if (mode != null) sight.setAttribute("single-tab", mode);
  else sight.removeAttribute("single-tab");
  // Same default the webapp's openSight() applies: sight time to now
  // in every (empty) form, so a fresh window records the sight just
  // taken without typing a clock time.
  sight?.seedSightTime();
}

/**
 * Seeds one chart target into the sight form: coordinates + charted
 * name into the active (or given) tab, exactly as the webapp's map
 * pick does. Targets carry `position` always and `featurePosition`
 * for point features — bearings and ranges must start from the
 * object's own position, not wherever the finger landed.
 */
function seedTarget(target, mode, prefix = null) {
  if (!sight || !target) return;
  const pos = target.featurePosition ?? target.position;
  if (!Array.isArray(pos)) return;
  const [lon, lat] = pos;
  const tab = mode ?? sight.activeTab ?? "bearing";
  sight.switchTab(tab);
  sight.seedObjectPosition(lat, lon, tab, target.name ?? null, null, prefix);
}

/** Handles an action invocation (first load or later): open sights on
 * a charted object, or edit an observation clicked in the overlay.
 * Never in the pending view — sight invocations broadcast to every
 * context of the extension, and this window has no sight forms. */
async function handleInvocation(invocation) {
  if (PENDING_VIEW) return;
  const { actionId, target } = invocation ?? {};
  if (!actionId || !target) return;
  if (actionId === "sight-edit") {
    const featureId = String(target.featureId ?? "");
    const sep = featureId.indexOf(":");
    if (sep < 0) return;
    const kind = featureId.slice(0, sep);
    if (kind !== "lop" && kind !== "cpl") return;
    try {
      const obs = await fetch(`${API}/observations?limit=200`).then((r) =>
        r.json(),
      );
      const rows = kind === "lop" ? (obs.lops ?? []) : (obs.cpls ?? []);
      const id = Number(featureId.slice(sep + 1));
      const record = rows.find(
        (row) => (kind === "lop" ? row.lop_id : row.cpl_id) === id,
      );
      if (record) sight?.beginEdit({ ...record, kind });
    } catch (err) {
      debug("edit lookup failed", err);
    }
    return;
  }
  const mode = ACTION_MODES[actionId];
  if (mode) {
    applyMode(mode);
    seedTarget(target, mode);
  }
}

/** Wire the components' event surface (dr-app.js parity). */
function wireComponents() {
  sight.addEventListener("dr-observations-changed", observationsChanged);
  sight.addEventListener("dr-close", closeSelf);

  pending.addEventListener("dr-observations-changed", observationsChanged);
  pending.addEventListener("dr-select-observation", publishCandidate);
  pending.addEventListener("dr-candidate-resolved", (e) => {
    // The event detail IS the candidate object (dr-app uses it the
    // same way) — not a wrapper carrying one.
    publish("signalk-dead-reckoning.candidate", {
      candidate: e.detail ?? null,
    });
  });
  pending.addEventListener("dr-fix-confirmed", () => {
    publish("signalk-dead-reckoning.candidate", { candidate: null });
    observationsChanged();
  });
  pending.addEventListener("dr-edit-observation", async (e) => {
    const { kind, id } = e.detail ?? {};
    if (!kind || !id) return;
    try {
      const obs = await fetch(`${API}/observations?limit=200`).then((r) =>
        r.json(),
      );
      const rows = kind === "lop" ? (obs.lops ?? []) : (obs.cpls ?? []);
      const record = rows.find(
        (row) => (kind === "lop" ? row.lop_id : row.cpl_id) === id,
      );
      if (record) sight?.beginEdit({ ...record, kind });
    } catch (err) {
      debug("edit lookup failed", err);
    }
  });

  fixat.addEventListener("dr-fix-confirmed", observationsChanged);
}

/** Closes the hosting window or panel after a component's dr-close
 * (the webapp closes its dialog on submit). keepAlive panels stay
 * loaded — the close only hides them. */
function closeSelf() {
  try {
    if (client.context?.kind === "window") {
      client.call("ui.closeWindow", {}).catch(() => {});
    } else if (client.context?.kind === "panel") {
      client.call("ui.closePanel", {}).catch(() => {});
    }
  } catch (err) {
    debug("close failed", err);
  }
}

/** Chart picks: the sight form's per-fieldset ⊙ Pick buttons ask for
 * a pick (dr-pick-request), the host's map.pick runs, and the picked
 * target lands back in the requesting fieldset. The picked event is
 * delivered only to the context that asked, so one startup
 * subscription serves every pick. */
function wirePick() {
  if (!client.hasCapability("map.pick")) return;
  let request = null;
  client
    .subscribe(["map.picked"], (_name, picked) => {
      request = null;
      if (picked?.cancelled || !picked?.target) return;
      seedTarget(
        picked.target,
        request?.mode ?? sight?.activeTab,
        request?.prefix ?? null,
      );
    })
    .catch((err) => debug(err));
  sight.addEventListener("dr-pick-request", (e) => {
    request = e.detail ?? {};
    client
      .call("map.pick", {
        prompt: "Tap the sight object",
        targets: ["chartFeature", "waypoint", "aton", "position"],
      })
      .catch((err) => {
        request = null;
        debug("pick failed", err);
      });
  });
}

/** Seeds the components with the same live data dr-app feeds them:
 * default position (DR first, GPS when DR is silent), magnetic
 * variation, GNSS quality, and the plugin's position format. */
function wireSeeding() {
  const seedPos = (value, isDr) => {
    if (value?.latitude == null) return;
    if (isDr) {
      drSeen = true;
      sight?.setDefaultPosition(value);
      return;
    }
    if (!drSeen) sight?.setDefaultPosition(value);
    fixat?.updateGnss({ position: [value.latitude, value.longitude], gnss });
  };

  client.signalk
    .subscribe(
      [
        "navigation.deadReckoning.position",
        "navigation.position",
        "navigation.magneticVariation",
      ],
      (ev) => {
        if (ev.path === "navigation.deadReckoning.position") {
          seedPos(ev.value, true);
        } else if (ev.path === "navigation.position") {
          seedPos(ev.value, false);
        } else if (ev.path === "navigation.magneticVariation") {
          if (Number.isFinite(ev.value)) {
            sight?.setMagneticVariation((ev.value * 180) / Math.PI);
          }
        }
      },
    )
    .catch((err) => debug("stream subscribe failed", err));

  // Position format is a plugin (server-side) preference, not host UI.
  fetch(CONFIG_PATH)
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      const fmt = body?.config?.positionFormat;
      if (fmt === "decimal" || fmt === "dm" || fmt === "dms") {
        posfmt.setFormat(fmt);
        sight?.applyFormat(fmt);
        fixat?.applyFormat(fmt);
      }
    })
    .catch(() => {});
}

/** The runtime reports chart-driven failures (resolve/delete/confirm)
 * on this topic — an honest message strip in both views, auto-clearing
 * after a few seconds. */
function wireErrors() {
  const el = $("ext-error");
  let timer = null;
  client
    .subscribe(["signalk-dead-reckoning.error"], (_name, params) => {
      el.textContent = params?.message ?? "error";
      el.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        el.hidden = true;
      }, 8000);
    })
    .catch((err) => debug(err));
}

async function start() {
  client = await connectExtension();
  debug("connected; context:", client.context?.kind);

  pending = $("pending");
  sight = $("sight");
  fixat = $("fixat");

  if (PENDING_VIEW) document.body.classList.add("view-pending");

  wireComponents();
  wireSeeding();
  wirePick();
  wireErrors();
  sight.loadBodies();
  sight.seedSightTime();
  pending.refresh?.();

  // A window open may carry params ({mode}) from the manifest action:
  // the action-launched window renders only that method's form.
  const paramMode = client.context?.params?.mode;
  if (paramMode) {
    applyMode(paramMode);
    sight?.switchTab(paramMode);
  } else {
    applyMode(null);
  }

  // The target of the action that loaded this context arrives in the
  // handshake; later invocations (button re-press, another action)
  // arrive as action.invoked.
  if (client.context?.invocation) {
    await handleInvocation(client.context.invocation);
  }
  await client.subscribe(["action.invoked"], (_name, invocation) => {
    handleInvocation(invocation);
  });

  setInterval(() => pending?.refresh?.(), PENDING_POLL_MS);
}

start().catch((err) => console.warn("[dr-ext-panel] start failed", err));
