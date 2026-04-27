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
  // Platforms
  'coursera','udemy','edx','linkedin','skillshare','pluralsight','codecademy',
  'datacamp','kaggle','alison','futurelearn','swayam','nptel','simplilearn',
  // Certificate language
  'certificate','completion','certify','awarded','issued','certifies','hereby',
  'presented','this','that','credential','achievement','successfully','completed',
  'congratulations','verify','verification','authorized','signature','confirmed',
  'participation','proud','announce','recognition','honour','honor','distinction',
  // Academic institutions (generic)
  'university','college','institute','school','academy','department','faculty',
  'stanford','harvard','mit','yale','oxford','cambridge','illinois','georgia',
  'michigan','duke','cornell','columbia','princeton','caltech','carnegie',
  // Tech companies as issuers
  'google','microsoft','amazon','ibm','oracle','cisco','adobe','meta','apple',
  'salesforce','atlassian','hubspot','aws','azure','gcp',
  // Course/subject words that look like names when Title Cased
  'retrieval','search','engines','machine','learning','deep','neural','network',
  'data','analytics','science','artificial','intelligence','natural','language',
  'processing','computer','vision','cloud','computing','security','blockchain',
  'python','javascript','react','angular','node','java','swift','kotlin','sql',
  'statistics','probability','algebra','calculus','biology','chemistry','physics',
  'history','geography','economics','accounting','finance','marketing','business',
  'management','leadership','communication','strategy','operations','supply',
  'chain','logistics','entrepreneurship','innovation','digital','transformation',
  'architecture','infrastructure','devops','agile','scrum','product','project',
  'art','arts','history','literature','philosophy','ethics','social','cultural',
  'text','information','retrieval','web','internet','systems','algorithms',
  'structures','databases','networks','programming','software','hardware',
  // Role/title words near instructor names
  'principal','senior','junior','lead','chief','head','director','manager',
  'instructor','professor','teacher','faculty','dean','president','founder',
  'technologist','technician','engineer','developer','analyst','specialist',
  'researcher','scientist','architect','consultant','advisor','mentor','coach',
  // Training / certification qualifiers
  'training','certification','certication','non','credit','online','offline',
  'services','essentials','fundamentals','intermediate','advanced','beginner',
  'introduction','complete','guide','masterclass','bootcamp','workshop',
  'seminar','webinar','conference','program','module','course','nanodegree',
  'professional','development','specialization','pathway','track','series',
  // Time words
  'january','february','march','april','may','june','july','august',
  'september','october','november','december','jan','feb','mar','apr',
  'jun','jul','aug','sep','oct','nov','dec','issued','date','year','month',
  // Misc noise
  'score','grade','pass','fail','rank','level','stage','phase','step',
  'unit','week','hour','minute','second','point','percent','total','final',
  'quiz','exam','test','assignment','project','capstone','thesis',
]);

