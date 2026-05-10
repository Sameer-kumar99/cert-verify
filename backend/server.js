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

// ─── GOOGLE DRIVE UTILS ──────────────────────────────────────────────────────
function isGoogleDriveUrl(url) {
  return url && (url.includes('drive.google.com') || url.includes('docs.google.com'));
}

function extractDriveFileId(url) {
  let match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  match = url.match(/id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  return null;
}

async function downloadFromDrive(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) throw new Error('Could not extract Google Drive File ID');
  
  const apiUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  
  const response = await axios.get(apiUrl, {
    responseType: 'arraybuffer',
    timeout: 25000,
    headers: { 'User-Agent': 'CertVerify/2.0' },
    validateStatus: status => status < 500
  });

  let mimeType = (response.headers['content-type'] || '').split(';')[0].trim();
  const buffer = Buffer.from(response.data);

  if (buffer.length < 1000 && buffer.toString('utf8').includes('Google Drive - Virus scan warning')) {
    throw new Error('Google Drive requires a manual virus scan confirmation for this large file. Please use a direct link or upload the file.');
  }

  if (mimeType.includes('octet-stream')) {
    if (buffer.length > 4 && buffer.slice(0, 4).toString() === '%PDF') {
      mimeType = 'application/pdf';
    } else {
      mimeType = 'image/jpeg'; // fallback guess for tesseract
    }
  }

  return { buffer, mimeType, fileId };
}

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

// ─── OCR TEXT REPAIR ─────────────────────────────────────────────────────────
// Applied LINE-BY-LINE to prevent cross-line word corruptions.
//   "Ayaz Al Am"  → "Ayaz Alam"    (3-token split)
//   "A yaz Alam"  → "Ayaz Alam"    (orphaned capital)
//   "P arul"      → "Parul"         (split within word)
//   "Kri shna"    → "Krishna"       (lowercase tail)
//   "AYAZ AL AM"  → "AYAZ ALAM"     (ALL-CAPS split)
const OCR_STOPWORDS = new Set(['and','the','for','with','from','has','had','was','are','not','but','its','his','her','our','your','their','this','that','these','those']);

function repairOCRLine(line) {
  let r = line;

  // Pass 1: orphaned single Capital + lowercase continuation
  // "A yaz" → "Ayaz",  "P arul" → "Parul"
  r = r.replace(/\b([A-Z]) ([a-z]{2,14})\b/g, (full, a, b) => {
    const merged = a + b;
    return merged.length <= 16 ? merged : full;
  });

  // Pass 2: Cap-word + short lowercase tail fragment (before another Cap or EOL)
  // "Ma hika" → "Mahika",  "Kri shna" → "Krishna"
  r = r.replace(/([A-Z][a-z]{1,10}) ([a-z]{2,5})(?= [A-Z]|$)/g, (full, a, b) => {
    if (OCR_STOPWORDS.has(b.toLowerCase())) return full;  // never merge "and", "the" etc.
    const merged = a + b;
    return merged.length <= 16 ? merged : full;
  });

  // Pass 3: "Ayaz Al Am" — short middle Cap-word merges with the next word
  // "Al Am" (middle ≤4 chars) → "Alam"
  r = r.replace(/\b([A-Z][a-z]{2,18}) ([A-Z][a-z]{1,4}) ([A-Z][a-z]{2,18})\b/g,
    (full, a, b, c) => {
      const mergedBC = b + c.toLowerCase();   // "Al" + "am" = "Alam"
      if (b.length <= 4 && mergedBC.length <= 16) return a + ' ' + mergedBC;
      return full;
    }
  );

  // Pass 4: ALL-CAPS version: "AYAZ AL AM" → "AYAZ ALAM"
  r = r.replace(/\b([A-Z]{2,18}) ([A-Z]{1,4}) ([A-Z]{2,18})\b/g,
    (full, a, b, c) => b.length <= 4 ? a + ' ' + b + c : full
  );

  return r;
}

function repairOCRText(text) {
  // Process line-by-line to prevent cross-line merges corrupting unrelated text
  return text.split('\n').map(repairOCRLine).join('\n');
}
// ─── OCR: EXTRACT TEXT FROM IMAGE BUFFER ─────────────────────────────────────
async function extractTextFromImage(buffer) {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(buffer);
    return repairOCRText(data.text || '');
  } finally {
    await worker.terminate();
  }
}

