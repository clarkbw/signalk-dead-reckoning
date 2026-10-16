/**
 * Pure, DOM-free logic for the plotter-extension **host** (work doc
 * #27). Everything here is importable in Node for tests: manifest
 * filtering, the widget-layout model, state-storage key rules, the
 * per-context Signal K path registry, and delta routing. The DOM/bus
 * glue lives in `dr-ext-host.js`; the wire protocol in
 * `vendor/plotterext-bus` (host entry).
 *
 * @file dr-ext-host-core.js
 */

/** Widget-area anchors the webapp offers (work doc #27): grids that
 * flow *below* the host's own top panels — top-left under the entry
 * tools, top-right under the GPS status panel. Extensions never see
 * anchors; placement is host-internal. */
export const AREA_ANCHORS = ["top-left", "top-right"];

/** Grid geometry per area: 2 columns × 2 rows (Plotter Extensions API
 * v1 layout model). */
export const GRID_COLS = 2;
export const GRID_ROWS = 2;

/** Capabilities this host advertises (work doc #27 v1 scope, plus the
 * chart-layer phase): widgets and panels, headless background runtimes,
 * image map overlays, the map viewport, and the user's units. `buttons`
 * covers mapToolbar entries; `signalk.put` is offered but only works
 * for write-capable sessions. */
export const HOST_CAPABILITIES = [
  "widgets",
  "panels.iframe",
  "signalk.stream",
  "signalk.put",
  "background.iframe",
  "overlays.image",
  "map",
  "units",
  "buttons",
];

/** API major version this host implements. */
export const API_VERSION = "1";

/** Baseline sandbox for every extension iframe: fault containment,
 * not an adversarial boundary (install time is the trust decision).
 * Shared by the widget/panel contexts and the headless background
 * runtimes — one definition so they cannot drift. */
export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

/**
 * Parses a widget `size` ("<cols>x<rows>") into cell spans.
 *
 * @param {unknown} size
 * @returns {{cols: number, rows: number}|null} null when malformed or
 *   larger than the 2×2 grid
 */
export function parseSize(size) {
  if (typeof size !== "string") return null;
  const m = /^([12])x([12])$/.exec(size);
  if (!m) return null;
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

/**
 * Is a contribution entry (widget/panel) usable on this host? Checks
 * the entry's own `apiVersion` (contributions may need a newer host
 * API than the manifest baseline — hosts silently omit those) and, for
 * widgets, a valid `size`.
 *
 * @param {object} entry - manifest contribution entry
 * @param {string} kind - "widgets" | "panels"
 * @returns {boolean}
 */
export function contributionUsable(entry, kind) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (typeof entry.url !== "string" || entry.url === "") return false;
  if (entry.apiVersion !== undefined && entry.apiVersion !== API_VERSION) {
    return false;
  }
  if (kind === "widgets" && parseSize(entry.size) == null) return false;
  return true;
}

/**
 * Is a `background[]` runtime entry usable? A headless iframe needs an
 * id and a page to load; everything else is the runtime's business.
 *
 * @param {object} entry - manifest background entry
 * @returns {boolean}
 */
export function backgroundUsable(entry) {
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.url === "string" &&
    entry.url !== ""
  );
}

/** Overlay bands the host composites (above the charts, in manifest
 * order; `aboveResources` sits above those). */
export const OVERLAY_BANDS = ["aboveCharts", "aboveResources"];

/**
 * Is an `overlays[]` entry usable? Only `image` overlays are hosted —
 * the host composites bitmaps the extension's runtime draws; `data`
 * overlays (host-drawn MapLibre styles) are a separate capability this
 * host does not advertise, so they never reach the filter.
 *
 * @param {object} entry - manifest overlay entry
 * @returns {boolean}
 */
export function overlayUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  // Type is optional in the manifest (image was the only kind when the
  // field was introduced); an explicit non-image type is not hosted.
  if (entry.type !== undefined && entry.type !== "image") return false;
  if (entry.band !== undefined && !OVERLAY_BANDS.includes(entry.band)) {
    return false;
  }
  return true;
}