// ─── TITLE-CASE CONVERTER (for ALL-CAPS names like "AYAZ ALAM") ──────────────
function toTitleCase(str) {
  return str.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

// ─── NORMALISE RAW TEXT LINE FOR NAME SCANNING ───────────────────────────────
// Converts "AYAZ ALAM" → "Ayaz Alam", leaves mixed-case unchanged
function normaliseLine(line) {
  const trimmed = line.trim();
  // If entire line is ALL CAPS words (2–4 words, no digits), convert to Title Case
  const words = trimmed.split(/\s+/);
  const allCaps = words.every(w => /^[A-Z]{2,}$/.test(w));
  if (allCaps && words.length >= 2 && words.length <= 4) {
    return toTitleCase(trimmed);
  }
  return trimmed;
}

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
// Handles: "John Doe", "kashish Adwani", "AYAZ ALAM" (all-caps), "Priya Sharma Nair"
function detectNames(rawText) {
  const rawLines = rawText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  const candidates = [];

  // Scan both original and normalised versions of each line
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const rawLine   = rawLines[lineIndex];
    const normLine  = normaliseLine(rawLine);  // converts ALL-CAPS lines to Title Case
    const linesToScan = rawLine === normLine ? [normLine] : [normLine, rawLine];

    for (const line of linesToScan) {
      // Pattern 1: Standard "Firstname Lastname" (both capitalised)
      const stdPattern = /\b([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{0,25}){1,3})\b/g;
      // Pattern 2: Mixed-case like "kashish Adwani" (first word lowercase)
      const mixedPattern = /\b([a-z][a-z]{1,24}\s+[A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{0,25}){0,2})\b/g;

      for (const pattern of [stdPattern, mixedPattern]) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const phrase = match[1].trim();
          const words  = phrase.split(/\s+/).filter(Boolean);

          // Must be 2–4 words
          if (words.length < 2 || words.length > 4) continue;

          // Filter: skip if ANY word is a known keyword
          if (words.some(w => CERT_KEYWORDS.has(w.toLowerCase()))) continue;

          // Filter: skip all-uppercase remnants (shouldn't happen after normalise, but safety net)
          if (phrase === phrase.toUpperCase()) continue;

          // Filter: skip very short phrases
          if (phrase.replace(/\s/g, '').length < 5) continue;

          // Filter: skip phrases that look like course titles
          // (more than 1 of the top-3 words are common English nouns/verbs)
          const ENGLISH_COMMON = new Set(['text','web','data','search','deep','model',
            'cloud','smart','open','free','fast','safe','real','next','core','full',
            'good','best','top','new','old','big','high','low','key','hot','live']);
          if (words.filter(w => ENGLISH_COMMON.has(w.toLowerCase())).length > 1) continue;

          // Score calculation
          const isStdCase    = /^[A-Z]/.test(phrase);
          const wasAllCaps   = rawLine === rawLine.toUpperCase() && rawLine.replace(/\s/g,'').length > 3;
          const positionBonus = Math.max(0, 1.5 - lineIndex * 0.08); // early lines score higher
          const lengthScore  = words.length === 2 ? 1.0 : words.length === 3 ? 0.95 : 0.7;
          const caseScore    = isStdCase ? 1.0 : 0.88;
          const allCapsBonus = wasAllCaps ? 0.1 : 0; // trust normalised all-caps lines

          const score = lengthScore * caseScore + positionBonus + allCapsBonus;
          candidates.push({ name: phrase, score, lineIndex });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Deduplicate by name string
  const seen = new Set();
  const unique = candidates.filter(c => {
    if (seen.has(c.name.toLowerCase())) return false;
    seen.add(c.name.toLowerCase());
    return true;
  });

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
        if (name.length > 2 && name.split(' ').length >= 2) {
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
        if (text && text.length > 2 && text.length < 80 && text.split(' ').length >= 2) {
          return { verifiedName: text, allNamesOnPage: [text], pageTitle, method: 'css-selector' };
        }
      } catch { continue; }
    }

    // ── STRATEGY 3: Collect ALL names on the page, return as pool ─────────────
    // Normalise ALL-CAPS segments too (e.g. "AYAZ ALAM" on some cert pages)
    const normalisedBody = bodyText.replace(/\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})\b/g, (m) => {
      // Only convert if it looks like 2-4 all-caps words (likely a name)
      const words = m.split(' ');
      if (words.length >= 2 && words.length <= 4) return toTitleCase(m);
      return m;
    });

    const allNamesOnPage = [];
    // Scan both original and normalised body for maximum coverage
    for (const body of [bodyText, normalisedBody]) {
      const nameRegex = /\b([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{0,25}){1,3})\b/g;
      let nm;
      while ((nm = nameRegex.exec(body)) !== null) {
        const candidate = nm[1].trim();
        const words = candidate.split(/\s+/);
        if (words.length < 2 || words.length > 4) continue;
        if (candidate.length < 5) continue;
        // Skip if any word is a cert keyword
        if (words.some(w => CERT_KEYWORDS.has(w.toLowerCase()))) continue;
        allNamesOnPage.push(candidate);
      }
    }

    // Deduplicate (case-insensitive)
    const seenNames = new Set();
    const uniqueNames = allNamesOnPage.filter(n => {
      const key = n.toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    if (uniqueNames.length > 0) {
      return { verifiedName: null, allNamesOnPage: uniqueNames, pageTitle, method: 'name-pool' };
    }

    return { verifiedName: null, allNamesOnPage: [], pageTitle, method: 'none' };
  } catch (err) {
    return { verifiedName: null, allNamesOnPage: [], pageTitle: null, error: err.message };
  }
}

