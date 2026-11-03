# Operations map

A full-screen satellite map of all 8 sites for management. There are no tables or charts;
detailed trends and tables live in PI Vision. Everything else appears in hover tooltips.

- **Company view:** one marker per site, sized by oil production and colored by status.
  Hover for oil production, refinery throughput and utilization, wells producing, water cut
  and the reason a site needs attention. Click to zoom into the site.
- **Site view:** every well at its real coordinates, colored by status, with dashed flow lines to the
  refinery. Hover a well for oil rate, water cut, oil today, design rate, lift method and active event.
  Hover the refinery for throughput, utilization, crude stock and the status of its 6 units.
  **← All sites** or `Esc` goes back. Links like `index.html#BAR` open a site directly.

Status: **Alert** if a refinery unit is upset or shut down, or 30% or more of the wells are tripped.
**Watch** if any well is tripped, the CDU runs below 60% of capacity, or an acute event is active
(vacuum loss, compressor trip, cooling tower degraded, power outage). Heater fouling is shown in
the refinery tooltip but doesn't change the status.

## Designs

Several looks over the same data and status rules. The landing pages (`topo.html`, `map3d.html`,
`hex.html`) show as little as possible: a headline number, one chip per site and an
**Open in PI Vision** button. Switch between them with the bar in the footer.
A link like `topo.html#BAR` opens a site directly in any design.

### Topo (`topo.html`, recommended landing page)

A paper-style contour map (real terrain) with oil production drawn on it as 6 colored contour
bands. The bands are computed live in the browser from the current PI values, relative to the
busiest site (company view) or the busiest well (site view). Sites with a watch or alert show a
small flag on their chip. Click a site to open its wellfield: dark dots are producing wells,
hollow dots are stopped, red is tripped, the square is the refinery.

The terrain images are pre-rendered and committed (`img/topo/`, ~4.7 MB). To regenerate them, e.g.
after moving a site or adding one, run `python dashboard/build_relief.py` (needs numpy, Pillow and
internet; elevation from the AWS Terrain Tiles open dataset). The browser needs no internet for
the map itself; only the IBM Plex fonts come from Google Fonts, with a system-font fallback.

| Page | Look | Needs internet |
|---|---|---|
| `topo.html` | **Topo**: contour map, production as live heat contours, chips with leader lines | no |
| `map3d.html` | **3D**: calm tilted relief, one thin bar per site | no |
| `index.html` | **Satellite**: real imagery, clean markers, hover tooltips only | imagery only (falls back to outlines) |
| `holo.html` | **Holo 3D**: tilted, extruded neon continent; glowing columns per site with the site's wells as a small skyline; tabs switch column height between oil, refinery throughput and wells producing; HUD detail windows; tilt/north dial | no |
| `hex.html` | **Hex grid**: continent drawn as hexagons that light up around each site (color = status, reach = production); callout chips; statistics column and big headline numbers; animated arcs from wells to the refinery | no |
| `night.html` | **Night ops**: satellite imagery darkened to a night-vision tint; pulsing beacons; HUD panels; live cursor coordinates | imagery only (falls back to outlines) |

All designs share `common.js` (data loading, status rules, tooltip content), so the numbers are the same everywhere.

## Plant view (`plant.html`)

A flat isometric drawing of one site (SVG, industrial style), generated from the AF hierarchy: every
**Area** is a concrete slab, every **unit / work center** a pad on it, and every **equipment element**
a drawing chosen by its AF template (tank, column, fired heater, pump, separator, desalter, reactor,
compressor, ejector, boiler, cooling tower, pipeline, and one per well lift type). Areas sit in two
rows like a conveyor: the first row runs in AF order (the flow order), the second runs back, each row
with its pipe rack behind it and a cross rack joining them.

- **Top bar:** the site title with one line saying how it is doing (crude unit throughput, wells
  producing, how many items need attention), or the AF path of the selected element; **Animate
  flows**, **Open in PI Vision** and the site selector.
- **Left pane:** the **AF hierarchy** and the legend. It collapses to a thin rail; on phones it is a
  drawer behind ☰. Items that need attention show their status in words.
- **Product flow:** pipes run from each well through the separator, pipeline, crude tanks, CDU/VDU and
  hydrotreater to the product tanks, plus the utilities (steam, cooling water, recycle gas). Select an
  element and only its own pipes keep full colour. Hover a pipe for its product and current flow;
  **Animate flows** shows the flow direction (off by default, it costs about half a CPU core on a
  machine without a GPU). A grey pipe has no flow.
- **Live state:** equipment status (well status, unit status or run status) colours a band on each
  model: grey when normal, light orange when reduced or starting, orange when tripped or upset, pale
  grey when stopped. Tank fills follow *Level*, heater fireboxes glow when fuel gas is flowing.