/**
 * Is a `buttons[]` entry usable? This host renders mapToolbar buttons
 * only; entries for slots it does not have are ignored per the spec.
 *
 * @param {object} entry - manifest button entry
 * @returns {boolean}
 */
export function buttonUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (entry.slot !== undefined && entry.slot !== "mapToolbar") return false;
  return true;
}

/**
 * Filters a discovered `plotterExtensions` collection down to the
 * extensions this host can offer: manifest `apiVersion` must match,
 * every `requires` capability must be advertised, and contributions
 * are narrowed to usable widget/panel/overlay/background/button
 * entries (unknown sections are ignored per the spec).
 *
 * @param {object} collection - `{ [extId]: manifest }`
 * @param {string[]} capabilities
 * @returns {Map<string, {manifest: object, widgets: object[],
 *   panels: object[], overlays: object[], background: object[],
 *   buttons: object[]}>}
 */
export function compatibleExtensions(collection, capabilities) {
  const out = new Map();
  if (!collection || typeof collection !== "object") return out;
  for (const [extId, manifest] of Object.entries(collection)) {
    if (!manifest || typeof manifest !== "object") continue;
    if (manifest.apiVersion !== API_VERSION) continue; // never offer newer
    const requires = Array.isArray(manifest.requires) ? manifest.requires : [];
    if (!requires.every((c) => capabilities.includes(c))) continue;
    const widgets = (Array.isArray(manifest.widgets) ? manifest.widgets : [])
      .filter((w) => contributionUsable(w, "widgets"))
      .map((w) => ({ ...w, size: w.size })); // validated by contributionUsable
    const panels = (
      Array.isArray(manifest.panels) ? manifest.panels : []
    ).filter((p) => contributionUsable(p, "panels"));
    const overlays = (
      Array.isArray(manifest.overlays) ? manifest.overlays : []
    ).filter(overlayUsable);
    const background = (
      Array.isArray(manifest.background) ? manifest.background : []
    ).filter(backgroundUsable);
    const buttons = (
      Array.isArray(manifest.buttons) ? manifest.buttons : []
    ).filter(buttonUsable);
    if (
      widgets.length === 0 &&
      panels.length === 0 &&
      overlays.length === 0 &&
      background.length === 0 &&
      buttons.length === 0
    ) {
      continue;
    }
    out.set(extId, {
      manifest,
      widgets,
      panels,
      overlays,
      background,
      buttons,
    });
  }
  return out;
}

/**
 * Cells covered by a widget placed at (row, col) with the given size.
 *
 * @param {{cols: number, rows: number}} size
 * @param {number} row
 * @param {number} col
 * @returns {Array<[number, number]>}
 */
export function cellsFor(size, row, col) {
  const cells = [];
  for (let r = 0; r < size.rows; r++) {
    for (let c = 0; c < size.cols; c++) {
      cells.push([row + r, col + c]);
    }
  }
  return cells;
}

/**
 * Does a widget of this size still fit inside the 2×2 grid when
 * anchored at (row, col)?
 *
 * @param {{cols: number, rows: number}} size
 * @param {number} row
 * @param {number} col
 * @returns {boolean}
 */
export function fitsInGrid(size, row, col) {
  return (
    row >= 0 &&
    col >= 0 &&
    row + size.rows <= GRID_ROWS &&
    col + size.cols <= GRID_COLS
  );
}

/**
 * Occupied-cell map for an anchor's placements (1-based? no — 0-based
 * [row, col] keys). Malformed stored entries are skipped rather than
 * throwing — layout is localStorage data, not gospel.
 *
 * @param {Array<object>} placements
 * @returns {Set<string>} "r,c" keys
 */
export function occupiedCells(placements) {
  const occ = new Set();
  for (const p of placements ?? []) {
    const size = parseSize(p?.size);
    if (!size || !fitsInGrid(size, p.row, p.col)) continue;
    for (const [r, c] of cellsFor(size, p.row, p.col)) occ.add(`${r},${c}`);
  }
  return occ;
}

/**
 * Do placements in this anchor mirror their column axis? Right-hand
 * anchors render mirrored: logical col 0 is the viewport corner (the
 * RIGHT edge), so widgets pack corner-inward — symmetric with left
 * anchors, where col 0 is the left edge. Without the mirror the first
 * placed widget lands in the cell farthest from the corner and the
 * free space sits between it and the edge.
 *
 * @param {string} anchor
 * @returns {boolean}
 */
