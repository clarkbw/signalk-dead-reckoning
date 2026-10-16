# Signal K Dead Reckoning

An offline-first dead reckoning and sensor fusion engine for Signal K that maintains a continuously computed "shadow boat" position from water-track sensors (speed through water, compass heading, and learned leeway and current corrections), so you always have a navigational fallback when GPS becomes unreliable — whether from jamming, spoofing, or plain receiver failure. While GPS is trusted, the engine learns vessel-specific calibration corrections against ground truth and watches for GPS anomalies; when it isn't, the same learned model keeps the dead-reckoned position, its uncertainty polygon, and a water-track log going. Fixes from celestial sights, compass bearings, radar ranges, and vertical angles are entered through a unified pipeline and can snap dead reckoning back on track, with optional write-through to `signalk-logbook`.

**Note:** This is just a toy. Make your own navigation calculations and decisions.

## Why

Planning for life without GPS is no longer hypothetical: the UK Maritime and Coastguard Agency's Guidance Note 719 ([reported by Yachting Monthly](https://www.yachtingmonthly.com/news/mca-tells-maritime-sector-to-plan-for-life-without-gps-106566), 1 Oct 2025) reports a marked increase in GNSS jamming and spoofing worldwide and asks mariners to review contingency arrangements, maintain resilient navigation practices, and practice navigating without satellite positioning — naming dead reckoning, visual bearings, and celestial fixing as valid methods. This plugin implements exactly that contingency for Signal K vessels: the fallback is always running, and the trusted-GPS period is spent training it.

## Requirements

* This plugin installed and configured
* Some chart source available to Signal K
* Hand bearing compass and/or sextant

## Getting started

1. Install the plugin from the Signal K Appstore (or `npm install @meri-imperiumi/signalk-dead-reckoning`) and enable it. The defaults are sane — you only need to revisit the configuration if you want to change intervals or integrations.
2. Make sure the required data feeds are available on the vessel network:
   * `navigation.position` (GPS) — the training baseline and anomaly reference
   * `navigation.speedThroughWater` (paddlewheel log) and `navigation.headingMagnetic` (compass + variation) — the water-track inputs
   * Wind data — used by the calibration model and the polar speed fallback
3. Just sail. While GPS is reliable and you're under sail (propulsion stopped), the engine continuously learns vessel-specific leeway and speed-loss corrections against GPS ground truth. There is nothing to activate: the "shadow boat" runs at all times, and the uncertainty polygon tightens over a season as the calibration bins fill up. Early on, expect conservative uncertainty estimates.
4. Optional integrations, configured in the plugin settings:
   * `signalk-logbook` — write confirmed fixes and maneuvers to the vessel's logbook
   * `signalk-polar-performance-plugin` — polar-derived speed when the paddlewheel is fouled or silent
   * `@meri-imperiumi/signalk-autostate` — keeps the navigation state (anchored, sailing, motoring) accurate, which gates training
   * Signal K Weather API — point-forecast current vectors for the DR solution

## Daily use

Open the webapp from your Signal K server's *Web apps* menu. It shows the vessel and the shadow boat on the chart, GPS↔DR divergence, the uncertainty polygon, and the water-track log. A status tile is also available for Freeboard-SK ≥ 3.0.

**Entering fixes.** Open *⊕ Sight / LOP* and pick the method:

* **Bearing** — bearing to a known object (lighthouse, tower) gives a line of position; the instrument selector records whether it came from a hand-bearing compass or the radar
* **Vert. Angle** — vertical angle to a known object of known height gives a circular position line
* **Radar** — range to a known object gives a circular position line — the one ranging instrument that does not depend on GNSS. Range + bearing to the same object is the classic two-instrument radar fix. A range to an AIS target rests on the target's own GNSS-derived position, so under suspected interference prefer charted fixed objects
* **Celestial** — sextant sight of the Sun, Moon, or an almanac star

You can right-click an object on the map to pre-fill its coordinates. Sights can be entered with a stopwatch delay ("minutes ago") instead of clock time. Observations accumulate in the pending list; select two or more, *Preview selected* to resolve the candidate fix, then *Confirm fix* to snap dead reckoning to it. A single line of position can also be advanced to a later sight (running fix).

**When GPS looks wrong.** The plugin raises notifications for GPS anomalies, growing DR divergence, and paddlewheel fouling — but it never switches navigational authority by itself. If you decide to trust DR over GPS, press *Engage OVERRIDE*; the shadow boat takes over `navigation.position` instantly (it has been running all along). Release it when position is re-established, e.g. after confirming a fix.

**Other controls.** *≋ Current* sets a manual set-and-drift override with a TTL, which outranks the automatic current sources while it lasts.
