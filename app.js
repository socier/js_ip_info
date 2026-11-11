// Page behaviour: fills in the IP facts, the Google map and the DNS facts.
(function () {
  "use strict";

  // How far the Google map is zoomed in (13 shows a town and its surroundings).
  var MAP_ZOOM = 13;

  // Shown right away, then replaced by the live lookup of the visitor's address.
  var SAMPLE = {
    ip: "113.161.179.21",
    country: "Vietnam",
    country_iso: "VN",
    region_name: "Ho Chi Minh",
    region_code: "SG",
    city: "Ho Chi Minh City",
    latitude: 10.822,
    longitude: 106.6257,
    time_zone: "Asia/Ho_Chi_Minh",
    asn: "AS45899",
    asn_org: "VNPT Corp",
    hostname: "static.vnpt.vn",
    user_agent: splitUserAgent(navigator.userAgent)
  };

  // A free lookup service that answers browsers directly (it allows cross-origin requests).
  var LOOKUP_URL = "https://get.geojs.io/v1/ip/geo";

  // Region codes by country and simplified region name, written by the build.
  var REGIONS_URL = "regions.json";

  // Shown for facts the lookup service doesn't give (a browser can't look up host names).
  var UNKNOWN = "–";

  // DNS over HTTPS (answers browsers directly) for reverse and forward lookups.
  var DOH_URL = "https://dns.google/resolve";

  // Recent lookups are kept in this browser only, newest first.
  var HISTORY_KEY = "jsipinfo.history";
  var HISTORY_SIZE = 10;

  // OpenStreetMap's address search (answers browsers directly), for the address above the map.
  // It answers in the browser's own language.
  var ADDRESS_URL = "https://nominatim.openstreetmap.org/reverse";

  // Each look-up of a fresh name under this domain is answered with the resolver that asked.
  var RESOLVER_DOMAIN = "edns.ip-api.com";

  var data = SAMPLE;
  var dns = {};

  function splitUserAgent(raw) {
    var match = /^([^\/\s]+)\/(\S+)\s*(.*)$/.exec(raw || "");
    if (!match) return { product: raw || "", version: "", comment: "", raw_value: raw || "" };
    return { product: match[1], version: match[2], comment: match[3], raw_value: raw };
  }

  function expandIPv6(ip) {
    var halves = ip.split("::");
    var head = halves[0] ? halves[0].split(":") : [];
    var tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
    var missing = 8 - head.length - tail.length;
    if (halves.length > 2 || missing < 0) return null;
    var fill = [];
    for (var i = 0; i < (halves.length > 1 ? missing : 0); i++) fill.push("0");
    var groups = head.concat(fill, tail);
    return groups.length === 8 ? groups : null;
  }

  // Turns geojs's answer into the same shape as SAMPLE (the region code is filled in later).
  function fromGeojs(answer) {
    return {
      ip: answer.ip,
      country: answer.country || "",
      country_iso: answer.country_code || "",
      region_name: answer.region || "",
      region_code: "",
      city: answer.city || UNKNOWN,
      latitude: answer.latitude === undefined ? "" : Number(answer.latitude),
      longitude: answer.longitude === undefined ? "" : Number(answer.longitude),
      time_zone: answer.timezone || UNKNOWN,
      asn: answer.asn ? "AS" + answer.asn : "",
      asn_org: answer.organization_name || "",
      hostname: UNKNOWN,
      user_agent: splitUserAgent(navigator.userAgent)
    };
  }

  // Keep in step with normalizeRegion in build.mjs.
  function normalizeRegion(name) {
    return String(name)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/(province|region|state|oblast|prefecture|county|governorate|municipality|tinh|thanh pho)/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  var regionsPromise = null;

  // The region's code within its country ("46" for Tiền Giang, VN), or "" when it isn't found.
  function regionCode(country, region) {
    if (!country || !region) return Promise.resolve("");
    if (!regionsPromise) {
      regionsPromise = fetch(REGIONS_URL)
        .then(function (res) { return res.ok ? res.json() : {}; })
        .catch(function () { return {}; });
    }
    return regionsPromise.then(function (regions) {
      var names = regions[country.toUpperCase()] || {};
      var key = normalizeRegion(region);
      if (!key) return "";
      if (names[key]) return names[key];
      var match = Object.keys(names).filter(function (name) {
        return name.indexOf(key) !== -1 || key.indexOf(name) !== -1;
      });
      return match.length === 1 ? names[match[0]] : "";
    });
  }

  // "[VN] Vietnam": the code in brackets, then the name; either alone when the other is missing.
  function withCode(code, name) {
    if (code && name) return "[" + code + "] " + name;
    if (code) return "[" + code + "]";
    return name || UNKNOWN;
  }

  function fieldValue(name) {
    var ua = data.user_agent || {};
    switch (name) {
      case "ua_product": return ua.product ? ua.product + "/" + ua.version : "";
      case "ua_comment": return ua.comment;
      case "ua_raw": return ua.raw_value;
      case "country_full": return withCode(data.country_iso, data.country);
      case "region_full": return withCode(data.region_code, data.region_name);
      case "asn_full": return withCode(data.asn, data.asn_org);
      default: return data[name];
    }
  }

  function renderFacts() {
    document.getElementById("ipHero").textContent = data.ip;
    document.querySelectorAll("[data-field]").forEach(function (cell) {
      var value = fieldValue(cell.getAttribute("data-field"));
      cell.textContent = value === undefined || value === null ? "" : String(value);
      cell.parentNode.classList.toggle("hidden", value === undefined || value === null || value === "");
    });
    renderMap();
  }

  // Google's embeddable map, centred on the location with a pin.
  function renderMap() {
    var map = document.getElementById("map");
    var lat = Number(data.latitude);
    var lon = Number(data.longitude);
    if (data.latitude === "" || !isFinite(lat) || !isFinite(lon)) {
      map.removeAttribute("src");
      return;
    }
    var src = "https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1s" +
      encodeURIComponent(lat + "," + lon) + "!6i" + MAP_ZOOM;
    if (map.getAttribute("src") !== src) map.setAttribute("src", src);
  }

  function renderDns() {
    document.querySelectorAll("[data-dns]").forEach(function (cell) {
      var value = dns[cell.getAttribute("data-dns")];
      if (value !== undefined) cell.textContent = value;
    });
  }

  function setDns(fields) {
    Object.keys(fields).forEach(function (key) { dns[key] = fields[key]; });
    renderDns();
  }

  function dohQuery(name, type) {
    return fetch(DOH_URL + "?name=" + encodeURIComponent(name) + "&type=" + type, {
      headers: { Accept: "application/dns-json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("DNS lookup failed: " + res.status);
      return res.json();
    }).then(function (answer) {
      var typeNumber = { A: 1, PTR: 12, AAAA: 28 }[type];
      return (answer.Answer || []).filter(function (record) {
        return record.type === typeNumber;
      }).map(function (record) {
        return String(record.data).replace(/\.$/, "");
      });
    });
  }

  // The name used for reverse look-ups: 4.3.2.1.in-addr.arpa, or nibbles under ip6.arpa.
  function reverseName(ip) {
    if (ip.indexOf(":") === -1) return ip.split(".").reverse().join(".") + ".in-addr.arpa";
    var groups = expandIPv6(ip);
    if (!groups) return null;
    var hex = groups.map(function (g) { return ("0000" + g).slice(-4); }).join("");
    return hex.split("").reverse().join(".") + ".ip6.arpa";
  }

  // Reverse DNS, then whether the name points back to the same address.
  function lookupReverseDns(ip) {
    var name = reverseName(ip);
    if (!name) {
      setDns({ ptr: UNKNOWN, fcrdns: UNKNOWN });
      return Promise.resolve();
    }
    return dohQuery(name, "PTR").then(function (names) {
      if (!names.length) {
        data.hostname = UNKNOWN;
        renderFacts();
        setDns({ ptr: "No PTR record", fcrdns: "–" });
        return;
      }
      data.hostname = names[0];
      renderFacts();
      setDns({ ptr: names.join(", ") });
      var type = ip.indexOf(":") === -1 ? "A" : "AAAA";
      return dohQuery(names[0], type).then(function (addresses) {
        var same = addresses.some(function (a) { return a.toLowerCase() === ip.toLowerCase(); });
        setDns({ fcrdns: same ? "Yes" : "No" });
      });
    }).catch(function () {
      setDns({ ptr: "Couldn't look it up", fcrdns: "Couldn't look it up" });
    });
  }

  function randomLabel() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var label = "";
    for (var i = 0; i < 32; i++) label += chars.charAt(Math.floor(Math.random() * chars.length));
    return label;
  }

  // Which DNS server the visitor's computer uses (not the one for ?ip=, which can't be known).
  function lookupResolver() {
    return fetch("https://" + randomLabel() + "." + RESOLVER_DOMAIN + "/json")
      .then(function (res) {
        if (!res.ok) throw new Error("resolver lookup failed: " + res.status);
        return res.json();
      })
      .then(function (answer) {
        var resolver = answer.dns || {};
        var edns = answer.edns || {};
        setDns({
          resolver_ip: resolver.ip || UNKNOWN,
          resolver_geo: resolver.geo || UNKNOWN,
          edns: edns.ip ? edns.ip + (edns.geo ? " (" + edns.geo + ")" : "") : "Not sent"
        });
      })
      .catch(function () {
        setDns({ resolver_ip: "Couldn't look it up", resolver_geo: UNKNOWN, edns: UNKNOWN });
      });
  }

  // The street address nearest the location's coordinates, shown between "Map" and the map.
  function renderAddress() {
    var box = document.getElementById("address");
    var lat = Number(data.latitude);
    var lon = Number(data.longitude);
    if (data.latitude === "" || !isFinite(lat) || !isFinite(lon)) {
      box.textContent = "Address not available";
      return Promise.resolve();
    }
    var url = ADDRESS_URL + "?format=jsonv2&zoom=18&lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon);
    return getJson(url).then(function (answer) {
      box.textContent = (answer && answer.display_name) || "Address not available";
    }).catch(function () {
      box.textContent = "Address not available";
    });
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // yyyy/mm/dd hh:mm:ss in the visitor's own time zone.
  function formatTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function readHistory() {
    try {
      var list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(list) ? list.slice(0, HISTORY_SIZE) : [];
    } catch (e) {
      return [];
    }
  }

  function addToHistory(ip) {
    var list = [{ time: Date.now(), ip: ip }].concat(readHistory()).slice(0, HISTORY_SIZE);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
      // Storage can be off (private windows); the list then lasts for this page only.
    }
    renderHistory(list);
  }

  function renderHistory(list) {
    var body = document.getElementById("history");
    body.innerHTML = "";
    list.forEach(function (entry) {
      var row = document.createElement("tr");
      var time = document.createElement("td");
      var ip = document.createElement("td");
      time.textContent = formatTime(entry.time);
      ip.textContent = entry.ip;
      row.appendChild(time);
      row.appendChild(ip);
      body.appendChild(row);
    });
    document.getElementById("historyEmpty").classList.toggle("hidden", list.length > 0);
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("lookup failed: " + res.status);
      return res.json();
    });
  }

  function lookup(ip) {
    var url = LOOKUP_URL + (ip ? "/" + encodeURIComponent(ip) : "") + ".json";
    return getJson(url).then(function (answer) {
      if (Array.isArray(answer)) answer = answer[0];
      if (!answer || !answer.ip) throw new Error("lookup failed");
      data = fromGeojs(answer);
      renderFacts();
      renderAddress();
      addToHistory(data.ip);
      regionCode(data.country_iso, data.region_name).then(function (code) {
        data.region_code = code;
        renderFacts();
      });
      return lookupReverseDns(data.ip);
    });
  }

  // First paint with sample data, then look up the visitor (or ?ip=...).
  var requested = new URLSearchParams(window.location.search).get("ip");
  renderFacts();
  renderHistory(readHistory());
  lookupResolver();
  lookup(requested).catch(function () {
    // The sample values stay on screen when the lookup service can't be reached.
    renderAddress();
  });
})();
