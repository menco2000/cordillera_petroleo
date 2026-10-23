// Dashboard settings. Edit and reload the page.
window.CP_CONFIG = {
  // "auto": read PI Web API, fall back to the bundled demo data if it can't be reached
  // "piwebapi": PI Web API only (show the error instead of demo data)
  // "demo": bundled simulator data only
  source: "auto",
  piwebapi: {
    url: "https://PISERVER/piwebapi",
    afServer: "PISERVER",
    timeoutSeconds: 15,
  },
  refreshSeconds: 60,
  piVision: {
    // Where "Open in PI Vision" goes. {asset} is replaced with the AF path of the site (or the company).
    // Build an asset-relative display in PI Vision and paste its URL here, e.g.
    // "https://PISERVER/PIVision/#/Displays/42/Site-Overview?asset={asset}"
    home: "https://PISERVER/PIVision/",
    siteDisplay: "",
    overviewDisplay: "",
    // used by the 3D plant for the selected element (falls back to siteDisplay)
    elementDisplay: "",
  },
  map: {
    // Satellite imagery and place-name overlay (needs internet from the viewer's browser).
    // If the imagery can't load, the map falls back to offline country outlines.
    imagery: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    labels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};
