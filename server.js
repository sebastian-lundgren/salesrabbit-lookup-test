const express = require("express");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("lookup-test kjører");
});

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizePhone(value) {
  const digits = (value || "").replace(/\D/g, "");
  if (digits.length === 8) {
    return digits.replace(/(\d{3})(\d{2})(\d{3})/, "$1 $2 $3");
  }
  return cleanText(value);
}

function splitName(fullName) {
  const parts = cleanText(fullName).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  };
}

function normalizeForCompare(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&aring;|å/g, "a")
    .replace(/&oslash;|ø/g, "o")
    .replace(/&aelig;|æ/g, "e")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRequestHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  };
}

function scoreAddressMatch(listingText, street1, zip, city) {
  const hay = normalizeForCompare(listingText);
  let score = 0;

  if (street1) {
    const streetNorm = normalizeForCompare(street1);
    const streetParts = streetNorm.split(" ").filter(Boolean);
    if (hay.includes(streetNorm)) {
      score += 10;
    } else {
      for (const part of streetParts) {
        if (part.length >= 2 && hay.includes(part)) score += 2;
      }
    }
  }

  if (zip && hay.includes(normalizeForCompare(zip))) score += 4;
  if (city && hay.includes(normalizeForCompare(city))) score += 3;

  return score;
}

