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
  // Animation (the map's zoom into a site, the plant's flows and equipment):
  // "on": always; "auto": off when the system asks for reduced motion (Windows Server does by default,
  // because "Show animations in Windows" is off there); "off": never
  motion: "on",
  piVision: {
    // Where "Open in PI Vision" goes. {asset} is replaced with the AF path of the site (or the company).
    // Build an asset-relative display in PI Vision and paste its URL here, e.g.
    // "https://PISERVER/PIVision/#/Displays/42/Site-Overview?asset={asset}"
    home: "https://PISERVER/PIVision/",
    siteDisplay: "",
    overviewDisplay: "",
    // used by the plant view for the selected element (falls back to siteDisplay)
    elementDisplay: "",
  },
};
