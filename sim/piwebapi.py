"""Minimal PI Web API client: find points and write recorded values."""
import concurrent.futures as cf
import os

import requests

CSRF = {"X-Requested-With": "XMLHttpRequest"}


class PIWebAPIError(RuntimeError):
    def __init__(self, msg, status=None):
        super().__init__(msg)
        self.status = status


def explain(e, api):
    """Readable cause and fix for the errors people hit when first connecting."""
    head = f"Could not talk to PI Web API at {api.base} (data server {api.server}).\n"
    if "YOUR-" in api.base:
        return head + "sim/config.toml still has the example url. Set it to your server, e.g. https://PISERVER/piwebapi"
    if isinstance(e, requests.exceptions.SSLError):
        return head + ("The server's HTTPS certificate is not trusted by Python (PI Web API usually has a "
                       "self-signed one).\nFix: in sim/config.toml set ca_bundle to the certificate .pem/.cer, "
                       "or verify_ssl = false for a test.\nDetail: " + str(e)[:300])
    if isinstance(e, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)):
        return head + ("The server did not answer. Check the url in sim/config.toml (it must end in /piwebapi), "
                       "that you can open it in a browser on this machine, and the firewall (port 443).\n"
                       "Detail: " + str(e)[:300])
    if isinstance(e, ImportError):
        return head + (f"A Python package for the chosen auth is missing ({e.name}). For auth = \"kerberos\" "
                       "on Windows run: pip install requests-negotiate-sspi")
    if isinstance(e, PIWebAPIError) and e.status == 401:
        return head + ("PI Web API refused the login (401). With auth = \"kerberos\" on Windows install "
                       "requests-negotiate-sspi and run as a user PI Web API accepts; or set auth = \"basic\" "
                       "with username and the password in the PIWEBAPI_PASSWORD environment variable.")
    if isinstance(e, PIWebAPIError) and e.status in (400, 404) and "dataservers" in str(e):
        names = []
        try:
            names = [d["Name"] for d in api._get("dataservers", selectedFields="Items.Name").get("Items", [])]
        except Exception:
            pass
        return head + (f"No PI Data Archive called '{api.server}'. Set data_server in sim/config.toml to one of: "
                       f"{', '.join(names) or '(could not list them)'}\nDetail: {e}")
    return head + f"{type(e).__name__}: {e}"


def make_auth(cfg):
    kind = cfg.get("auth", "kerberos").lower()
    if kind == "basic":
        pwd = os.environ.get(cfg.get("password_env", "PIWEBAPI_PASSWORD"), "")
        return (cfg["username"], pwd)
    if kind == "ntlm":
        from requests_ntlm import HttpNtlmAuth
        pwd = os.environ.get(cfg.get("password_env", "PIWEBAPI_PASSWORD"), "")
        return HttpNtlmAuth(cfg["username"], pwd)
    if kind == "kerberos":
        try:  # Windows: uses the logged-on user, no password needed
            from requests_negotiate_sspi import HttpNegotiateAuth
            return HttpNegotiateAuth()
        except ImportError:
            from requests_kerberos import HTTPKerberosAuth, OPTIONAL
            return HTTPKerberosAuth(mutual_authentication=OPTIONAL)
    if kind == "anonymous":
        return None
    raise ValueError(f"unknown auth '{kind}'")


class PIWebAPI:
    def __init__(self, cfg):
        self.base = cfg["url"].rstrip("/")
        self.server = cfg["data_server"]
        self.timeout = cfg.get("timeout", 120)
        self.workers = cfg.get("workers", 4)
        self.s = requests.Session()
        self.s.auth = make_auth(cfg)
        self.s.headers.update({"Accept": "application/json", **CSRF})
        verify = cfg.get("verify_ssl", True)
        self.s.verify = cfg.get("ca_bundle") or verify
        if not verify:
            import urllib3
            urllib3.disable_warnings()
        self._server_id = None

    def _get(self, endpoint, **params):
        r = self.s.get(f"{self.base}/{endpoint}", params=params, timeout=self.timeout)
        if r.status_code >= 400:
            raise PIWebAPIError(f"GET {endpoint} -> {r.status_code}: {r.text[:400]}", r.status_code)
        return r.json()

    def server_id(self):
        if not self._server_id:
            self._server_id = self._get("dataservers", path=f"\\\\{self.server}")["WebId"]
        return self._server_id

    def find_points(self, name_filter="CP.*"):
        """{tag: webId} for existing points matching the filter."""
        found, start = {}, 0
        while True:
            page = self._get(f"dataservers/{self.server_id()}/points", nameFilter=name_filter,
                             startIndex=start, maxCount=1000, selectedFields="Items.Name;Items.WebId")
            items = page.get("Items", [])
            found.update({i["Name"]: i["WebId"] for i in items})
            if len(items) < 1000:
                return found
            start += 1000

    def write(self, streams, update_option="Replace"):
        """streams: {webId: [(iso_ts, value), ...]}. Splits into requests of ~50k values."""
        chunks, cur, n = [], [], 0
        for wid, items in streams.items():
            cur.append({"WebId": wid, "Items": [{"Timestamp": ts, "Value": v} for ts, v in items]})
            n += len(items)
            if n >= 50000:
                chunks.append(cur)
                cur, n = [], 0
        if cur:
            chunks.append(cur)

        def post(body):
            r = self.s.post(f"{self.base}/streamsets/recorded", json=body, timeout=self.timeout,
                            params={"updateOption": update_option, "bufferOption": "BufferIfPossible"})
            if r.status_code >= 400:
                raise PIWebAPIError(f"POST streamsets/recorded -> {r.status_code}: {r.text[:400]}", r.status_code)
            if r.status_code == 207:
                errs = [i for i in r.json().get("Items", []) if i.get("Status", 202) >= 400]
                if errs:
                    raise PIWebAPIError(f"{len(errs)} streams rejected, first: {str(errs[0])[:300]}")

        with cf.ThreadPoolExecutor(self.workers) as ex:
            for f in cf.as_completed([ex.submit(post, c) for c in chunks]):
                f.result()
