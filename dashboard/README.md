# Operations dashboard

Two pages for management, both reading AF through PI Web API: the **map** of all 8 sites
(`topo.html`, also what `index.html` opens) and the **plant view** of each site (`plant.html`).
Detailed trends and tables live in PI Vision; both pages link to it.

Status: **Alert** if a refinery unit is upset or shut down, or 30% or more of the wells are tripped.
**Watch** if any well is tripped, the CDU runs below 60% of capacity, or an acute event is active
(vacuum loss, compressor trip, cooling tower degraded, power outage). Heater fouling is shown in
the refinery tooltip but doesn't change the status.

## Map (`topo.html`)


A contour map (real terrain) with oil production drawn on it as contour bands, computed live in the
browser from the current PI values, relative to the busiest site (company view) or the busiest well
(site view). It uses the same frame as the plant view and the **Signal** design system:

- **Top bar:** the title with one line saying how the company or the site is doing (oil, wells
  producing, how many sites need attention and why), **View the plant** (site view), **Open in PI
  Vision** and the site selector.
- **Left pane** (collapses to a rail, a drawer on phones): the sites, or the site's wells, ranked by oil
  production as labelled bars, with problems in words; the legend; where the numbers come from.
- **Colours:** production on Signal's blue sequential scale; problems in orange with a word (Watch,
  Alert, Tripped), never green vs red; the site or well you point at turns highlight blue on the map
  and in the list at the same time.
- Click a site to open its wells; **All sites** in the top bar or `Esc` goes back.

The terrain images are pre-rendered and committed (`img/topo/`, ~4.7 MB). To regenerate them, e.g.
after moving a site or adding one, run `python dashboard/build_relief.py` (needs numpy, Pillow and
internet; elevation from the AWS Terrain Tiles open dataset). The browser needs no internet for
the map itself; only the IBM Plex fonts come from Google Fonts, with a system-font fallback.

## Plant view (`plant.html`)

A flat isometric drawing of one site (SVG, industrial style), generated from the AF hierarchy: every
**Area** is a concrete slab, every **unit / work center** a pad on it, and every **equipment element**
a drawing chosen by its AF template (tank, column, fired heater, pump, separator, desalter, reactor,
compressor, ejector, boiler, cooling tower, pipeline, and one per well lift type). Areas sit in two
rows like a conveyor: the first row runs in AF order (the flow order), the second runs back, each row
with its pipe rack behind it and a cross rack joining them.

- **Top bar:** the site title with one line saying how it is doing (crude unit throughput, wells
  producing, how many items need attention), or the AF path of the selected element; **Map** (back to
  the map at this site), **Open in PI Vision** and the site selector.
- **Left pane:** the **AF hierarchy** and the legend. It collapses to a thin rail; on phones it is a
  drawer behind ☰. Items that need attention show their status in words.
- **Product flow:** pipes run from each well through the separator, pipeline, crude tanks, CDU/VDU and
  hydrotreater to the product tanks, plus the utilities (steam, cooling water, recycle gas). Arrowheads
  along each line show the flow direction; a grey line without arrows has no flow. Select an element
  and only its own pipes keep full colour. Hover a pipe for its product and current flow.
- **Drawing conventions** (isometric plant illustration): a heavier outline round each object and
  lighter inner edges; tanks on ring foundations, pumps and compressors on concrete plinths;
  platforms and ladders on the columns and reactor, a stair on each tank; flanged nozzles where pipes
  meet equipment, sleepers under the flowlines, pipe racks built from bents with cross beams under
  the pipes and longitudinal beams along the rack.
- **Live state:** equipment status (well status, unit status or run status) colours a band on each
  model: grey when normal, light orange when reduced or starting, orange when tripped or upset, pale
  grey when stopped. Tank fills follow *Level*, heater fireboxes glow when fuel gas is flowing.
- **Navigation:** drag to pan, scroll or pinch to zoom, arrow keys and `+`/`-`. Click any element in the
  drawing or the tree to zoom to it and see its PI values and configuration (hover a value for its PI timestamp). `Esc` goes up one
  level (and back to the whole site at the top); double-click empty ground for the whole site. Links
  like `plant.html#BAR/BAR-C-101` open a site with an element selected.