export function isMirroredAnchor(anchor) {
  return typeof anchor === "string" && anchor.endsWith("-right");
}

/**
 * CSS grid column line (1-based, physical left→right) where a
 * placement's left edge renders for the given anchor. Mirrored
 * (right-hand) anchors flip the column axis: a placement at logical
 * column `col` spans lines `GRID_COLS - col - cols + 1 ..
 * GRID_COLS - col`.
 *
 * @param {string} anchor
 * @param {number} col - 0-based logical column (0 = the anchor corner)
 * @param {number} cols - placement column span
 * @returns {number} 1-based CSS grid column line
 */
export function gridColLine(anchor, col, cols) {
  if (isMirroredAnchor(anchor)) return GRID_COLS - col - cols + 1;
  return col + 1;
}

/**
 * First position (packing from the grid origin, row-major) where a
 * widget of this size fits without overlapping existing placements.
 *
 * @param {Array<object>} placements - the anchor's current placements
 * @param {string} size
 * @returns {{row: number, col: number}|null}
 */
export function firstFreeSlot(placements, size) {
  const parsed = parseSize(size);
  if (!parsed) return null;
  const occ = occupiedCells(placements);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!fitsInGrid(parsed, r, c)) continue;
      const clash = cellsFor(parsed, r, c).some(([rr, cc]) =>
        occ.has(`${rr},${cc}`),
      );
      if (!clash) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Validates/repairs a persisted layout blob. Returns a clean layout
 * (`{version, areas}`) or null when unparseable.
 *
 * @param {unknown} raw
 * @returns {{version: number, areas: Record<string, Array<object>>}|null}
 */
export function layoutFromJSON(raw) {
  if (!raw || typeof raw !== "object") return null;
  const areas = {};
  const src = raw.areas ?? {};
  for (const anchor of AREA_ANCHORS) {
    const list = src[anchor];
    areas[anchor] = Array.isArray(list) ? list.filter(validPlacement) : [];
  }
  return { version: 1, areas };
}

/**
 * @param {unknown} p
 * @returns {boolean}
 */
function validPlacement(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.extensionId === "string" &&
    typeof p.widgetId === "string" &&
    typeof p.instanceId === "string" &&
    p.instanceId !== "" &&
    parseSize(p.size) != null &&
    Number.isInteger(p.row) &&
    Number.isInteger(p.col) &&
    fitsInGrid(parseSize(p.size), p.row, p.col)
  );
}

/**
 * Drops placements whose extension/widget is no longer offered (plugin
 * disabled, uninstalled, or filtered by capability) — presence in the
 * collection is the enablement signal, so a stale placement has
 * nothing to attach to. Also re-slots placements that would now
 * overlap (e.g. after hand-edited storage): kept in row-major order.
 *
 * @param {{version: number, areas: Record<string, Array<object>>}} layout
 * @param {Map<string, {manifest: object, widgets: object[], panels: object[]}>} compatible
 * @returns {{layout: object, changed: boolean}}
 */
export function pruneLayout(layout, compatible) {
  let changed = false;
  const areas = {};
  for (const anchor of AREA_ANCHORS) {
    const kept = [];
    const occ = new Set();
    for (const p of layout.areas[anchor] ?? []) {
      const ext = compatible.get(p.extensionId);
      const widget = ext?.widgets.find((w) => w.id === p.widgetId);
      if (!widget) {
        changed = true;
        continue;
      }
      const size = parseSize(widget.size);
      const cells = cellsFor(size, p.row, p.col);
      const clash = cells.some(([r, c]) => occ.has(`${r},${c}`));
      if (clash || cells.length === 0) {
        changed = true;
        continue; // orphaned overlap: drop rather than trust stale data
      }
      for (const [r, c] of cells) occ.add(`${r},${c}`);
      kept.push({ ...p, size: widget.size });
    }
    areas[anchor] = kept;
  }
  return { layout: { version: 1, areas }, changed };
}

