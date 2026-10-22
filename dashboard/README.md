# Operations dashboard

Management view of all 8 sites. The map shows each site sized by oil production and colored by
status; clicking a site zooms to its wellfield, refinery units and well table.

| Level | What it shows |
|---|---|
| Company | Oil production vs 30-day average, refinery throughput and utilization, wells producing, water cut, sites needing attention, sites ranked by production, 30-day trend, production stops (7 days) |
| Site | Field oil production, refinery throughput and utilization, wells producing, 7-day well uptime, crude stock in days, status of the 6 refinery units, well table with 7-day sparklines, site trend and stops |

Status rules: **Alert** if a refinery unit is upset or shut down, or 30% or more of the wells are
tripped. **Watch** if any well is tripped, the CDU runs below 60% of capacity, or an acute event is
active (vacuum loss, compressor trip, cooling tower degraded, power outage). Heater fouling is
shown but doesn't change the status.

## Files

```
index.html, app.js     the page
source.js              data layer: PI Web API, or the bundled demo data
config.js              PI Web API URL, AF server, data source, refresh interval
data/model.js          sites, wells, AF element paths (generated)
data/map.js            South America outlines, Natural Earth 1:50m, public domain (generated)
data/demo.js           ~90 days of simulator output for offline demos (generated)
build_data.py          regenerates data/*.js after changing model/spec.py
```

No external libraries and no map tiles, so it works on a plant network without internet.
Fonts come from Google Fonts when reachable, otherwise the system font is used.

## Data it reads from AF (PI Web API)

All values come through AF attribute paths, not tag names, e.g.
`\\PISERVER\Cordillera Petroleo\Cordillera Petróleo\Barrancabermeja|Refinery Throughput`.

- Current values: `attributes/multiple` (resolves paths to WebIds once), then `streamsets/value`
- 30-day trend: `streamsets/summary` daily time-weighted averages of each site's
  *Field Oil Rate* and *Refinery Throughput* (rollup outputs: backfill the analyses first)
- Well sparklines and uptime: `streamsets/summary` and `streamsets/interpolated` (15 min) for the opened site
- Production stops: `assetdatabases/{id}/eventframes?templateName=Extraction Run` for the last 7 days,
  with *Total Oil Produced* and *Stop Reason* from each event frame

Values refresh every 60 s; trend and event frames every 5 min.

## Run it

**Quick test** on any machine that can reach PI Web API:

```
cd dashboard
python -m http.server 8080
```
Open `http://localhost:8080`. With `source: "auto"` in `config.js`, it shows the demo data and a
banner with the reason if PI Web API can't be reached.

**Permanent:** copy the `dashboard` folder to IIS on `PISERVER` (e.g.
`C:\inetpub\wwwroot\cordillera`) and open `http://PISERVER/cordillera/`.

## PI Web API settings (one time)

The browser calls PI Web API from another origin, so PI Web API must allow it (CORS).
In PI System Explorer, open the configuration database
`Configuration › OSIsoft › PI Web API › PISERVER › System Configuration` and set:

| Attribute | Value |
|---|---|
| CorsOrigins | `http://PISERVER, http://localhost:8080` (the address the dashboard is opened from) |
| CorsSupportsCredentials | `True` |
| CorsMethods | `GET` |
| AuthenticationMethods | `Kerberos` (Windows login, no prompt) and/or `Basic` (browser asks for a user) |

Restart the PI Web API service afterwards. The dashboard only reads data, so a read-only account is
enough. If the browser shows the PI Web API certificate as untrusted, open the PI Web API URL once
and accept it, or install the certificate. Otherwise the dashboard can't connect.

`config.js`:
```js
source: "auto",                               // "piwebapi" to hide the demo fallback
piwebapi: { url: "https://PISERVER/piwebapi", afServer: "PISERVER" },
```
