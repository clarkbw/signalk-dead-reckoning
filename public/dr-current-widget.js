/**
 * `<dr-current-widget>` — the current set & drift widget (work doc #38
 * review): a 1×1 glanceable showing the resolved §6.2 current whatever
 * source won — the source named, the vector in kn/degrees. A short tap
 * asks the host to open the Current set & drift window, where the
 * manual override is set.
 *
 * Polls GET /status: the resolved vector's tier/source enrichment rides
 * REST (the standard SK current paths carry only the SI vector). Clicks
 * are the tap gesture the widget itself detects (pointer events inside
 * the sandboxed iframe are invisible to the host).
 *
 * @file dr-current-widget.js
 */

import { currentWidgetModel } from "./dr-ext-model.js";
import { THEME_CSS } from "./dr-theme.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** Signal K plugin REST mount (kept in sync with dr-app.js). */
const API = "/plugins/signalk-dead-reckoning";

const POLL_MS = 5000;

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 6px 8px;
      background: var(--bg-panel, #111414);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: ui-monospace, "Fira Code", monospace;
      color: var(--text-main, #ffffff);
      cursor: pointer;
      user-select: none;
      --tile-accent: var(--color-teal, #4b8b99);
    }
    :host(.manual) { --tile-accent: var(--color-orange, #c77b28); }
    :host(.none) { --tile-accent: var(--color-grey, #666677); }
    :host(.night) {
      --color-teal: #c97b4f;
      --color-orange: #d99a4e;
      --color-grey: #6a4a3f;
      --text-main: #e8c9a0;
      --bg-panel: rgba(22, 11, 6, 0.88);
    }
    .figure {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      height: 100%;
      justify-content: center;
    }
    .figure .label {
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--tile-accent);
    }
    .figure .value {
      font-size: clamp(0.95rem, 2vw, 1.4rem);
      font-weight: 700;
      line-height: 1.05;
      color: var(--text-main, #ffffff);
      font-variant-numeric: tabular-nums;
    }
    .figure .source {
      font-size: 0.65rem;
      color: var(--text-muted, #888899);
    }
  </style>
  <div class="figure">
    <span class="label">Current</span>
    <span class="value">—</span>
    <span class="source">none</span>
  </div>
`;

class DrCurrentWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));
    /** @type {string|null} last rendered source, for the accent class */
    this.source = null;
  }

  connectedCallback() {
    this.start();
  }

  async start() {
    try {
      this.client = await connectExtension();
    } catch {
      return; // not embedded in a plotter host — nothing to do
    }
    if (this.client.hasCapability("nightMode")) {
      this.client
        .subscribe(["nightMode.changed"], (_n, p) => {
          this.classList.toggle("night", p?.enabled === true);
        })
        .catch(() => {});
      this.client.nightMode
        .get()
        .then(({ enabled }) => this.classList.toggle("night", enabled === true))
        .catch(() => {});
    }
    // A short tap (not the long-press that opens the config dialog) —
    // the gesture the widget detects itself, like the status tile's.
    this.addEventListener("click", () => {
      if (!this.client) return;
      this.client
        .call("ui.openWindow", {
          panel: "current",
          single: true,
          restoreKey: "current",
          geometry: { anchor: "bottom-left", width: 380, height: "50%" },
        })
        .catch(() => {});
    });
    await this.refresh();
    setInterval(() => this.refresh(), POLL_MS);
  }

  /** Reads GET /status (the current's tier/source enrichment rides
   * REST) and renders source + vector. */
  async refresh() {
    try {
      const res = await fetch(`${API}/status`);
      if (!res.ok) return;
      const body = await res.json();
      const model = currentWidgetModel(body.current ?? null);
      const root = this.shadowRoot;
      root.querySelector(".value").textContent = model.vector;
      root.querySelector(".source").textContent = model.sourceLabel;
      this.classList.toggle("manual", model.accent === "orange");
      this.classList.toggle("none", model.accent === "muted");
      this.source = model.sourceLabel;
    } catch {
      // REST unavailable — keep the last reading
    }
  }
}

customElements.define("dr-current-widget", DrCurrentWidget);
