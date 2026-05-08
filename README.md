# 🚀 CertVerify — AI-Powered Certificate Verification Platform

An intelligent full-stack certificate verification system that validates uploaded certificates using OCR, QR/Link verification, web scraping, and AI-assisted name matching.

check it out - https://cert-verify-three.vercel.app/

---

# 📌 Overview

CertVerify is designed to detect whether an uploaded certificate is:

* ✅ REAL
* ⚠️ SUSPICIOUS
* ❌ FAKE

The system processes PDFs and images in real-time using:

* OCR text extraction
* QR code detection
* Verification link scraping
* Name comparison engine
* AI-assisted confidence scoring

The project supports:

* PDF certificates
* Screenshot-based PDFs
* Image certificates
* QR-based verification
* Verification-page matching

---

# ✨ Features

## 🔍 OCR-Based Text Extraction

* Extracts text from:

  * PDFs
  * JPG / PNG images
  * Screenshot-based PDFs
* Uses Tesseract OCR
* Repairs broken OCR text automatically

---

## 🧠 Intelligent Name Detection

The system identifies certificate holder names using:

* Sentence pattern detection
* Context-based scanning
* Standalone name extraction
* Keyword filtering
* OCR repair logic

Example:

```text
John Doe has successfully completed
```

---

## 🔗 QR & Verification Link Detection

Automatically extracts:

* QR codes
* Verification URLs

Example:

```text
https://coursera.org/verify/ABC123
```

---

## 🌐 Verification Page Scraping

Supports verification scraping from:

* Coursera
* AWS
* edX
* LinkedIn Learning
* Other certificate platforms

The backend extracts verified names and compares them against OCR-detected names.

---

## ⚡ AI-Assisted Comparison Engine

Uses a multi-signal scoring system:

* First-name similarity
* Full-name similarity
* Last-name similarity
* Token overlap scoring
* OCR-repair matching

---

## 📄 Screenshot-PDF Recovery

Supports certificates that are:

* screenshots
* scanned images
* image-based PDFs

Pipeline:

```text
PDF → Image Rendering → OCR → Verification
```

---

## 🔐 Authentication & Database Support

Advanced version includes:

* Google OAuth Login
* Verification history
* Saved reports
* User dashboard

Powered by Supabase.

---

# 🏗️ System Architecture

```text
Frontend (React)
        ↓
Node.js Backend API
        ↓
OCR + NLP Processing
        ↓
QR / Link Extraction
        ↓
Verification Page Scraping
        ↓
AI Comparison Engine
        ↓
Verification Result
```

---

# 🛠️ Tech Stack

## Frontend

* React.js
* CSS3
* Axios
* PapaParse

## Backend

* Node.js
* Express.js
* Multer
* Tesseract.js
* pdf-parse
* jsQR
* Axios
* Cheerio
* string-similarity

## Authentication & Database

* Supabase
* Google OAuth
* PostgreSQL

## Deployment

* Vercel (Frontend)
* Render / Railway (Backend)
* Docker

---

# 📂 Project Structure

```text
cert-verify/
│
├── backend/
│   ├── server.js
│   ├── Dockerfile
│   ├── package.json
│   └── setup.js
│
├── frontend/
│   ├── src/
│   │   ├── App.js
│   │   └── App.css
│   ├── public/
│   └── package.json
│
└── README.md
```

---

# ⚙️ Installation

## 1️⃣ Clone Repository

```bash
git clone https://github.com/your-username/cert-verify.git
cd cert-verify
```

---

# 🖥️ Backend Setup

## Install Dependencies

```bash
cd backend
npm install
```

## Install System Dependencies

### Ubuntu/Debian

```bash
sudo apt-get install -y poppler-utils ghostscript tesseract-ocr
```

### macOS

```bash
brew install poppler ghostscript tesseract
```

---

## Start Backend

```bash
npm start
```

Backend runs on:

```text
http://localhost:4000
```

---

# 💻 Frontend Setup

## Install Dependencies

```bash
cd frontend
npm install
```

## Start Frontend

```bash
npm start
```

Frontend runs on:

```text
http://localhost:3000
```

---

# 🌍 Environment Variables

## Frontend (.env)

```env
REACT_APP_API_URL=http://localhost:4000
```

---

## Backend (.env)

```env
PORT=4000
FRONTEND_URL=http://localhost:3000
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
```

---

# 🧪 API Endpoint

## Verify Certificates

```http
POST /verify-certificates
```

Accepts:

* PDF files
* JPG / PNG images

Returns:

```json
[
  {
    "fileName": "certificate.pdf",
    "detectedName": "John Doe",
    "verifiedName": "John Doe",
    "status": "REAL",
    "confidence": 0.94
  }
]
```

---

# 🚀 Deployment

## Frontend

Deploy on:

* Vercel

---

## Backend

Deploy on:

* Render
* Railway

Backend uses Docker for OCR dependencies.

---

# 🐳 Docker Support

Backend includes:

* Dockerfile
* .dockerignore

Supports:

* Poppler
* Ghostscript
* Tesseract OCR

---

# 🔥 Future Improvements

* AI fraud detection
* Certificate tampering detection
* Platform-specific verification adapters
* Queue-based OCR workers
* Email reporting system
* Admin analytics dashboard
* ML-based NER models

---

# 🎯 Learning Outcomes

This project demonstrates:

* Full-stack development
* OCR pipelines
* AI-assisted document verification
* PDF & image processing
* QR code extraction
* Web scraping
* Authentication systems
* Database integration
* Docker deployment
* Cloud deployment

---

# 👨‍💻 Author

## Sameer Kumar

B.Tech Information Technology

Skills:

* MERN Stack
* OCR & AI Integration
* Full-Stack Development
* Cloud Deployment
* Database Systems

---

# ⭐ Support

If you like this project:

* ⭐ Star the repository
* 🍴 Fork the project
* 🛠️ Contribute improvements

---

# 📜 License

This project is licensed under the MIT License.
