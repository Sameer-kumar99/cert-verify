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

const NAME_REJECT_WORDS = new Set([
  'course','certificate','certification','training','program','module','bootcamp',
  'lecture','session','workshop','seminar','webinar','conference','class',
  'introduction','intro','advanced','intermediate','fundamentals','essentials',
  'professional','business','learning','education','development',
  'machine','learning','data','science','text','retrieval','search','engines',
  'natural','language','processing','analytics','model','evaluation','database',
  'vector','technology','information','architecture','statistics','marketing',
  'design','health','medical','law','finance','management','skill','coursework',
  'ethical','hacking','security','cloud','platform','online','academic',
  'art','history','product','manager','academy','bookkeeping','income','skills',
  'learn','artificial','coursera','inc','microsoft','windows','free','courses',
  'for','everyone','certificate','coursera','credentials','educators','top',
  'enroll','seo','uia','ux','database','model','evaluation','vector','big','data'
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
// Returns { verifiedName, allNamesOnPage, pageTitle, error }
async function scrapeVerificationPage(url) {
  try {
    // Try multiple header sets — platforms block basic UA strings
    const headerSets = [
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      {
        'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
        'Accept': 'text/html',
      }
    ];

    let response = null;
    for (const headers of headerSets) {
      try {
        response = await axios.get(url, { timeout: 10000, headers, maxRedirects: 5 });
        break; // success
      } catch (e) {
        if (e.response && e.response.status === 403) continue; // try next header set
        throw e; // rethrow non-403 errors
      }
    }
    if (!response) throw new Error('All request attempts blocked (403)');
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().trim();
    const bodyText = $('body').text().replace(/\s+/g, ' ');

    // ── STRATEGY 1: "Completed by <Name>" pattern (Coursera, edX, etc.) ──────
    // Matches: "Completed by John Doe", "Earned by Jane Smith", "Awarded to Bob"
    const completedByPatterns = [
      /Completed\s+by\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /Earned\s+by\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /Awarded\s+to\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /Issued\s+to\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /Certificate\s+for\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /This\s+certifies\s+that\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
      /presented\s+to\s+([A-Za-z][a-zA-Z .'-]{2,40})/i,
    ];

    for (const pat of completedByPatterns) {
      const m = bodyText.match(pat);
      if (m && m[1]) {
        const name = m[1].trim().replace(/[.,;:]+$/, '');
        if (isLikelyPersonName(name)) {
          return { verifiedName: name, allNamesOnPage: [name], pageTitle, method: 'completed-by-pattern' };
        }
      }
    }

    // ── STRATEGY 2: Platform-specific CSS selectors ───────────────────────────
    const prioritySelectors = [
      // Coursera
      '[data-e2e="learner-name"]',
      '[class*="learner-name"]',
      '[class*="LearnerName"]',
      '[class*="recipient-name"]',
      '[class*="RecipientName"]',
      // edX
      '[class*="accomplishment-recipient"]',
      '[class*="certificate-name"]',
      // LinkedIn Learning
      '[class*="certificate__name"]',
      // Udemy
      '[class*="certificate-hero__name"]',
      // Generic
      '[data-testid*="name"]',
      '[data-cy*="name"]',
      '[class*="cert-name"]',
      '[class*="student-name"]',
      '[class*="user-name"]',
    ];

    for (const sel of prioritySelectors) {
      try {
        const text = $(sel).first().text().trim();
        if (text && text.length > 2 && text.length < 80 && text.split(' ').length >= 2 && isLikelyPersonName(text)) {
          return { verifiedName: text, allNamesOnPage: [text], pageTitle, method: 'css-selector' };
        }
      } catch { continue; }
    }

    // ── STRATEGY 3: Collect ALL names on the page, return as pool ─────────────
    // The caller will compare the detected cert name against this entire pool
    const allNamesOnPage = [];
    const nameRegex = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3})\b/g;
    let nm;
    while ((nm = nameRegex.exec(bodyText)) !== null) {
      const candidate = nm[1].trim();
      if (isLikelyPersonName(candidate)) {
        allNamesOnPage.push(candidate);
      }
    }

    // Deduplicate
    const uniqueNames = [...new Set(allNamesOnPage)];

    // If we found names, return the pool — comparison engine will find the best match
    if (uniqueNames.length > 0) {
      return { verifiedName: null, allNamesOnPage: uniqueNames, pageTitle, method: 'name-pool' };
    }

    return { verifiedName: null, allNamesOnPage: [], pageTitle, method: 'none' };
  } catch (err) {
    return { verifiedName: null, allNamesOnPage: [], pageTitle: null, error: err.message };
  }
}

// ─── NAME NORMALIZATION / TOKEN MATCHING ─────────────────────────────────────
function splitNameTokens(name) {
  return normalizeName(name).split(' ').filter(Boolean);
}

function hasFirstAndOtherNameMatch(name1, name2) {
  const tokens1 = splitNameTokens(name1);
  const tokens2 = splitNameTokens(name2);
  if (tokens1.length < 2 || tokens2.length < 2) return false;
  if (tokens1[0] !== tokens2[0]) return false;

  const rest1 = tokens1.slice(1);
  const rest2 = tokens2.slice(1);
  return rest1.some(part1 => rest2.some(part2 => part1 === part2 || part1.startsWith(part2) || part2.startsWith(part1)));
}

// ─── FUZZY NAME COMPARISON ────────────────────────────────────────────────────
function normalizeName(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyPersonName(name) {
  if (!name || typeof name !== 'string') return false;
  const normalized = normalizeName(name);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (tokens.some(token => token.length < 2)) return false;
  if (tokens.some(token => NAME_REJECT_WORDS.has(token))) return false;
  if (tokens.some(token => /\d/.test(token))) return false;
  if (!tokens.every(token => /^[a-z'-]{2,20}$/.test(token))) return false;
  return true;
}

function compareNames(name1, name2) {
  if (!name1 || !name2) return 0;
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  return stringSimilarity.compareTwoStrings(n1, n2);
}

// ─── COMPARE CERT NAME AGAINST POOL OF NAMES FROM VERIFICATION PAGE ──────────
// Returns { bestMatch, similarity, firstOtherMatch }
function findBestMatch(certName, namesPool) {
  if (!certName || !namesPool || namesPool.length === 0) return { bestMatch: null, similarity: 0, firstOtherMatch: false };
  let best = { bestMatch: null, similarity: 0, firstOtherMatch: false };
  for (const candidate of namesPool) {
    if (hasFirstAndOtherNameMatch(certName, candidate)) {
      return { bestMatch: candidate, similarity: 1, firstOtherMatch: true };
    }
    if (!isLikelyPersonName(candidate)) continue;

    const sim = compareNames(certName, candidate);
    if (sim > best.similarity) {
      best = { bestMatch: candidate, similarity: sim, firstOtherMatch: false };
    }
  }
  return best;
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
    allNamesOnPage: [],
    scrapeMethod: null,
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
      result.verifiedName = scraped.verifiedName;   // may be null if only pool found
      result.allNamesOnPage = scraped.allNamesOnPage || [];
      result.pageTitle = scraped.pageTitle;
      result.scrapeMethod = scraped.method;
      if (scraped.error) result.reasons.push(`Scraping error: ${scraped.error}`);

      // If Strategy 1/2 found a direct name, also add it to the pool
      if (result.verifiedName && !result.allNamesOnPage.includes(result.verifiedName)) {
        result.allNamesOnPage.unshift(result.verifiedName);
      }
    }

    // ── STEP 6: COMPARISON + STATUS ───────────────────────────────────────────
    // Core logic: compare detectedName against the ENTIRE pool of names from page.
    // As soon as any name in the pool matches above threshold → REAL.
    if (result.verificationUrl) {
      if (result.detectedName && result.allNamesOnPage && result.allNamesOnPage.length > 0) {
        const { bestMatch, similarity, firstOtherMatch } = findBestMatch(result.detectedName, result.allNamesOnPage);
        result.verifiedName = bestMatch;   // best matching name from page
        result.similarity = similarity;

        if (firstOtherMatch) {
          result.status = 'REAL';
          result.confidence = 1;
          result.reasons.push(`Verified by first-name + other name part match: "${result.detectedName}" vs "${bestMatch}"`);
        } else if (similarity >= 0.80) {
          result.status = 'REAL';
          result.confidence = similarity;
          result.reasons.push(`Name verified: "${result.detectedName}" matched "${bestMatch}" with ${(similarity * 100).toFixed(0)}% similarity`);
        } else if (similarity >= 0.50) {
          result.status = 'SUSPICIOUS';
          result.confidence = similarity * 0.7;
          result.reasons.push(`Partial match (${(similarity * 100).toFixed(0)}%): "${result.detectedName}" vs "${bestMatch}" — manual review recommended`);
        } else {
          result.status = 'FAKE';
          result.confidence = 1 - similarity;
          result.reasons.push(`Name not found on verification page — cert says "${result.detectedName}" but page shows "${bestMatch || 'unknown'}"`);
        }
      } else if (result.detectedName && (!result.allNamesOnPage || result.allNamesOnPage.length === 0)) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.35;
        result.reasons.push('Verification page loaded but no names could be extracted from it');
      } else if (!result.detectedName && result.allNamesOnPage && result.allNamesOnPage.length > 0) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.4;
        result.reasons.push('URL verified but could not extract name from certificate');
      } else {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.3;
        result.reasons.push('Verification page found but no names could be compared on either side');
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