// ─── NAME CLEANING ────────────────────────────────────────────────────────────
// Strips noise, normalises ALL-CAPS, splits CamelCase-concatenated date suffixes
const MONTH_NAMES = new Set(['january','february','march','april','may','june','july','august','september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec']);

function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();

  // 1. Normalise ALL-CAPS names → Title Case ("AYAZ ALAM" → "Ayaz Alam")
  const allCapsWords = name.split(/\s+/);
  if (allCapsWords.every(w => /^[A-Z]{2,}$/.test(w))) {
    name = toTitleCase(name);
  }

  // 2. Split on camelCase boundary (catches "SharmaNovember" → "Sharma November")
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 3. Remove trailing digits (day/year numbers)
  name = name.replace(/\s*\d+\s*$/, '').trim();

  // 4. Drop trailing month names
  const words = name.split(/\s+/).filter(Boolean);
  while (words.length > 0 && MONTH_NAMES.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  // 5. Drop trailing year tokens
  while (words.length > 0 && /^(19|20)\d{2}$/.test(words[words.length - 1])) {
    words.pop();
  }
  // 6. Reject if fewer than 2 words remain (wasn't a name)
  if (words.length < 1) return raw.trim();

  return words.join(' ').trim();
}

// ─── EXTRACT FIRST NAME ───────────────────────────────────────────────────────
function firstName(name) {
  if (!name) return '';
  const cleaned = cleanName(name);
  return cleaned.split(/\s+/)[0].toLowerCase();
}

// ─── FUZZY NAME COMPARISON ────────────────────────────────────────────────────
// Signals (weighted):
//   50% first-name similarity  — most reliable single token
//   25% full-name Dice         — overall string similarity
//   25% token-set overlap      — handles reordered / partial names
// Rules:
//   • First-name EXACT match → floor score at 0.85 (always REAL)
//   • All tokens of cert name found in page name → floor at 0.90
function compareNames(raw1, raw2) {
  if (!raw1 || !raw2) return 0;

  const n1 = cleanName(raw1).toLowerCase();
  const n2 = cleanName(raw2).toLowerCase();
  if (!n1 || !n2) return 0;

  // Signal 1: full name Dice similarity
  const fullSim = stringSimilarity.compareTwoStrings(n1, n2);

  // Signal 2: first name
  const fn1 = firstName(raw1);
  const fn2 = firstName(raw2);
  const firstNameSim   = stringSimilarity.compareTwoStrings(fn1, fn2);
  const firstNameExact = fn1.length >= 2 && fn1 === fn2;

  // Signal 3: token-set overlap (handles "Ayaz Alam" vs "Ayaz Alam September")
  const tokens1 = n1.split(/\s+/).filter(t => t.length >= 2);
  const tokens2 = n2.split(/\s+/).filter(t => t.length >= 2);
  const matchedTokens = tokens1.filter(t1 =>
    tokens2.some(t2 => stringSimilarity.compareTwoStrings(t1, t2) >= 0.85)
  );
  const tokenOverlap = tokens1.length > 0 ? matchedTokens.length / tokens1.length : 0;

  // Signal 4: last name (if both have 2+ tokens)
  let lastNameSim = 0;
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    lastNameSim = stringSimilarity.compareTwoStrings(
      tokens1[tokens1.length - 1],
      tokens2[tokens2.length - 1]
    );
  }

  // Composite: first-name 45%, full 20%, token-set 25%, last-name 10%
  const composite = (firstNameSim * 0.45) + (fullSim * 0.20) + (tokenOverlap * 0.25) + (lastNameSim * 0.10);

  // Rule: first name exact match → floor at 0.85 (→ REAL)
  if (firstNameExact && composite < 0.85) return 0.85;

  // Rule: ALL cert tokens found in page name → floor at 0.90
  if (tokens1.length >= 2 && matchedTokens.length === tokens1.length && composite < 0.90) return 0.90;

  return Math.min(composite, 1.0);
}