- **Look:** colours, type and spacing follow the **Signal** design system: one highlight colour (blue)
  for the selection, problems in orange with a word (never green vs red), a categorical palette of at
  most six groups for the pipes, IBM Plex Sans with tabular figures, and a source line under the data.
- **Data:** the element tree and PI attributes come from `data/plant.js` (generated from the AF model),
  values from PI Web API (all PI Point attributes of the site, refreshed every 60 s) or the demo snapshot.
- **Motion:** product streaks flow along the pipes towards their outlet at a speed that follows the PI
  flow (none when there is no flow), rod pumps nod at their strokes per minute, cooling tower fans turn
  and vapour rises while running, and the firebox glows. **Motion** in the top bar stops it (remembered
  per browser); it also stops while the tab is hidden.
- **CPU:** no WebGL, so it runs on a server VM without a graphics card. The motion is stepped about 15
  times a second instead of every frame; with it off, the page only repaints when you pan, zoom, hover
  or new values arrive, and while you drag it moves the drawing already on screen.
- Open it from the Topo site view (**View the plant**). It uses ES modules, so serve the folder over
  HTTP (IIS or `python -m http.server`); opening the file directly from disk won't work.

Set `piVision.elementDisplay` in `config.js` to an asset-relative PI Vision display to make
**Open in PI Vision** open the selected element; otherwise it uses `siteDisplay` or the home page.

## PI Vision links

**Open in PI Vision** goes to `piVision.home` in `config.js`. To open an asset-relative display for the
site being viewed, build that display in PI Vision and paste its URL into `piVision.siteDisplay`
(and `overviewDisplay` for the company view), with `{asset}` where the AF path goes.

## Files

```
index.html             opens the map
topo.html, topo.js     map of all sites (landing page)
build_relief.py        renders img/topo/*.jpg and data/relief.js (terrain base maps)
plant.html, plant.js   plant view of one site, built from the AF hierarchy (SVG)
plant-core.js          plant view: layout from AF, process flows, PI values, side panels
common.js              shared data loading, status rules and tooltip content
source.js              data layer: PI Web API, or the bundled demo data
config.js              PI Web API URL, AF server, data source, refresh interval, PI Vision links
data/model.js          sites, wells, AF element paths (generated)
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
Open `http://localhost:8080`. With `source: "auto"` in `config.js`, it shows demo data if PI Web API
can't be reached, and the left pane says why in red under the data source ("Why not live: …").

**Permanent:** copy the `dashboard` folder to IIS on `PISERVER` (e.g.
`C:\inetpub\wwwroot\cordillera`) and open `http://PISERVER/cordillera/`.

## PI Web API settings (one time)

The pages read PI Web API **from the viewer's browser, with that person's Windows login**. No password
is stored anywhere in the dashboard (the `PIWEBAPI_PASSWORD` variable is only for the simulator).
The browser calls PI Web API from another origin, so PI Web API must allow it (CORS).
In PI System Explorer, open the configuration database
`Configuration › OSIsoft › PI Web API › PISERVER › System Configuration` and set:

| Attribute | Value |
|---|---|
| CorsOrigins | `http://PISERVER,http://localhost:8080`: the exact address the map is opened from, scheme + host + port, **no trailing slash** (`http://host:8080/` never matches) |
| CorsSupportsCredentials | `True` |
| CorsMethods | `GET` |
| AuthenticationMethods | `Kerberos` (Windows login, no prompt) and/or `Basic` (browser asks for a user) |

Restart the PI Web API service afterwards (it reads these settings at start-up). If the browser
console says *"blocked by CORS policy: No 'Access-Control-Allow-Origin' header"*, compare `CorsOrigins`
character by character with the page's address bar. A read-only account is enough. If the browser shows the
PI Web API certificate as untrusted, open the PI Web API URL once and accept it, or install the
certificate. Otherwise the map can't connect.

For the Windows login to be sent without a prompt (Kerberos), the PI Web API address must be in the
browser's **Local intranet** zone: Internet Options › Security › Local intranet › Sites › Advanced, add
`https://PISERVER` (Edge and Chrome use the same setting; a domain admin can push it by group policy).