// ─── OCR: EXTRACT TEXT FROM PDF BUFFER ───────────────────────────────────────
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    let raw = data.text || '';

    // Some PDFs render each character/word on its own line (copy-protection)
    // Detect this: if >40% of lines are ≤3 chars, rejoin short consecutive lines
    const lines = raw.split('\n');
    const shortLineCount = lines.filter(l => l.trim().length <= 3 && l.trim().length > 0).length;
    const nonEmptyCount  = lines.filter(l => l.trim().length > 0).length;

    if (nonEmptyCount > 5 && shortLineCount / nonEmptyCount > 0.40) {
      // Rejoin: accumulate chars/words until we hit a blank line or a long line
      const rejoined = [];
      let chunk = '';
      for (const line of lines) {
        const t = line.trim();
        if (t.length === 0) {
          if (chunk.trim()) rejoined.push(chunk.trim());
          chunk = '';
        } else if (t.length <= 3) {
          chunk += t + ' ';
        } else {
          if (chunk.trim()) rejoined.push(chunk.trim());
          chunk = '';
          rejoined.push(t);
        }
      }
      if (chunk.trim()) rejoined.push(chunk.trim());
      raw = rejoined.join('\n');
    }

    return repairOCRText(raw);
  } catch {
    return '';
  }
}

// ─── NAME DETECTION (NER-LITE) ───────────────────────────────────────────────
// 4-strategy pipeline, highest priority first:
//  S1. Sentence pattern  — "completed by X", "certifies that X", "presented to X"
//  S2. Context clue line — line immediately before/after "has successfully completed"
//  S3. Standalone scan   — Title-case 2-4 word phrases with keyword filtering
//  S4. Fallback          — ANY 2-word Title-case phrase not in keyword list

// ── Words that look Title-Case but are NOT person names ─────────────────────
const ENGLISH_COMMON = new Set([
  'text','web','data','search','deep','model','cloud','smart','open','free',
  'fast','safe','real','next','core','full','good','best','top','new','old',
  'big','high','low','key','hot','live','popular','official','premium',
  'offered','through','authorized','non','credit','online','offline',
  'verify','verification','hereby','presented','awarded','issued',
  'course','module','program','track','series','path','level','unit',
]);

// ── Trigger phrases: the name is on a NEARBY line, not inside this line ──────
const NAME_CONTEXT_TRIGGERS = [
  'has successfully completed',
  'has completed',
  'successfully completed',
  'this certifies that',
  'is hereby awarded',
  'this is to certify',
];

// ── Role words that appear near instructor/signatory names ────────────────────
// Lines that are ONLY role words → skip as name candidates
const ROLE_ONLY_PATTERN = /^(professor|instructor|teacher|principal|senior|junior|lead|chief|director|dean|chair|founder|ceo|cto|cfo|head|manager|technologist|technician|engineer|developer|researcher|scientist|architect|consultant|advisor|mentor|coach|faculty|staff|team|department|division|center|centre|school|college|university|institute|academy)(\s+(of|and|for|at|in|the|\S+))*$/i;

function isLikelyName(phrase) {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;  // must be 2-4 words for a full name
  if (phrase.replace(/\s/g,'').length < 5) return false;
  if (phrase === phrase.toUpperCase() && phrase.length > 3) return false;
  // Reject if ANY word is a cert/course keyword
  if (words.some(w => CERT_KEYWORDS.has(w.toLowerCase()))) return false;
  // Reject if ANY word is a common English filler (caught "offered through")
  if (words.some(w => ENGLISH_COMMON.has(w.toLowerCase()))) return false;
  // Reject pure role-title lines (instructor names handled separately)
  if (ROLE_ONLY_PATTERN.test(phrase.split(' ').slice(0,2).join(' '))) return false;
  // Must have at least one word that looks like a proper-noun name token
  // (Capital + ≥2 lowercase letters, OR all-lowercase ≥3 letters for mixed-case names)
  const hasProperToken = words.some(w =>
    /^[A-Z][a-z]{1,}$/.test(w) && w.length >= 2 ||
    /^[a-z]{3,}$/.test(w)
  );
  return hasProperToken;
}