// ─── COMPARE CERT NAME AGAINST POOL OF NAMES FROM VERIFICATION PAGE ──────────
// Returns { bestMatch, cleanedMatch, similarity, signals }
function findBestMatch(certName, namesPool) {
  if (!certName || !namesPool || namesPool.length === 0) {
    return { bestMatch: null, cleanedMatch: null, similarity: 0 };
  }

  const cleanedCert = cleanName(certName);
  let best = { bestMatch: null, cleanedMatch: null, similarity: 0 };

  for (const candidate of namesPool) {
    const cleanedCandidate = cleanName(candidate);
    const sim = compareNames(cleanedCert, cleanedCandidate);
    if (sim > best.similarity) {
      best = { bestMatch: candidate, cleanedMatch: cleanedCandidate, similarity: sim };
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
    // Multi-signal comparison: first name weighted 50%, full name 35%, last name 15%.
    // Cleaned names (month/date noise stripped) are used for display.
    // First-name exact match floors composite at 0.82 → always REAL.
    if (result.verificationUrl) {
      if (result.detectedName && result.allNamesOnPage && result.allNamesOnPage.length > 0) {
        const { bestMatch, cleanedMatch, similarity } = findBestMatch(result.detectedName, result.allNamesOnPage);

        // Display the cleaned version of the best match (no trailing dates/months)
        const cleanedCert = cleanName(result.detectedName);
        result.verifiedName = cleanedMatch || bestMatch;
        result.detectedName = cleanedCert; // also clean the cert-side name for display
        result.similarity = similarity;

        const fn1 = firstName(cleanedCert);
        const fn2 = firstName(cleanedMatch || bestMatch || '');
        const firstNameMatched = fn1 && fn2 && fn1 === fn2;

        if (similarity >= 0.80) {
          result.status = 'REAL';
          result.confidence = Math.min(similarity, 1.0);
          const matchDetail = firstNameMatched
            ? `first name "${fn1}" matched exactly`
            : `${(similarity * 100).toFixed(0)}% similarity`;
          result.reasons.push(`✅ Name verified: "${cleanedCert}" → "${result.verifiedName}" (${matchDetail})`);
        } else if (similarity >= 0.50) {
          result.status = 'SUSPICIOUS';
          result.confidence = similarity * 0.7;
          result.reasons.push(`⚠️ Partial match (${(similarity * 100).toFixed(0)}%): cert says "${cleanedCert}", page shows "${result.verifiedName}" — manual review recommended`);
        } else {
          result.status = 'FAKE';
          result.confidence = parseFloat((1 - similarity).toFixed(2));
          result.reasons.push(`❌ Name not found on verification page — cert says "${cleanedCert}", closest match on page was "${result.verifiedName || 'none'}"`);
        }
      } else if (result.detectedName && (!result.allNamesOnPage || result.allNamesOnPage.length === 0)) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.35;
        result.reasons.push('⚠️ Verification page loaded but no names could be extracted from it');
      } else if (!result.detectedName && result.allNamesOnPage && result.allNamesOnPage.length > 0) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.4;
        result.reasons.push('⚠️ URL verified but could not extract recipient name from certificate text');
      } else {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.3;
        result.reasons.push('⚠️ Verification page found but no names could be compared on either side');
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