/**
 * localStorage key for the widget layout (work doc #27).
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function layoutKey(prefix = "dr.plotterext") {
  return `${prefix}.layout.v1`;
}

/**
 * localStorage key for persisted overlay layer state (visibility,
 * opacity) — saved like the chart layers' own prefs (work doc #27,
 * chart-layer phase).
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function overlayStateKey(prefix = "dr.plotterext") {
  return `${prefix}.overlays.v1`;
}

/** Overlay state defaults per the manifest entry. */
export const OVERLAY_DEFAULTS = {
  band: "aboveCharts",
  visible: true,
  opacity: 0.85,
  minZoom: 0,
};

/**
 * Merges a manifest overlay entry with the host defaults.
 *
 * @param {object} entry - validated overlay manifest entry
 * @returns {{id: string, title: string, band: string, visible: boolean,
 *   opacity: number, minZoom: number, configPanel: string|null,
 *   preferredPixelRatio: number|null, runtime: string|null}}
 */
export function overlaySpec(entry) {
  const opacity =
    typeof entry.opacity === "number" &&
    entry.opacity >= 0 &&
    entry.opacity <= 1
      ? entry.opacity
      : OVERLAY_DEFAULTS.opacity;
  return {
    id: entry.id,
    title: entry.title ?? entry.id,
    band: entry.band ?? OVERLAY_DEFAULTS.band,
    visible: entry.visible ?? OVERLAY_DEFAULTS.visible,
    opacity,
    minZoom:
      typeof entry.minZoom === "number"
        ? entry.minZoom
        : OVERLAY_DEFAULTS.minZoom,
    configPanel:
      typeof entry.configPanel === "string" ? entry.configPanel : null,
    preferredPixelRatio:
      typeof entry.preferredPixelRatio === "number"
        ? entry.preferredPixelRatio
        : null,
    // The background runtime that draws this overlay's frames.
    runtime: typeof entry.runtime === "string" ? entry.runtime : null,
  };
}

/**
 * Overlay layer state, persisted per extension+overlay the way the
 * chart layers' toggles are. Storage is injected so Node tests can
 * pass a fake; the store holds only user overrides — entries missing
 * from storage fall back to the manifest defaults.
 */
export class OverlayStateStore {
  /**
   * @param {{getItem: (k: string) => string|null,
   *           setItem: (k: string, v: string) => void}} storage
   */
  constructor(storage) {
    this.storage = storage;
    this.data = this.load();
  }

