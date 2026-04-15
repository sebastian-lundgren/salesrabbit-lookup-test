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

    const candidates = [];

    $(".listing--person").each((_, el) => {
      const box = $(el);

      const name =
        cleanText(box.find('a[data-galog*="Tittel"]').first().text()) ||
        cleanText(box.find("a").first().text());

      const phone =
        cleanText(box.find(".button-call__number").first().text()) ||
        cleanText(box.find('a[href^="tel:"]').first().text());

      const addressText = cleanText(box.text());
      const score = scoreAddressMatch(addressText, street1, zip, city);

      if (name && phone) {
        candidates.push({
          name,
          phone,
          addressText,
          score,
        });
      }
    });

    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];

    if (!best || best.score < 8) {
      return res.json({
        match: false,
        leadId,
        query,
        url,
        candidates: candidates.slice(0, 5),
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
