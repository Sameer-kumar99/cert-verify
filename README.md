# 🔐 CertVerify — Stateless AI Certificate Verification Tool

> **"A stateless AI-powered certificate verification tool that processes documents in real-time without storing user data, ensuring privacy and scalability."**

---

## 🏗️ Architecture

```
React Frontend (Port 3000)
        ↓  multipart/form-data
Node.js + Express Backend (Port 4000)
        ↓
┌────────────────────────────────────────────────────┐
│              AI PROCESSING PIPELINE                │
│                                                    │
│  1. FILE INGESTION     multer (memory only)        │
│  2. OCR                tesseract.js (text/image)   │
│         or             pdf-parse (PDFs)            │
│  3. NAME DETECTION     Custom NER (regex + filter) │
│  4. QR DECODING        jsQR                        │
│  5. URL EXTRACTION     Regex pattern matching      │
│  6. LINK SCRAPING      axios + cheerio             │
│  7. COMPARISON         string-similarity (fuzzy)   │
│  8. RESULT ASSEMBLY    JSON response               │
└────────────────────────────────────────────────────┘
        ↓  JSON
React Dashboard (state-only, no persistence)
```

**❌ No database. ❌ No disk writes. ✅ Everything lives in request memory.**

---

## ⚡ Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### Installation

```bash
# Clone / enter project
cd cert-verify

# Install all dependencies
npm run install:all

# Start backend (port 4000)
npm run start:backend

# In another terminal — start frontend (port 3000)
npm run start:frontend
```

Or run both at once (requires concurrently):
```bash
npm install && npm run dev
```

---

## 📁 Project Structure

```
cert-verify/
├── backend/
│   ├── server.js          # Express API + full pipeline
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── App.js         # Main React UI
│   │   ├── App.css        # Styles
│   │   └── index.js       # Entry point
│   └── package.json
├── package.json           # Root scripts
└── README.md
```

---

## 🔌 API Reference

### `POST /verify-certificates`

Upload one or more certificate files for verification.

**Request:** `multipart/form-data`
- Field: `certificates` (multiple files allowed, max 10)
- Supported: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.webp`
- Max size: 20 MB per file

**Response:**
```json
{
  "success": true,
  "count": 2,
  "results": [
    {
      "fileName": "cert1.pdf",
      "fileSize": "124.5 KB",
      "mimeType": "application/pdf",
      "extractedText": "Coursera\nJohn Doe\nMachine Learning...",
      "detectedName": "John Doe",
      "qrContent": "https://coursera.org/verify/ABC123",
      "verificationUrl": "https://coursera.org/verify/ABC123",
      "verifiedName": "John Doe",
      "pageTitle": "John Doe's Certificate - Coursera",
      "similarity": 0.95,
      "status": "REAL",
      "confidence": 0.95,
      "reasons": [
        "QR code found with verification URL",
        "Names match with 95% similarity"
      ]
    }
  ]
}
```

**Status values:**
| Status | Meaning |
|--------|---------|
| `REAL` | Names match ≥80% via verified URL |
| `FAKE` | Names mismatch on verified URL |
| `SUSPICIOUS` | No URL/QR found, or partial match |
| `ERROR` | Processing failure |

### `GET /health`
Health check endpoint.

---

## 🧠 Pipeline Deep Dive

### Phase 1 — OCR
- **Images**: Tesseract.js (local OCR, no API needed)
- **PDFs**: pdf-parse (extracts embedded text layer)
- Falls back to "insufficient text" warning if extraction fails

### Phase 2 — Name Detection (NER-lite)
Regex-based named entity recognition:
1. Scans each line for `2–4 consecutive Capitalized Words`
2. Filters against 80+ certificate keywords (Coursera, Certificate, University, etc.)
3. Rejects all-caps strings (headers/titles)
4. Scores by word count (2–3 word names score highest)
5. Returns top candidate

### Phase 3 — QR Detection
- Uses `jsQR` to scan image pixel data
- If QR content is a URL → used as verification link

### Phase 4 — URL Extraction
- Regex scans raw OCR text for `http://` / `https://` URLs
- Falls back to text URLs if no QR code

### Phase 5 — Link Scraping
- Fetches verification URL with realistic browser headers
- Tries 10+ CSS selectors (`.name`, `.recipient`, `h1`, etc.)
- Falls back to full body NER scan

### Phase 6 — Fuzzy Comparison
- Uses `string-similarity` (Dice coefficient)
- `≥ 0.80` → REAL
- `0.50–0.79` → SUSPICIOUS
- `< 0.50` → FAKE

---

## 🎨 Frontend Features

- **Drag & Drop** file upload (react-dropzone)
- **Live progress bar** with pipeline stage labels
- **Color-coded results**: 🟢 Real / 🔴 Fake / 🟡 Suspicious
- **Confidence bars** per certificate
- **Expandable detail rows** with OCR preview, reasons, URLs
- **CSV export** (PapaParse, client-side)
- **Zero persistence** — reload = clean slate

---

## ⚠️ Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| No QR / No URL | Status → SUSPICIOUS |
| OCR extracts no text | Status → SUSPICIOUS + warning |
| Scraping blocked/timeout | Status → SUSPICIOUS + error note |
| PDF is image-based | Warning shown, text OCR skipped |
| Name not on verification page | Status → SUSPICIOUS |
| Partial name match (50–79%) | Status → SUSPICIOUS + manual review note |

---

## 🔒 Privacy Model

- All files processed entirely in-memory (`multer.memoryStorage()`)
- No files written to disk at any point
- No database — no records stored
- Frontend state is ephemeral — browser refresh = clean slate
- Network requests only to verification URLs extracted from the certificates themselves

---

## 🚀 Deployment

### Docker (recommended)

```dockerfile
# Backend Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
EXPOSE 4000
CMD ["node", "server.js"]
```

### Environment Variables

```bash
# Backend
PORT=4000                          # API port (default: 4000)

# Frontend
REACT_APP_API_URL=http://localhost:4000   # Backend URL
```

---

## 🔧 Extending the Pipeline

### Upgrade OCR
Replace Tesseract.js with Hugging Face TrOCR for better handwriting:
```javascript
// backend/server.js - replace extractTextFromImage()
const { pipeline } = require('@xenova/transformers');
const ocr = await pipeline('image-to-text', 'microsoft/trocr-base-printed');
```

### Add Puppeteer for JS-rendered pages
```bash
npm install puppeteer-extra puppeteer-extra-plugin-stealth
```
```javascript
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
```

### Add Confidence Score Frontend Export
The `confidence` field (0–1) is already in every result object and displayed in the UI.

---

## 📊 Interview Talking Points

- **Stateless design**: No DB = no latency, no GDPR risk
- **Pipeline architecture**: Each phase is decoupled and independently replaceable
- **Privacy by default**: Zero-storage approach — files never touch disk
- **Graceful degradation**: Every failure mode has a fallback status
- **Scalable**: Stateless = horizontally scalable, no session affinity needed