  /**
   * @returns {Record<string, Record<string, {visible?: boolean, opacity?: number}>>}
   */
  load() {
    try {
      const raw = this.storage.getItem(overlayStateKey());
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * @returns {void}
   */
  save() {
    this.storage.setItem(overlayStateKey(), JSON.stringify(this.data));
  }

  /**
   * Effective state for an overlay: manifest defaults merged with the
   * user's persisted overrides.
   *
   * @param {object} spec - overlaySpec() output (manifest defaults)
   * @param {string} extId
   * @returns {{visible: boolean, opacity: number}}
   */
  effective(spec, extId) {
    const saved = this.data[extId]?.[spec.id] ?? {};
    return {
      visible: saved.visible ?? spec.visible,
      opacity:
        typeof saved.opacity === "number" &&
        saved.opacity >= 0 &&
        saved.opacity <= 1
          ? saved.opacity
          : spec.opacity,
    };
  }

  /**
   * Persists a user override.
   *
   * @param {string} extId
   * @param {string} overlayId
   * @param {{visible?: boolean, opacity?: number}} patch
   * @returns {{visible: boolean, opacity: number}} the new effective
   *   state (against bare defaults — callers merge with their spec)
   */
  set(extId, overlayId, patch) {
    if (!this.data[extId]) this.data[extId] = {};
    const ext = this.data[extId];
    const cur = ext[overlayId] ?? {};
    if (patch.visible !== undefined) cur.visible = patch.visible;
    if (patch.opacity !== undefined) cur.opacity = patch.opacity;
    ext[overlayId] = cur;
    this.save();
    return { visible: cur.visible ?? true, opacity: cur.opacity ?? 0.85 };
  }

  /**
   * Drops an extension's overrides (extension vanished — the layer UI
   * goes with it; a returning extension starts from its defaults).
   *
   * @param {string} extId
   * @returns {void}
   */
  dropExtension(extId) {
    if (!(extId in this.data)) return;
    delete this.data[extId];
    this.save();
  }
}

/**
 * localStorage key for an extension's state scope. Extension scope is
 * shared across contexts; instance scope is keyed by the placement's
 * stable instance id.
 *
 * @param {string} extId
 * @param {string|null|undefined} instanceId - null → extension scope
 * @param {string} [prefix]
 * @returns {string}
 */
export function stateKey(extId, instanceId, prefix = "dr.plotterext") {
  return instanceId
    ? `${prefix}.state.${extId}.${instanceId}`
    : `${prefix}.state.${extId}`;
}

/**
 * Reads/writes a state scope as one JSON object. Storage is injected
 * so Node tests can pass a fake.
 */
export class StateStore {
  /**
   * @param {{getItem: (k: string) => string|null,
   *           setItem: (k: string, v: string) => void}} storage
   */
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @returns {object}
   */
  readAll(extId, instanceId) {
    try {
      const raw = this.storage.getItem(stateKey(extId, instanceId));
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @param {object} values merged over the current scope
   * @returns {string[]} keys written
   */
  write(extId, instanceId, values) {
    const all = this.readAll(extId, instanceId);
    const keys = [];
    for (const [k, v] of Object.entries(values ?? {})) {
      if (typeof k !== "string" || k === "") continue;
      all[k] = v;
      keys.push(k);
    }
    this.storage.setItem(stateKey(extId, instanceId), JSON.stringify(all));
    return keys;
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @param {string[]|undefined} keys
   * @returns {object}
   */
  get(extId, instanceId, keys) {
    const all = this.readAll(extId, instanceId);
    if (!keys) return all;
    const out = {};
    for (const k of keys) {
      if (k in all) out[k] = all[k];
    }
    return out;
  }
}

/**
 * Registry of Signal K literal path subscriptions per extension
 * context: subscription ids → (context, paths). The host keeps one
 * upstream stream (which does its own per-path refcounting); this
 * registry decides who a delta belongs to (routing) and what a
 * context held when it goes away (teardown).
 */
export class PathRefRegistry {
  constructor() {
    /** @type {Map<string, {ctx: object, paths: string[]}>} subId → sub */
    this.subs = new Map();
    this.seq = 0;
  }

  /**
   * Registers a subscription for a context.
   *
   * @param {object} ctx - opaque context handle (the HostConnection)
   * @param {string[]} paths
   * @returns {string} subscriptionId
   */
  subscribe(ctx, paths) {
    const subId = `sks-${++this.seq}`;
    this.subs.set(subId, { ctx, paths: [...paths] });
    return subId;
  }

  /**
   * Drops a subscription, returning its paths (for the caller to
   * decrement elsewhere) or null when unknown.
   *
   * @param {string} subId
   * @returns {string[]|null}
   */
  unsubscribe(subId) {
    const sub = this.subs.get(subId);
    if (!sub) return null;
    this.subs.delete(subId);
    return sub.paths;
  }

  /**
   * Drops every subscription belonging to a context (context teardown).
   *
   * @param {object} ctx
   * @returns {string[]} all paths that were held
   */
  dropContext(ctx) {
    const held = [];
    for (const [subId, sub] of [...this.subs]) {
      if (sub.ctx === ctx) {
        this.subs.delete(subId);
        held.push(...sub.paths);
      }
    }
    return held;
  }

  /** Paths currently held (union of live subscriptions). */
  activePaths() {
    const all = new Set();
    for (const sub of this.subs.values()) {
      for (const p of sub.paths) all.add(p);
    }
    return [...all];
  }

  /**
   * Live contexts currently holding a path (delta routing: publish
   * `sk.<path>` to exactly these).
   *
   * @param {string} path
   * @returns {Set<object>}
   */
  contextsForPath(path) {
    const out = new Set();
    for (const sub of this.subs.values()) {
      if (sub.paths.includes(path)) out.add(sub.ctx);
    }
    return out;
  }
}

/**
 * Extracts own-vessel value updates from a stream delta frame as
 * `sk.<path>` event payloads. Only `updates[].values` count — meta
 * frames (`updates[].meta`, sent because the app socket uses
 * `sendMeta=all`) are path *metadata*, not path values, and other
 * vessels' deltas (AIS) are not part of the v1 relay.
 *
 * @param {object} delta - stream frame with `context`/`updates`
 * @param {string|null} selfContext - the Hello frame's self context
 * @returns {Array<{path: string, value: unknown, timestamp: string|null,
 *   $source: string|null}>}
 */
export function selfDeltaValues(delta, selfContext) {
  const ctx = delta?.context;
  if (ctx !== "vessels.self" && ctx !== selfContext) return [];
  const out = [];
  for (const update of delta?.updates ?? []) {
    for (const v of update?.values ?? []) {
      if (typeof v?.path !== "string" || v.path === "") continue;
      out.push({
        path: v.path,
        value: v.value,
        timestamp: update.timestamp ?? null,
        $source: update.$source ?? update.source?.label ?? null,
      });
    }
  }
  return out;
}

/**
 * Instance-id generator. `crypto.randomUUID` needs a secure context —
 * plain http on the boat LAN is not one — so fall back to a v4-shaped
 * id from `crypto.getRandomValues` (available everywhere).
 *
 * @returns {string}
 */
export function newInstanceId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- map overlays: geometry and frame cycle ----------------------------

/** Web Mercator world width, in metres (equator = one world copy). */
export const WEB_MERCATOR_SIZE = 40075016.68557849;
/** Mercator Y limit (±85.0511° — where the projection diverges). */
const MERCATOR_LAT_MAX = 85.0511287798066;

/**
 * Longitude (degrees) to EPSG:3857 X (metres). Values outside
 * [-180, 180] map onto neighbouring world copies, as on a wrapping
 * map.
 *
 * @param {number} lng
 * @returns {number}
 */
export function lngToX(lng) {
  return (lng / 360 + 0.5) * WEB_MERCATOR_SIZE;
}

/**
 * Latitude (degrees) to EPSG:3857 Y (metres), clamped to the
 * projection's range.
 *
 * @param {number} lat
 * @returns {number}
 */
export function latToY(lat) {
  const clamped = Math.max(-MERCATOR_LAT_MAX, Math.min(MERCATOR_LAT_MAX, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WEB_MERCATOR_SIZE
  );
}

/**
 * EPSG:3857 X (metres) to longitude (degrees), normalized to
 * [-180, 180).
 *
 * @param {number} x
 * @returns {number}
 */
export function xToLng(x) {
  return normalizeLng((x / WEB_MERCATOR_SIZE - 0.5) * 360);
}

/**
 * EPSG:3857 Y (metres) to latitude (degrees).
 *
 * @param {number} y
 * @returns {number}
 */
export function yToLat(y) {
  const n = Math.PI - (2 * Math.PI * y) / WEB_MERCATOR_SIZE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Normalizes a longitude to [-180, 180).
 *
 * @param {number} lng
 * @returns {number}
 */
export function normalizeLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Ground resolution at a latitude, in metres per screen (CSS) pixel
 * at the given zoom — the 256 px-tile convention Leaflet uses.
 *
 * @param {number} lat
 * @param {number} zoom
 * @returns {number}
 */
export function metersPerPixel(lat, zoom) {
  return (
    (WEB_MERCATOR_SIZE * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom)
  );
}

/**
 * The lon/lat `[west, south, east, north]` form of a mercator extent.
 * A box crossing the antimeridian comes out in the API's form
 * (west > east); longitudes are in [-180, 180].
 *
 * @param {[number, number, number, number]} extent - EPSG:3857 metres
 * @returns {[number, number, number, number]}
 */
export function boundsForExtent(extent) {
  const spanDeg = ((extent[2] - extent[0]) / WEB_MERCATOR_SIZE) * 360;
  if (spanDeg >= 360) {
    return [-180, yToLat(extent[1]), 180, yToLat(extent[3])];
  }
  const west = normalizeLng(xToLngRaw(extent[0]));
  let east = west + spanDeg;
  if (east > 180) east -= 360; // crossed the antimeridian
  if (east > 180) east = 180; // degenerate near-world-spanning box
  return [west, yToLat(extent[1]), east, yToLat(extent[3])];
}

/**
 * Raw X→longitude, NOT wrapped (for boundsForExtent's span math).
 *
 * @param {number} x
 * @returns {number}
 */
function xToLngRaw(x) {
  return (x / WEB_MERCATOR_SIZE - 0.5) * 360;
}

/**
 * Builds an `overlay.request` payload from the map view. The image
 * covers the viewport's mercator box, pixels spaced evenly in
 * mercator, north up (this host's chart does not rotate).
 *
 * The extent is the viewport at `resolution` per IMAGE pixel, where
 * image pixels are CSS pixels times `pixelRatio`; the returned bounds
 * are the same box as lon/lat.
 *
 * @param {{centerLng: number, centerLat: number, zoom: number,
 *   width: number, height: number}} view - viewport in CSS pixels
 * @param {{overlayId: string, requestId: string, pixelRatio: number,
 *   liveInterval?: number}} opts
 * @returns {object} an OverlayRequestEvent payload
 */
export function buildFrameRequest(view, opts) {
  const mpp = metersPerPixel(view.centerLat, view.zoom);
  const cx = lngToX(view.centerLng);
  const cy = latToY(view.centerLat);
  const halfW = (view.width * mpp) / 2;
  const halfH = (view.height * mpp) / 2;
  const extent = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
  const req = {
    overlayId: opts.overlayId,
    requestId: opts.requestId,
    extent,
    bounds: boundsForExtent(extent),
    width: Math.round(view.width * opts.pixelRatio),
    height: Math.round(view.height * opts.pixelRatio),
    pixelRatio: opts.pixelRatio,
    resolution: mpp / opts.pixelRatio,
    zoom: view.zoom,
    rotation: 0,
  };
  if (opts.liveInterval !== undefined) req.liveInterval = opts.liveInterval;
  return req;
}

/**
 * Decides whether an incoming `overlay.frame` is drawn. A frame
 * answering a request is accepted only while that request is still
 * the newest (otherwise `overlays.superseded`); a live frame (no
 * `requestId`) is paced against the host's `liveInterval`
 * (`overlays.throttled`). Mutates the gate — it is per-overlay state.
 *
 * @param {{lastRequestId: string|null, lastLiveAt: number,
 *   liveInterval: number}} gate
 * @param {{requestId?: string}} params - overlay.frame params
 * @param {number} now - ms timestamp
 * @returns {{accepted: boolean, reason?: string}}
 */
export function acceptFrame(gate, params, now) {
  if (params.requestId === undefined || params.requestId === null) {
    if (now - gate.lastLiveAt < gate.liveInterval) {
      return { accepted: false, reason: "overlays.throttled" };
    }
    gate.lastLiveAt = now;
    return { accepted: true };
  }
  if (params.requestId !== gate.lastRequestId) {
    return { accepted: false, reason: "overlays.superseded" };
  }
  // A requested frame is fresh content too: an immediately following
  // live frame adds nothing the viewer has not just been shown.
  gate.lastLiveAt = now;
  return { accepted: true };
}

/**
 * Where a frame's image lands on the current viewport, in CSS pixels:
 * the image covers `extent` (its own georeferencing), the view has
 * moved on since — the placement maps the extent into the view now.
 *
 * @param {{extent: [number, number, number, number]}} frame
 * @param {{centerLng: number, centerLat: number, zoom: number,
 *   width: number, height: number}} view - current viewport, CSS px
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function framePlacement(frame, view) {
  const mpp = metersPerPixel(view.centerLat, view.zoom);
  const cx = lngToX(view.centerLng);
  const cy = latToY(view.centerLat);
  const viewMinX = cx - (view.width * mpp) / 2;
  const viewMaxY = cy + (view.height * mpp) / 2;
  const [minX, minY, maxX, maxY] = frame.extent;
  return {
    x: (minX - viewMinX) / mpp,
    y: (viewMaxY - maxY) / mpp,
    width: (maxX - minX) / mpp,
    height: (maxY - minY) / mpp,
  };
}
