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
  'grade','pass','distinction','merit','honor','excellence','achievement'
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
function detectNames(rawText) {
  const lines = rawText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  const candidates = [];

  for (const line of lines) {
    // Look for 2-4 capitalized words in a row (typical name pattern)
    const namePattern = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3})\b/g;
    let match;
    while ((match = namePattern.exec(line)) !== null) {
      const phrase = match[1].trim();
      const words = phrase.split(' ');

      // Filter: skip if any word is a known keyword
      const hasKeyword = words.some(w => CERT_KEYWORDS.has(w.toLowerCase()));
      if (hasKeyword) continue;

      // Filter: skip if phrase is too short or all caps (likely a title/header)
      if (phrase.length < 5) continue;
      if (phrase === phrase.toUpperCase()) continue;

      // Score: prefer phrases where words look like names (2-3 words)
      const score = words.length >= 2 && words.length <= 4 ? 1 : 0.5;
      candidates.push({ name: phrase, score });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, return top candidate
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].name;
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
  return (text.match(urlPattern) || []).slice(0, 3); // max 3 URLs
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
