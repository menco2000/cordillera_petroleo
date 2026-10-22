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
};
