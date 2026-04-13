const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createWorker } = require('tesseract.js');
const stringSimilarity = require('string-similarity');
const pdfParse = require('pdf-parse');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage only — no disk writes
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported type: ${file.mimetype}`));
  }
});

// ─── KNOWN CERTIFICATE KEYWORDS TO FILTER DURING NAME DETECTION ─────────────
const CERT_KEYWORDS = new Set([
  'coursera','udemy','certificate','completion','certify','awarded','issued',
  'instructor','authorized','signature','verify','credential','achievement',
  'stanford','harvard','mit','yale','oxford','cambridge','google','microsoft',
  'amazon','ibm','oracle','cisco','adobe','congratulations','successfully',
  'completed','presented','hereby','certifies','this','that','university',
  'college','institute','school','academy','online','learning','platform',
  'course','program','module','training','bootcamp','nanodegree','professional',
  'development','engineering','science','technology','management','business',
  'design','marketing','finance','health','medical','law','arts','education',
  'issued','date','year','month','january','february','march','april','may',
  'june','july','august','september','october','november','december','score',
  'grade','pass','distinction','merit','honor','excellence','achievement',
  // role/title words that appear near instructor names
  'principal','senior','junior','lead','chief','head','director','manager',
  'technologist','technician','engineer','developer','analyst','specialist',
  'certication','certification','authorized','non','credit','services','essentials',
  'fundamentals','intermediate','advanced','beginners','introduction','complete',
  'guide','masterclass','bootcamp','workshop','seminar','webinar','conference'
]);

// ─── OCR: EXTRACT TEXT FROM IMAGE BUFFER ─────────────────────────────────────
async function extractTextFromImage(buffer) {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(buffer);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

// ─── OCR: EXTRACT TEXT FROM PDF BUFFER ───────────────────────────────────────
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    return '';
  }
}

// ─── NAME DETECTION (NER-LITE) ───────────────────────────────────────────────
// Uses capitalization patterns + keyword filtering to detect human names
// Handles: "John Doe", "kashish Adwani" (lowercase start), "Priya Sharma Nair"
function detectNames(rawText) {
  const lines = rawText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  const candidates = [];

  for (const line of lines) {
    // Pattern 1: Standard "Firstname Lastname" (both capitalised)
    const stdPattern = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3})\b/g;
    // Pattern 2: Mixed-case like "kashish Adwani" (first word may be lowercase)
    const mixedPattern = /\b([a-z][a-z]{1,19}\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})\b/g;

    for (const pattern of [stdPattern, mixedPattern]) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const phrase = match[1].trim();
        const words = phrase.split(' ');

        // Filter: skip if any word is a known keyword
        const hasKeyword = words.some(w => CERT_KEYWORDS.has(w.toLowerCase()));
        if (hasKeyword) continue;

        // Filter: skip short phrases or all-caps (headers/titles)
        if (phrase.length < 4) continue;
        if (phrase === phrase.toUpperCase()) continue;

        // Score: 2-3 word names score highest; mixed-case (lowercase start) slightly lower
        const isStdCase = /^[A-Z]/.test(phrase);
        // Lines near top of cert = more likely to be the recipient
        const lineIndex = lines.indexOf(line);
        const positionBonus = Math.max(0, 1 - lineIndex * 0.05);
        const score = (words.length >= 2 && words.length <= 3 ? 1 : 0.6) * (isStdCase ? 1 : 0.9) + positionBonus;
        candidates.push({ name: phrase, score });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Deduplicate and sort by score descending
  const seen = new Set();
  const unique = candidates.filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; });
  unique.sort((a, b) => b.score - a.score);
  return unique[0].name;
}

// ─── QR CODE DETECTION ───────────────────────────────────────────────────────
async function extractQRCode(buffer, mimetype) {
  try {
    // Use Jimp to decode image and get pixel data
    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    const pixelData = new Uint8ClampedArray(image.bitmap.data);
    const result = jsQR(pixelData, width, height);
    return result ? result.data : null;
  } catch {
    return null;
  }
}

// ─── URL EXTRACTION FROM TEXT ─────────────────────────────────────────────────
function extractURLs(text) {
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

  // Strategy 1: normal scan (URLs with no spaces)
  const normal = (text.match(urlPattern) || []);
  if (normal.length > 0) return normal.slice(0, 3);

  // Strategy 2: PDFs embed spaces INSIDE URL tokens (e.g. "https://cour sera.org/ver ify/...")
  // Find any line with "http", collapse ALL spaces on that line, then re-scan
  const lines = text.split(/\n|\r/);
  for (const line of lines) {
    if (/https?:/i.test(line)) {
      const collapsed = line.replace(/[ \t]/g, '');
      const m = collapsed.match(/https?:\/\/[^\s"'<>]+/);
      if (m) return [m[0]];
    }
  }

  // Strategy 3: scan all adjacent lines near "verify" keyword for a fragmented URL
  const joined = text.replace(/[ \t]/g, ''); // collapse horizontal spaces only
  const m2 = joined.match(/https?:\/\/[^\n"'<>\s]+/g);
  if (m2 && m2.length > 0) return m2.slice(0, 3);

  return [];
}

// ─── LINK SCRAPING ────────────────────────────────────────────────────────────
async function scrapeVerificationPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CertVerifier/1.0)',
        'Accept': 'text/html'
      }
    });
    const $ = cheerio.load(response.data);

    // Try common patterns for name on cert pages
    const selectors = [
      '[class*="name"]', '[id*="name"]',
      '[class*="recipient"]', '[class*="student"]',
      'h1', 'h2', 'strong', '.cert-name', '.learner-name'
    ];

    for (const sel of selectors) {
      const text = $(sel).first().text().trim();
      if (text && text.length > 2 && text.length < 80) {
        const detected = detectNames(text);
        if (detected) return { verifiedName: detected, pageTitle: $('title').text().trim() };
      }
    }

    // Fallback: scan all visible text
    const bodyText = $('body').text();
    const name = detectNames(bodyText);
    return { verifiedName: name || null, pageTitle: $('title').text().trim() };
  } catch (err) {
    return { verifiedName: null, pageTitle: null, error: err.message };
  }
}

// ─── FUZZY NAME COMPARISON ────────────────────────────────────────────────────
function compareNames(name1, name2) {
  if (!name1 || !name2) return 0;
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();
  return stringSimilarity.compareTwoStrings(n1, n2);
}

// ─── MAIN VERIFICATION PIPELINE ──────────────────────────────────────────────
async function verifyCertificate(file) {
  const result = {
    fileName: file.originalname,
    fileSize: `${(file.size / 1024).toFixed(1)} KB`,
    mimeType: file.mimetype,
    extractedText: '',
    detectedName: null,
    qrContent: null,
    verificationUrl: null,
    verifiedName: null,
    pageTitle: null,
    similarity: 0,
    status: 'SUSPICIOUS',
    confidence: 0,
    reasons: []
  };

  try {
    // ── STEP 1: TEXT EXTRACTION ──────────────────────────────────────────────
    let rawText = '';
    if (file.mimetype === 'application/pdf') {
      rawText = await extractTextFromPDF(file.buffer);
      // If PDF text extraction failed or returned very little, it's image-based
      if (rawText.length < 50) {
        result.reasons.push('PDF appears to be image-based; OCR not applied to embedded images in this demo');
      }
    } else {
      rawText = await extractTextFromImage(file.buffer);
    }

    result.extractedText = rawText.slice(0, 1000); // Preview first 1000 chars

    if (!rawText || rawText.length < 20) {
      result.reasons.push('Could not extract sufficient text');
      result.status = 'SUSPICIOUS';
      result.confidence = 0.1;
      return result;
    }

    // ── STEP 2: NAME DETECTION ────────────────────────────────────────────────
    result.detectedName = detectNames(rawText);
    if (!result.detectedName) {
      result.reasons.push('No human name detected in certificate text');
    }

    // ── STEP 3: QR CODE DETECTION ─────────────────────────────────────────────
    if (file.mimetype !== 'application/pdf') {
      result.qrContent = await extractQRCode(file.buffer, file.mimetype);
    }

    // ── STEP 4: URL EXTRACTION ────────────────────────────────────────────────
    const urls = extractURLs(rawText);
    if (result.qrContent && result.qrContent.startsWith('http')) {
      result.verificationUrl = result.qrContent;
      result.reasons.push('QR code found with verification URL');
    } else if (urls.length > 0) {
      result.verificationUrl = urls[0];
      result.reasons.push(`Verification URL extracted from text: ${urls[0]}`);
    } else if (result.qrContent) {
      result.reasons.push(`QR found but content is not a URL: "${result.qrContent.slice(0, 80)}"`);
    } else {
      result.reasons.push('No QR code or verification URL found');
    }

    // ── STEP 5: LINK SCRAPING ─────────────────────────────────────────────────
    if (result.verificationUrl) {
      const scraped = await scrapeVerificationPage(result.verificationUrl);
      result.verifiedName = scraped.verifiedName;
      result.pageTitle = scraped.pageTitle;
      if (scraped.error) result.reasons.push(`Scraping error: ${scraped.error}`);
    }

    // ── STEP 6: COMPARISON + STATUS ───────────────────────────────────────────
    if (result.verificationUrl) {
      if (result.detectedName && result.verifiedName) {
        result.similarity = compareNames(result.detectedName, result.verifiedName);
        if (result.similarity >= 0.80) {
          result.status = 'REAL';
          result.confidence = result.similarity;
          result.reasons.push(`Names match with ${(result.similarity * 100).toFixed(0)}% similarity`);
        } else if (result.similarity >= 0.50) {
          result.status = 'SUSPICIOUS';
          result.confidence = result.similarity * 0.7;
          result.reasons.push(`Names partially match (${(result.similarity * 100).toFixed(0)}%); manual review recommended`);
        } else {
          result.status = 'FAKE';
          result.confidence = 1 - result.similarity;
          result.reasons.push(`Name mismatch: detected "${result.detectedName}" vs verified "${result.verifiedName}"`);
        }
      } else if (result.verifiedName && !result.detectedName) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.4;
        result.reasons.push('URL verified but could not extract name from certificate');
      } else if (result.detectedName && !result.verifiedName) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.35;
        result.reasons.push('Could not extract name from verification page');
      } else {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.3;
        result.reasons.push('Verification page found but no names could be compared');
      }
    } else {
      // No URL / QR
      result.status = 'SUSPICIOUS';
      result.confidence = 0.25;
      if (!result.reasons.some(r => r.includes('No QR'))) {
        result.reasons.push('No verifiable link — cannot confirm authenticity');
      }
    }

  } catch (err) {
    result.status = 'ERROR';
    result.confidence = 0;
    result.reasons.push(`Processing error: ${err.message}`);
  }

  return result;
}

// ─── API ENDPOINT ─────────────────────────────────────────────────────────────
app.post('/verify-certificates', upload.array('certificates', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    // Process all files in parallel
    const results = await Promise.all(req.files.map(verifyCertificate));
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'CertVerify API running' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ CertVerify backend running on http://localhost:${PORT}`));