function extractNameFromPhrase(raw) {
  if (!raw) return null;
  const phrase = raw.trim().replace(/[.,;:!]+$/,'');
  // Reject obviously non-name lines immediately
  if (/^(an |a |the |this |that |for |in |on |with |by |from |to |at )/i.test(phrase)) return null;
  if (isLikelyName(phrase)) return phrase;
  // Try progressively shorter prefixes (2-3 words)
  const words = phrase.split(/\s+/).filter(Boolean);
  for (let n = Math.min(words.length, 3); n >= 2; n--) {
    const sub = words.slice(0, n).join(' ');
    if (isLikelyName(sub)) return sub;
  }
  return null;
}

function detectNames(rawText) {
  const rawLines = rawText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  const fullText = rawLines.join(' ');

  // ── STRATEGY 1: "X has successfully completed" — exact line-start match ──────
  // Only match when X is on the SAME LINE as "has successfully" (not cross-line)
  // Use line-by-line scan to avoid multiline greediness bugs
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Pattern: line that ENDS with "has successfully completed" or "has completed"
    const m1 = line.match(/^(.+?)\s+has\s+successfully\s+completed/i);
    const m2 = line.match(/^(.+?)\s+has\s+completed/i);
    const match = m1 || m2;
    if (match) {
      const candidate = extractNameFromPhrase(normaliseLine(match[1]));
      if (candidate) return candidate;
    }
    // Pattern: "completed by X", "certifies that X", "presented to X" on same line
    const m3 = line.match(/(?:completed\s+by|certif(?:y|ies|ied)\s+that|presented\s+to|awarded\s+to|issued\s+to)\s+([A-Za-z][a-zA-Z\s.'-]{2,35}?)(?:\s*(?:has|for|on|in|,|$))/i);
    const m4 = line.match(/(?:this\s+is\s+to\s+certify\s+that)\s+([A-Za-z][a-zA-Z\s.'-]{2,35}?)(?:\s*(?:has|for|on|in|,|$))/i);
    const m5 = line.match(/(?:congratulat(?:es?|ions?))\s+([A-Za-z][a-zA-Z\s.'-]{2,35}?)(?:\s*(?:on|for|in|,|$))/i);
    for (const mx of [m3, m4, m5]) {
      if (mx) {
        const candidate = extractNameFromPhrase(normaliseLine(mx[1]));
        if (candidate) return candidate;
      }
    }
  }

  // ── STRATEGY 2: Context clue — ONLY the line ABOVE a trigger phrase ──────────
  // "below" check removed — it was picking up instructor names that appear
  // right after "has successfully completed" in Coursera/AWS format certs
  for (let i = 0; i < rawLines.length; i++) {
    const lower = rawLines[i].toLowerCase();
    const isTrigger = NAME_CONTEXT_TRIGGERS.some(t => lower.includes(t));
    if (!isTrigger) continue;

    // Walk UPWARD from trigger, skip date lines and empty lines
    for (let up = i - 1; up >= Math.max(0, i - 4); up--) {
      const aboveLine = normaliseLine(rawLines[up]);
      // Skip date-like lines
      if (/^\d|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(aboveLine)) continue;
      // Skip lines that are clearly course/platform descriptions
      if (/online|course|credit|authorized|offered|through|platform/i.test(aboveLine)) continue;
      const candidate = extractNameFromPhrase(aboveLine);
      if (candidate) return candidate;
    }
  }

  // ── STRATEGY 3: Scored standalone scan ──────────────────────────────────────
  const candidates = [];

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const rawLine  = rawLines[lineIndex];
    // Skip lines that look like dates, long descriptions, or role titles
    if (/^\d/.test(rawLine)) continue;  // starts with digit = date
    if (rawLine.length > 60) continue;   // long line = description, not a name
    if (/online|course|credit|authorized|offered|through|platform|web services/i.test(rawLine)) continue;

    const normLine = normaliseLine(rawLine);
    const linesToScan = rawLine === normLine ? [normLine] : [normLine, rawLine];

    for (const line of linesToScan) {
      const stdPat   = /\b([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{1,25}){1,3})\b/g;
      const mixedPat = /\b([a-z][a-z]{1,24}\s+[A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{1,25}){0,2})\b/g;

      for (const pattern of [stdPat, mixedPat]) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const phrase = match[1].trim();
          if (!isLikelyName(phrase)) continue;

          const words        = phrase.split(/\s+/).filter(Boolean);
          const isStdCase    = /^[A-Z]/.test(phrase);
          const wasAllCaps   = rawLine === rawLine.toUpperCase() && rawLine.replace(/\s/g,'').length > 3;
          const posBonus     = Math.max(0.0, 1.2 - lineIndex * 0.05);
          const lenScore     = words.length === 2 ? 1.0 : words.length === 3 ? 0.9 : 0.65;
          const caseScore    = isStdCase ? 1.0 : 0.85;
          const allCapsBonus = wasAllCaps ? 0.15 : 0;
          const score        = lenScore * caseScore + posBonus + allCapsBonus;
          candidates.push({ name: phrase, score, lineIndex });
        }
      }
    }
  }

  if (candidates.length > 0) {
    const seen = new Set();
    const unique = candidates.filter(c => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    unique.sort((a, b) => b.score - a.score);
    return unique[0].name;
  }

  // ── STRATEGY 4: Fallback — any 2-word title-case phrase ─────────────────────
  const fbPat = /\b([A-Z][a-z]{2,20}\s+[A-Z][a-z]{2,20})\b/g;
  let fm;
  while ((fm = fbPat.exec(fullText)) !== null) {
    const phrase = fm[1].trim();
    const words  = phrase.split(/\s+/);
    if (words.some(w => CERT_KEYWORDS.has(w.toLowerCase()))) continue;
    if (words.some(w => ENGLISH_COMMON.has(w.toLowerCase()))) continue;
    return phrase;
  }

  return null;
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

    // 3a. Normalise ALL-CAPS segments ("AYAZ ALAM" → "Ayaz Alam")
    const normalisedBody = bodyText.replace(/\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})\b/g, (m) => {
      const words = m.split(' ');
      return (words.length >= 2 && words.length <= 4) ? toTitleCase(m) : m;
    });

    // 3b. Score each candidate for "name-likeness"
    // A high-quality name candidate: short (2-3 words), no keyword words,
    // no common English adjectives, words have typical name length (4-12 chars)
    const COMMON_ENGLISH = new Set([
      'popular','free','best','top','new','get','our','all','for','and','the',
      'with','from','your','this','that','more','also','have','been','will',
      'than','then','when','into','about','other','which','these','their',
      'there','after','first','some','what','well','even','most','such',
      'much','many','only','both','just','over','back','make','take','come',
      'cyber','digital','online','open','smart','fast','real','live','next',
      'core','full','good','high','low','key','hot','premium','official',
    ]);

    function nameScore(candidate) {
      const words = candidate.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 3) return 0;
      // Any keyword word → reject
      if (words.some(w => CERT_KEYWORDS.has(w.toLowerCase()))) return 0;
      // Any common English word → reject
      if (words.some(w => COMMON_ENGLISH.has(w.toLowerCase()))) return 0;
      // Each word should look like a name token (4-15 chars, not all caps)
      const wordScores = words.map(w => {
        if (w.length < 2 || w.length > 20) return 0;
        if (w === w.toUpperCase() && w.length > 2) return 0.3; // all-caps word (abbrev?)
        if (/^[A-Z][a-z]{2,}$/.test(w)) return 1.0; // perfect Title Case word
        if (/^[a-z]{3,}$/.test(w)) return 0.7;       // lowercase (like "kashish")
        return 0.4;
      });
      const avgWordScore = wordScores.reduce((a,b)=>a+b,0) / wordScores.length;
      // Prefer 2-word names slightly over 3-word
      const lengthBonus = words.length === 2 ? 0.1 : 0;
      return avgWordScore + lengthBonus;
    }

    const allNamesOnPage = [];
    for (const body of [bodyText, normalisedBody]) {
      const nameRegex = /\b([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{0,25}){1,3})\b/g;
      let nm;
      while ((nm = nameRegex.exec(body)) !== null) {
        const candidate = nm[1].trim();
        if (nameScore(candidate) > 0.5) {
          allNamesOnPage.push(candidate);
        }
      }
      // Also scan for lowercase-first names ("kashish Adwani")
      const mixedRegex = /\b([a-z][a-z]{2,20}\s+[A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{0,20})?)\b/g;
      let mx;
      while ((mx = mixedRegex.exec(body)) !== null) {
        const candidate = mx[1].trim();
        if (nameScore(candidate) > 0.5) allNamesOnPage.push(candidate);
      }
    }

    // Deduplicate (case-insensitive), keep highest score first
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

  // Signal 3: token-set overlap with FRAGMENT-AWARE matching
  // "al am" fragments from OCR will still match "alam" via concat check
  const tokens1 = n1.split(/\s+/).filter(t => t.length >= 2);
  const tokens2 = n2.split(/\s+/).filter(t => t.length >= 2);

  // Also build a "joined" version of each side for fragment matching
  // e.g. n1 = "ayaz al am" → joined1 = "ayazalam", n2 = "ayaz alam" → joined2 = "ayazalam"
  const joined1 = tokens1.join('');
  const joined2 = tokens2.join('');
  const joinedSim = stringSimilarity.compareTwoStrings(joined1, joined2);

  function tokenMatch(t1, t2arr) {
    // Direct fuzzy match
    if (t2arr.some(t2 => stringSimilarity.compareTwoStrings(t1, t2) >= 0.82)) return true;
    // Fragment match: t1 might be a broken piece of a t2 token ("al" is in "alam")
    if (t1.length >= 2 && t2arr.some(t2 => t2.includes(t1) || t1.includes(t2))) return true;
    return false;
  }

  const matchedTokens = tokens1.filter(t1 => tokenMatch(t1, tokens2));
  const tokenOverlap = tokens1.length > 0 ? matchedTokens.length / tokens1.length : 0;

  // Signal 4: last-name comparison
  let lastNameSim = 0;
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    const lastT1 = tokens1[tokens1.length - 1];
    const lastT2 = tokens2[tokens2.length - 1];
    // Also check joined-last: "al am" last="am", target "alam" → joined check
    lastNameSim = Math.max(
      stringSimilarity.compareTwoStrings(lastT1, lastT2),
      stringSimilarity.compareTwoStrings(joined1.slice(-4), joined2.slice(-4))
    );
  }

  // Signal 5: full joined-token similarity (catches "ayazalam" ≈ "ayazalam")
  // This specifically rescues OCR-fragmented names
  const joinedBonus = joinedSim >= 0.90 ? joinedSim : 0;

  // Composite: first-name 40%, full 15%, token-overlap 20%, last-name 10%, joined 15%
  const composite = (firstNameSim * 0.40) + (fullSim * 0.15) + (tokenOverlap * 0.20)
                  + (lastNameSim * 0.10) + (joinedBonus * 0.15);

  // Rule: first name exact match → floor at 0.85 (→ REAL)
  if (firstNameExact && composite < 0.85) return 0.85;

  // Rule: joined tokens highly similar (≥0.90) → floor at 0.88
  // Catches "ayaz al am" vs "ayaz alam" even without first-name exact match
  if (joinedSim >= 0.90 && composite < 0.88) return 0.88;

  // Rule: ALL cert tokens found → floor at 0.90
  if (tokens1.length >= 2 && matchedTokens.length === tokens1.length && composite < 0.90) return 0.90;

  return Math.min(composite, 1.0);
}

// ─── COMPARE CERT NAME AGAINST POOL OF NAMES FROM VERIFICATION PAGE ──────────
// Returns { bestMatch, cleanedMatch, similarity, topCandidates }
function findBestMatch(certName, namesPool) {
  if (!certName || !namesPool || namesPool.length === 0) {
    return { bestMatch: null, cleanedMatch: null, similarity: 0, topCandidates: [] };
  }

  // Repair and clean the cert name before matching
  const repairedCert  = repairOCRText(certName);
  const cleanedCert   = cleanName(repairedCert);

  const scored = namesPool.map(candidate => {
    const cleanedCandidate = cleanName(candidate);
    const sim = compareNames(cleanedCert, cleanedCandidate);
    return { bestMatch: candidate, cleanedMatch: cleanedCandidate, similarity: sim };
  });

  scored.sort((a, b) => b.similarity - a.similarity);

  const best = scored[0] || { bestMatch: null, cleanedMatch: null, similarity: 0 };
  return {
    ...best,
    topCandidates: scored.slice(0, 5).map(s => ({ name: s.cleanedMatch, score: s.similarity })),
    repairedCertName: cleanedCert,
  };
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
      if (rawText.length < 50) {
        result.reasons.push('PDF appears to be image-based; OCR not applied to embedded images in this demo');
      }
    } else if (file.mimetype.startsWith('image/')) {
      rawText = await extractTextFromImage(file.buffer);
    } else {
      throw new Error(`Unsupported file type: ${file.mimetype}. Expected PDF or image.`);
    }

    result.extractedText = rawText.slice(0, 1000); // Preview first 1000 chars

    if (!rawText || rawText.length < 20) {
      result.reasons.push('Could not extract sufficient text');
      result.status = 'SUSPICIOUS';
      result.confidence = 0.1;
      return result;
    }

    // ── STEP 2: NAME DETECTION ────────────────────────────────────────────────
    // Try 3 text variants: repaired, original, and line-rejoined version
    const repairedText = repairOCRText(rawText);

    // Variant 3: aggressively rejoin very short lines (handles char-by-char PDFs)
    const rejoinedText = rawText.split('\n')
      .reduce((acc, line) => {
        const t = line.trim();
        if (!t) return acc + '\n';
        const last = acc.split('\n').pop() || '';
        // If current line is very short AND last line is also short, merge them
        if (t.length <= 4 && last.length <= 20) return acc + ' ' + t;
        return acc + '\n' + t;
      }, '');

    result.detectedName =
      detectNames(repairedText) ||
      detectNames(rawText) ||
      detectNames(rejoinedText);

    if (!result.detectedName) {
      result.reasons.push('⚠️ No human name detected — certificate text may be image-only or heavily stylised');
    } else {
      result.detectedName = cleanName(result.detectedName);
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
        const matchResult = findBestMatch(result.detectedName, result.allNamesOnPage);
        const { bestMatch, cleanedMatch, similarity, repairedCertName, topCandidates } = matchResult;

        // Always show clean names in the UI — no raw OCR fragments
        result.verifiedName  = cleanedMatch || bestMatch;
        result.detectedName  = repairedCertName || cleanName(result.detectedName);
        result.similarity    = similarity;
        result.topCandidates = topCandidates || [];

        const fn1 = firstName(result.detectedName);
        const fn2 = firstName(result.verifiedName || '');
        const firstNameMatched = fn1 && fn2 && fn1 === fn2;

        if (similarity >= 0.80) {
          result.status = 'REAL';
          result.confidence = Math.min(similarity, 1.0);
          const matchDetail = firstNameMatched
            ? `first name "${fn1}" matched exactly`
            : `${(similarity * 100).toFixed(0)}% similarity`;
          result.reasons.push(`✅ Name verified: "${result.detectedName}" → "${result.verifiedName}" (${matchDetail})`);
        } else if (similarity >= 0.50) {
          result.status = 'SUSPICIOUS';
          result.confidence = similarity * 0.7;
          result.reasons.push(`⚠️ Partial match (${(similarity * 100).toFixed(0)}%): cert says "${result.detectedName}", page shows "${result.verifiedName}" — manual review recommended`);
        } else {
          // LOW MATCH: do NOT show the random near-match name — that's misleading
          // Instead, show "Not found on verification page"
          result.status = 'FAKE';
          result.confidence = parseFloat((1 - similarity).toFixed(2));
          result.verifiedName = null;  // ← clear the random low-match name
          result.reasons.push(`❌ Name "${result.detectedName}" was NOT found on the verification page (best match was only ${(similarity*100).toFixed(0)}% similar)`);
        }
      } else if (result.detectedName && (!result.allNamesOnPage || result.allNamesOnPage.length === 0)) {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.35;
        result.verifiedName = null;
        result.reasons.push('⚠️ Verification link loaded but no names could be extracted from the page');
      } else if (!result.detectedName && result.allNamesOnPage && result.allNamesOnPage.length > 0) {
        // Try to derive name hint from the filename (e.g. "kashish_adwani_cert.pdf" → "Kashish Adwani")
        const fileNameHint = result.fileName
          .replace(/\.[^.]+$/, '')       // remove extension
          .replace(/[_\-\.]+/g, ' ')    // replace separators with spaces
          .replace(/\d+/g, ' ')          // remove numbers
          .replace(/\b(cert|certificate|coursera|udemy|ir|pdf|doc)\b/gi, '')
          .replace(/\s+/g, ' ').trim();
        const hintName = extractNameFromPhrase(fileNameHint) || null;

        if (hintName) {
          // Use filename-derived name as fallback detected name
          result.detectedName = cleanName(hintName);
          result.reasons.push(`ℹ️ Name inferred from filename: "${result.detectedName}"`);
          const { bestMatch, cleanedMatch, similarity } = findBestMatch(result.detectedName, result.allNamesOnPage);
          if (similarity >= 0.80) {
            result.verifiedName = cleanedMatch || bestMatch;
            result.status = 'REAL';
            result.confidence = Math.min(similarity, 1.0);
            result.similarity = similarity;
            result.reasons.push(`✅ Filename-derived name "${result.detectedName}" matched page name "${result.verifiedName}" (${(similarity*100).toFixed(0)}%)`);
          } else {
            result.status = 'SUSPICIOUS';
            result.confidence = 0.40;
            result.verifiedName = null;
            result.reasons.push('⚠️ Could not extract name from certificate text; filename hint did not match verification page');
          }
        } else {
          result.status = 'SUSPICIOUS';
          result.confidence = 0.4;
          result.verifiedName = null;
          result.reasons.push('⚠️ Could not extract recipient name from certificate text — certificate may be image-only');
        }
      } else {
        result.status = 'SUSPICIOUS';
        result.confidence = 0.3;
        result.verifiedName = null;
        result.reasons.push('⚠️ Verification page found but no names could be compared on either side');
      }
    } else {
      // ── NO URL / QR FOUND ──────────────────────────────────────────────────
      // Show clearly that the cert is unverifiable — not just "suspicious"
      result.status = 'SUSPICIOUS';
      result.confidence = 0.20;
      result.verifiedName = null;
      // Replace generic reason with specific "no link/QR" message
      result.reasons = result.reasons.filter(r => !r.includes('No QR code or verification URL'));
      result.reasons.push('⚠️ No QR code or verification link found on this certificate — authenticity cannot be confirmed');
    }

  } catch (err) {
    result.status = 'ERROR';
    result.confidence = 0;
    result.reasons.push(`Processing error: ${err.message}`);
  }

  return result;
}

