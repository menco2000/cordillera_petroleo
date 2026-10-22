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

## Map imagery

Satellite imagery comes from Esri World Imagery with Esri's place-name overlay, loaded by the
viewer's browser, so **that browser needs internet access**. If the imagery can't load, the map
switches to offline country outlines (Natural Earth, bundled) and says so. You can change the tile
URLs in `config.js` (e.g. an internal tile server).

Check Esri's terms of use for your use case: the World Imagery service is free to view with attribution,
but some uses need an ArcGIS account.

## Files

```
index.html, app.js     the page (Leaflet 1.9.4 bundled in vendor/leaflet, BSD-2 license)
source.js              data layer: PI Web API, or the bundled demo data
config.js              PI Web API URL, AF server, data source, refresh interval, tile URLs
data/model.js          sites, wells, AF element paths (generated)
data/map.js            offline country outlines (generated)
data/demo.js           simulator snapshot for demos without PI (generated)
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