function textLooksLikeName(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (/\d/.test(text)) return false;
  if (text.length < 2 || text.length > 80) return false;
  if (/@|http|www|\+/.test(text.toLowerCase())) return false;

  const blocked = new Set([
    "ring",
    "sms",
    "kart",
    "mer",
    "bedrift",
    "person",
    "steder",
    "vis mer",
    "vis mindre",
    "åpningstider",
  ]);
  const normalized = normalizeForCompare(text);
  if (blocked.has(normalized)) return false;

  const parts = text.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return false;

  return parts.every((part) => /^[A-Za-zÀ-ÖØ-öø-ÿ.'-]+$/.test(part));
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];

  for (const candidate of candidates) {
    const nameKey = normalizeForCompare(candidate.name);
    const phoneKey = (candidate.phone || "").replace(/\D/g, "");
    const key = `${nameKey}|${phoneKey}`;
    if (!nameKey || !phoneKey || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function getNameFromContainer($, container, telAnchor) {
  const tel = telAnchor && telAnchor.length ? telAnchor : $();
  const box = container && container.length ? container : tel.closest("li,article,section,div");

  const directCandidates = [
    cleanText(box.find('a[data-galog*="Tittel"]').first().text()),
    cleanText(box.find("h1,h2,h3,h4,.listing__title,.title,.name").first().text()),
    cleanText(box.find("a").not('a[href^="tel:"]').first().text()),
    cleanText(box.find("strong,span,p").first().text()),
    cleanText(box.contents().first().text && box.contents().first().text()),
  ];

  for (const candidate of directCandidates) {
    if (textLooksLikeName(candidate)) return candidate;
  }

  if (tel.length) {
    const nearby = [
      cleanText(tel.prevAll("a,strong,span,h1,h2,h3,h4").first().text()),
      cleanText(tel.closest("li,article,section,div").find("a,strong,h1,h2,h3,h4").first().text()),
      cleanText(tel.parent().prev().text()),
      cleanText(tel.parent().next().text()),
      cleanText(tel.closest("li,article,section,div").text().split("\n")[0]),
    ];
    for (const candidate of nearby) {
      if (textLooksLikeName(candidate)) return candidate;
    }
  }

  return "";
}

function collectDirectPersonCards($, street1, zip, city) {
  const candidates = [];

  $(".listing--person").each((_, el) => {
    const box = $(el);
    const phone =
      cleanText(box.find(".button-call__number").first().text()) ||
      cleanText(box.find('a[href^="tel:"]').first().text());
    const name = getNameFromContainer($, box, box.find('a[href^="tel:"]').first());
    const addressText = cleanText(box.text());
    const score = scoreAddressMatch(addressText, street1, zip, city);

    if (name && phone) {
      candidates.push({ name, phone, addressText, score });
    }
  });

  return candidates;
}

function collectAddressPagePeople($, street1, zip, city) {
  const candidates = [];
  const anchors = $(
    "*:contains('Personer med denne adressen'), *:contains('personer med denne adressen'), *:contains('Bedrifter og personer med denne adressen')",
  );
  const scopes = [];

  anchors.each((_, el) => {
    const scope = $(el).closest("section,article,main,body");
    if (scope.length) scopes.push(scope);
  });

  const targetScope = scopes.length ? scopes[0] : null;
  if (!targetScope) return candidates;

  targetScope.find('a[href^="tel:"]').each((_, telEl) => {
    const tel = $(telEl);
    const container = tel.closest(".listing--person,li,article,section,div");
    const name = getNameFromContainer($, container, tel);
    const phone = cleanText(tel.text());
    const addressText = cleanText(container.text());
    const score = scoreAddressMatch(addressText, street1, zip, city);

    if (name && phone) {
      candidates.push({ name, phone, addressText, score });
    }
  });

  return candidates;
}

function collectGenericResultContainers($, street1, zip, city) {
  const candidates = [];
  const containers = $(
    ".listing, .result, .results, .card, [class*='listing'], [class*='result'], li, article, section",
  );

  containers.each((_, el) => {
    const box = $(el);
    const telLinks = box.find('a[href^="tel:"]');
    if (!telLinks.length) return;

    telLinks.each((__, telEl) => {
      const tel = $(telEl);
      const name = getNameFromContainer($, box, tel);
      const phone = cleanText(tel.text());
      const addressText = cleanText(box.text());
      const score = scoreAddressMatch(addressText, street1, zip, city);

      if (name && phone) {
        candidates.push({ name, phone, addressText, score });
      }
    });
  });

  return candidates;
}

function collectGlobalTelFallback($, street1, zip, city) {
  const candidates = [];

  $('a[href^="tel:"]').each((_, telEl) => {
    const tel = $(telEl);
    const container = tel.closest(
      ".listing--person,.listing,.result,.card,li,article,section,div",
    );
    const name = getNameFromContainer($, container, tel);
    const phone = cleanText(tel.text());
    const addressText = cleanText(container.text());
    const score = scoreAddressMatch(addressText, street1, zip, city);

    if (name && phone) {
      candidates.push({ name, phone, addressText, score });
    }
  });

  return candidates;
}

function collect1881Candidates($, street1, zip, city) {
  const combined = [
    ...collectDirectPersonCards($, street1, zip, city),
    ...collectAddressPagePeople($, street1, zip, city),
    ...collectGenericResultContainers($, street1, zip, city),
    ...collectGlobalTelFallback($, street1, zip, city),
  ];

  const deduped = dedupeCandidates(combined);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function collectKartAddressSectionPeople($, street1, zip, city) {
  const candidates = [];
  const headingSelector = [
    "*:contains('Personer med denne adressen')",
    "*:contains('personer med denne adressen')",
    "*:contains('Bedrifter og personer med denne adressen')",
  ].join(",");

  $(headingSelector).each((_, el) => {
    const heading = $(el);
    const blocks = [
      heading.closest("section,article,main,div"),
      heading.parent(),
      heading.next(),
      heading.nextAll("section,article,div,ul,ol").first(),
    ].filter((block) => block && block.length);

    for (const block of blocks) {
      block.find('a[href^="tel:"]').each((__, telEl) => {
        const tel = $(telEl);
        const container = tel.closest(
          ".listing--person,.listing,.result,.card,li,article,section,div",
        );
        const name = getNameFromContainer($, container, tel);
        const phone = cleanText(tel.text());
        const addressText = cleanText(container.text() || block.text());
        const score = scoreAddressMatch(addressText, street1, zip, city);
        if (name && phone) candidates.push({ name, phone, addressText, score });
      });
    }
  });

  return candidates;
}

function extractPhoneFromTelAnchor(tel) {
  const fromText = cleanText(tel.text());
  if (fromText) return fromText;
  const href = cleanText(tel.attr("href"));
  if (href.startsWith("tel:")) return cleanText(href.replace(/^tel:/i, ""));
  return "";
}

function collectKartPersonRowCandidates($, street1, zip, city) {
  const candidates = [];
  const rowSelectors = [
    "#details_result_item",
    ".result-item",
    ".result-item-location",
    "li",
    "article",
    "section",
    "div",
  ].join(",");

  $(rowSelectors).each((_, el) => {
    const row = $(el);
    const personLink = row.find('h4 a[href*="/person/"]').first();
    const telLink = row.find('a[href^="tel:"]').first();
    if (!personLink.length || !telLink.length) return;

    const name = cleanText(personLink.text());
    const phone = extractPhoneFromTelAnchor(telLink);
    const addressText = cleanText(row.text());
    const score = scoreAddressMatch(addressText, street1, zip, city);
    if (name && phone) candidates.push({ name, phone, addressText, score });
  });

  return candidates;
}

function collectKartPersonAnchorFallback($, street1, zip, city) {
  const candidates = [];

  $('a[href*="/person/"]').each((_, linkEl) => {
    const personLink = $(linkEl);
    const container = personLink.closest(
      "#details_result_item,.result-item,.result-item-location,li,article,section,div",
    );
    if (!container.length) return;

    const scopedName =
      cleanText(container.find('h4 a[href*="/person/"]').first().text()) ||
      cleanText(personLink.text());
    const telLink = container.find('a[href^="tel:"]').first();
    if (!telLink.length) return;

    const phone = extractPhoneFromTelAnchor(telLink);
    const addressText = cleanText(container.text());
    const score = scoreAddressMatch(addressText, street1, zip, city);
    if (scopedName && phone) {
      candidates.push({ name: scopedName, phone, addressText, score });
    }
  });

  return candidates;
}

function collectKartCandidates($, street1, zip, city) {
  const combined = [
    ...collectKartPersonRowCandidates($, street1, zip, city),
    ...collectKartPersonAnchorFallback($, street1, zip, city),
    ...collectKartAddressSectionPeople($, street1, zip, city),
    ...collectAddressPagePeople($, street1, zip, city),
    ...collectGenericResultContainers($, street1, zip, city),
    ...collectGlobalTelFallback($, street1, zip, city),
  ];
  const deduped = dedupeCandidates(combined);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function extractLikelyFollowupLinks($) {
  const links = [];
  $('a[href]').each((_, el) => {
    const hrefRaw = cleanText($(el).attr("href"));
    if (!hrefRaw) return;
    if (hrefRaw.startsWith("tel:") || hrefRaw.startsWith("mailto:")) return;
    if (hrefRaw.startsWith("javascript:")) return;

    const href = hrefRaw.startsWith("http")
      ? hrefRaw
      : `https://www.1881.no${hrefRaw.startsWith("/") ? "" : "/"}${hrefRaw}`;
    if (!href.startsWith("https://www.1881.no/")) return;

    const hay = href.toLowerCase();
    if (
      hay.includes("/person") ||
      hay.includes("/adresse") ||
      hay.includes("/address") ||
      hay.includes("query=") ||
      hay.includes("/result")
    ) {
      links.push(href);
    }
  });

  return Array.from(new Set(links)).slice(0, 4);
}

function extractLikelyKartLinks($) {
  const links = [];
  $("a[href]").each((_, el) => {
    const hrefRaw = cleanText($(el).attr("href"));
    if (!hrefRaw) return;

    const href = hrefRaw.startsWith("http")
      ? hrefRaw
      : hrefRaw.startsWith("//")
        ? `https:${hrefRaw}`
        : `https://www.1881.no${hrefRaw.startsWith("/") ? "" : "/"}${hrefRaw}`;

    const hay = href.toLowerCase();
    if (!hay.includes("kart.1881.no")) return;
    if (hay.startsWith("tel:") || hay.startsWith("mailto:")) return;
    if (
      hay.includes("/adresse") ||
      hay.includes("/address") ||
      hay.includes("query=") ||
      hay.includes("sok")
    ) {
      links.push(href);
    }
  });

  return Array.from(new Set(links));
}

function buildKartFallbackUrl(street1, zip, city) {
  const query = [street1, zip, city].filter(Boolean).join(" ");
  return `https://kart.1881.no/?query=${encodeURIComponent(query)}`;
}

async function collectPlaywrightKartCandidates(street1, zip, city) {
  const query = [street1, zip, city].filter(Boolean).join(" ");
  const kartUrl = `https://kart.1881.no/?query=${encodeURIComponent(query)}`;
  const candidates = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: getRequestHeaders()["user-agent"],
    });
    const page = await context.newPage();
    await page.goto(kartUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    await Promise.race([
      page.waitForSelector('a[href*="/person/"]', { timeout: 8000 }),
      page.waitForSelector('a[href^="tel:"]', { timeout: 8000 }),
      page.waitForSelector("#details_result_item", { timeout: 8000 }),
      page.waitForSelector(".result-item-location", { timeout: 8000 }),
      page.waitForTimeout(5000),
    ]);

    const extracted = await page.evaluate(() => {
      const rows = [];
      const rowSelectors = [
        "#details_result_item",
        ".result-item",
        ".result-item-location",
        "li",
        "article",
        "section",
        "div",
      ];

      const getText = (value) => (value || "").replace(/\s+/g, " ").trim();
      const readPhone = (telAnchor) => {
        const text = getText(telAnchor.textContent);
        if (text) return text;
        const href = getText(telAnchor.getAttribute("href"));
        return href.startsWith("tel:") ? getText(href.replace(/^tel:/i, "")) : "";
      };

      for (const selector of rowSelectors) {
        const nodes = document.querySelectorAll(selector);
        nodes.forEach((row) => {
          const person = row.querySelector('h4 a[href*="/person/"], a[href*="/person/"]');
          const tel = row.querySelector('a[href^="tel:"]');
          if (!person || !tel) return;

          const name = getText(person.textContent);
          const phone = readPhone(tel);
          const addressText = getText(row.textContent);
          if (name && phone) rows.push({ name, phone, addressText });
        });
      }

      document.querySelectorAll('a[href*="/person/"]').forEach((person) => {
        const container = person.closest(
          "#details_result_item, .result-item, .result-item-location, li, article, section, div",
        );
        if (!container) return;
        const tel = container.querySelector('a[href^="tel:"]');
        if (!tel) return;

        const name = getText(
          (container.querySelector('h4 a[href*="/person/"]') || person).textContent,
        );
        const phone = readPhone(tel);
        const addressText = getText(container.textContent);
        if (name && phone) rows.push({ name, phone, addressText });
      });

      return rows;
    });

    for (const candidate of extracted) {
      candidates.push({
        name: candidate.name,
        phone: candidate.phone,
        addressText: candidate.addressText,
        score: scoreAddressMatch(candidate.addressText, street1, zip, city),
      });
    }

    await context.close();
  } catch (error) {
    console.error("playwright lookup warning:", error.message);
  } finally {
    if (browser) await browser.close();
  }

  const deduped = dedupeCandidates(candidates);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

app.post("/lookup-1881", async (req, res) => {
  try {
    const { leadId, street1, city, zip } = req.body || {};

    const query = [street1, zip, city].filter(Boolean).join(" ");
    const url = `https://www.1881.no/?query=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: getRequestHeaders(),
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    let candidates = collect1881Candidates($, street1, zip, city);

    if (candidates.length === 0) {
      const kartLinks = extractLikelyKartLinks($);
      const kartUrl = kartLinks[0] || buildKartFallbackUrl(street1, zip, city);

      try {
        const kartResponse = await fetch(kartUrl, {
          headers: getRequestHeaders(),
        });
        const kartHtml = await kartResponse.text();
        const $kart = cheerio.load(kartHtml);
        candidates = collectKartCandidates($kart, street1, zip, city);
      } catch (kartError) {
        console.error("kart lookup warning:", kartError.message);
      }
    }

    if (candidates.length === 0) {
      const followupLinks = extractLikelyFollowupLinks($);

      for (const followupUrl of followupLinks) {
        try {
          const followupResponse = await fetch(followupUrl, {
            headers: getRequestHeaders(),
          });
          const followupHtml = await followupResponse.text();
          const $$ = cheerio.load(followupHtml);
          const followupCandidates = collect1881Candidates($$, street1, zip, city);
          if (followupCandidates.length) {
            candidates = dedupeCandidates([...candidates, ...followupCandidates]).sort(
              (a, b) => b.score - a.score,
            );
            break;
          }
        } catch (innerError) {
          console.error("followup lookup warning:", innerError.message);
        }
      }
    }

    if (candidates.length === 0) {
      const playwrightCandidates = await collectPlaywrightKartCandidates(street1, zip, city);
      if (playwrightCandidates.length) {
        candidates = dedupeCandidates([...candidates, ...playwrightCandidates]).sort(
          (a, b) => b.score - a.score,
        );
      }
    }

    const best = candidates[0];

    if (!best) {
      return res.json({
        match: false,
        leadId,
        query,
        url,
        candidates: [],
      });
    }

    const { firstName, lastName } = splitName(best.name);

    return res.json({
      match: true,
      leadId,
      query,
      url,
      firstName,
      lastName,
      phone: normalizePhone(best.phone),
      candidates,
    });
  } catch (error) {
    console.error("lookup error:", error);
    return res.status(500).json({
      match: false,
      error: error.message,
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});