// ─── API ENDPOINTS ────────────────────────────────────────────────────────────
const handleVerifyCertificates = async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const results = await Promise.all(req.files.map(f => verifyCertificate(f)));
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/verify-certificates', upload.array('certificates', 10), handleVerifyCertificates);
app.post('/verify-certificates', upload.array('certificates', 10), handleVerifyCertificates);



const handleVerifyDriveLink = async (req, res) => {
  const { url } = req.body || {};
  if (!url?.trim().startsWith('http')) return res.status(400).json({ error: 'Missing or invalid URL' });

  let fileBuffer, mimeType, fileName;
  try {
    if (isGoogleDriveUrl(url.trim())) {
      const dl = await downloadFromDrive(url.trim());
      fileBuffer = dl.buffer; mimeType = dl.mimeType; fileName = `drive-${dl.fileId}`;
    } else {
      const resp = await axios.get(url.trim(), {
        responseType: 'arraybuffer', timeout: 20000,
        headers: { 'User-Agent': 'CertVerify/2.0' }, validateStatus: s => s < 500,
      });
      mimeType   = (resp.headers['content-type'] || '').split(';')[0].trim();
      fileBuffer = Buffer.from(resp.data);
      if (mimeType.includes('octet-stream')) {
        if (fileBuffer.length > 4 && fileBuffer.slice(0, 4).toString() === '%PDF') mimeType = 'application/pdf';
        else mimeType = 'image/jpeg';
      }
      fileName   = url.trim().split('/').pop().split('?')[0] || 'certificate';
    }
  } catch (err) { return res.status(422).json({ error: `Failed to download: ${err.message}` }); }

  try {
    const file = { buffer: fileBuffer, mimetype: mimeType, originalname: fileName, size: fileBuffer.length };
    const result = await verifyCertificate(file, { sourceLabel: `drive:${url.trim()}` });
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

app.post('/api/verify-drive-link', handleVerifyDriveLink);
app.post('/verify-drive-link', handleVerifyDriveLink);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'CertVerify API running' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ CertVerify backend running on http://localhost:${PORT}`));