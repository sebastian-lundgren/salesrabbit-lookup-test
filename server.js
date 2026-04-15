const express = require("express");
const cheerio = require("cheerio");

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

function isLikelyName(text) {
  const t = cleanText(text);
  if (!t) return false;
  if (/\d/.test(t)) return false;
  if (t.length < 4 || t.length > 60) return false;
  if (!/\s/.test(t)) return false;

  const blocked = [
    "Person",
    "Bedrift",
    "Steder",
    "Kart",
    "Mer info",
    "Vis resultatet i kart",
    "Kundeservice",
    "Om oss",
    "Cookies",
    "Min side",
    "App",
    "Tjenester",
    "Nyttige sider",
  ];

  if (blocked.some(word => t.includes(word))) return false;

  return /^[A-Za-zÆØÅæøå .'\-]+$/.test(t);
}

app.post("/lookup-1881", async (req, res) => {
  try {
    const { leadId, street1, city, zip } = req.body || {};

    const query = [street1, zip, city].filter(Boolean).join(" ");
    const url = `https://www.1881.no/?query=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    let phone = cleanText($('a[href^="tel:"]').first().text());

    if (!phone) {
      const bodyText = cleanText($("body").text());
      const phoneMatch = bodyText.match(/\b\d{3}\s?\d{2}\s?\d{3}\b|\b\d{8}\b/);
      phone = phoneMatch ? phoneMatch[0] : "";
    }

    let name = "";

    const headingCandidates = [];
    $("h1, h2, h3").each((_, el) => {
      const t = cleanText($(el).text());
      if (isLikelyName(t)) headingCandidates.push(t);
    });

    if (headingCandidates.length > 0) {
      name = headingCandidates[0];
    }

    if (!name) {
      const generalCandidates = [];
      $("a, span, div").each((_, el) => {
        const t = cleanText($(el).text());
        if (isLikelyName(t)) generalCandidates.push(t);
      });

      const uniqueCandidates = [...new Set(generalCandidates)];
      if (uniqueCandidates.length > 0) {
        name = uniqueCandidates[0];
      }
    }

    if (!name || !phone) {
      return res.status(404).json({
        match: false,
        leadId,
        query,
        url,
        foundName: name || null,
        foundPhone: phone || null,
      });
    }

    const { firstName, lastName } = splitName(name);

    return res.json({
      match: true,
      leadId,
      query,
      url,
      firstName,
      lastName,
      phone: normalizePhone(phone),
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