- **Navigation:** drag to pan, scroll or pinch to zoom, arrow keys and `+`/`-`. Click any element in the
  drawing or the tree to zoom to it and see its PI values, configuration and AF path. `Esc` goes up one
  level (and back to the whole site at the top); double-click empty ground for the whole site. Links
  like `plant.html#BAR/BAR-C-101` open a site with an element selected.
- **Look:** colours, type and spacing follow the **Signal** design system: one highlight colour (blue)
  for the selection, problems in orange with a word (never green vs red), a categorical palette of at
  most six groups for the pipes, IBM Plex Sans with tabular figures, and a source line under the data.
- **Data:** the element tree and PI attributes come from `data/plant.js` (generated from the AF model),
  values from PI Web API (all PI Point attributes of the site, refreshed every 60 s) or the demo snapshot.
- **CPU:** no WebGL, so it runs fine on a server VM without a graphics card: it only repaints when you
  pan, zoom, hover or new values arrive, and while you drag it moves the drawing already on screen.
- Open it from the Topo site view (**View the plant**). It uses ES modules, so serve the folder over
  HTTP (IIS or `python -m http.server`); opening the file directly from disk won't work.

Set `piVision.elementDisplay` in `config.js` to an asset-relative PI Vision display to make
**Open in PI Vision** open the selected element; otherwise it uses `siteDisplay` or the home page.

## PI Vision links

**Open in PI Vision** goes to `piVision.home` in `config.js`. To open an asset-relative display for the
site being viewed, build that display in PI Vision and paste its URL into `piVision.siteDisplay`
(and `overviewDisplay` for the company view), with `{asset}` where the AF path goes.

## Map imagery

Satellite imagery comes from Esri World Imagery with Esri's place-name overlay, loaded by the
viewer's browser, so **that browser needs internet access**. If the imagery can't load, the map
switches to offline country outlines (Natural Earth, bundled) and says so. You can change the tile
URLs in `config.js` (e.g. an internal tile server).

Check Esri's terms of use for your use case: the World Imagery service is free to view with attribution,
but some uses need an ArcGIS account.

## Files

```
topo.html, topo.js     Topo design (landing page)
build_relief.py        renders img/topo/*.jpg and data/relief.js (terrain base maps)
map3d.html, map3d.js   3D design
plant.html, plant.js   plant view of one site, built from the AF hierarchy (SVG)
plant-core.js          plant view: layout from AF, process flows, PI values, side panels
index.html, app.js     Satellite design (Leaflet 1.9.4 bundled in vendor/leaflet, BSD-2 license)
holo.html, holo.js     Holo 3D design
hex.html, hex.js       Hex grid design
night.html, night.js   Night ops design
common.js              shared data loading, status rules and tooltip content
source.js              data layer: PI Web API, or the bundled demo data
config.js              PI Web API URL, AF server, data source, refresh interval, tile URLs
data/model.js          sites, wells, AF element paths (generated)
data/map.js            offline country outlines (generated)
data/demo.js           simulator snapshot for demos without PI (generated)
data/relief.js         where each terrain image sits on the map (generated)
data/plant.js          each site's AF element tree and PI attributes, for the plant view (generated)
build_data.py          regenerates data/*.js after changing model/spec.py
```

## Data it reads from AF (PI Web API)

Current values only, through AF attribute paths (not tag names), e.g.
`\\PISERVER\Cordillera Petroleo\Cordillera Petróleo\Barrancabermeja|Refinery Throughput`:
per well *Well Status, Sim Scenario, Oil Rate, Water Rate, Gas Rate, Oil Volume Today*; per site
*Refinery Throughput*, *Wellfield|Producing Wells*, *Crude Tank Farm|Total Inventory*; per refinery unit
its status, *Sim Scenario* and one key value. Paths are resolved once with `attributes/multiple`,
then read with `streamsets/value` every 60 s.

## Run it

**Quick test** on a machine that can reach PI Web API:

```
cd dashboard
python -m http.server 8080
```
Open `http://localhost:8080`. With `source: "auto"` in `config.js`, it shows demo data and a note
if PI Web API can't be reached.

**Permanent:** copy the `dashboard` folder to IIS on `PISERVER` (e.g.
`C:\inetpub\wwwroot\cordillera`) and open `http://PISERVER/cordillera/`.

## PI Web API settings (one time)

The browser calls PI Web API from another origin, so PI Web API must allow it (CORS).
In PI System Explorer, open the configuration database
`Configuration › OSIsoft › PI Web API › PISERVER › System Configuration` and set:

| Attribute | Value |
|---|---|
| CorsOrigins | `http://PISERVER, http://localhost:8080` (the address the map is opened from) |
| CorsSupportsCredentials | `True` |
| CorsMethods | `GET` |
| AuthenticationMethods | `Kerberos` (Windows login, no prompt) and/or `Basic` (browser asks for a user) |

Restart the PI Web API service afterwards. A read-only account is enough. If the browser shows the
PI Web API certificate as untrusted, open the PI Web API URL once and accept it, or install the
certificate. Otherwise the map can't connect.
