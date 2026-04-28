import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import Papa from 'papaparse';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  REAL:       { label: 'AUTHENTIC',   emoji: '✅', cls: 'real',       bg: '#0d2e1a', border: '#22c55e', text: '#4ade80' },
  FAKE:       { label: 'FRAUDULENT',  emoji: '❌', cls: 'fake',       bg: '#2e0d0d', border: '#ef4444', text: '#f87171' },
  SUSPICIOUS: { label: 'SUSPICIOUS',  emoji: '⚠️', cls: 'suspicious', bg: '#2e200d', border: '#f59e0b', text: '#fbbf24' },
  ERROR:      { label: 'ERROR',       emoji: '🔴', cls: 'error',      bg: '#1e1e1e', border: '#6b7280', text: '#9ca3af' },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function ConfidenceBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div className="conf-bar-wrap">
      <div className="conf-bar-track">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="conf-label" style={{ color }}>{pct}%</span>
    </div>
  );
}

function FileIcon({ type }) {
  return type === 'application/pdf'
    ? <span className="file-icon pdf">PDF</span>
    : <span className="file-icon img">IMG</span>;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [files, setFiles]       = useState([]);
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState(null);

  const onDrop = useCallback((accepted) => {
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size));
      const fresh = accepted.filter(f => !existing.has(f.name + f.size));
      return [...prev, ...fresh].slice(0, 10);
    });
    setError(null);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': ['.jpg','.jpeg','.png','.webp'], 'application/pdf': ['.pdf'] },
    maxSize: 20 * 1024 * 1024,
    maxFiles: 10,
  });

  const removeFile = (name) => setFiles(f => f.filter(x => x.name !== name));

  const handleVerify = async () => {
    if (!files.length) return;
    setLoading(true);
    setResults([]);
    setError(null);
    setProgress(0);

    const formData = new FormData();
    files.forEach(f => formData.append('certificates', f));

    try {
      const res = await axios.post(`${API_URL}/verify-certificates`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: e => setProgress(Math.round((e.loaded / e.total) * 40)),
      });
      setProgress(100);
      setResults(res.data.results || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setFiles([]);
    setResults([]);
    setError(null);
    setProgress(0);
    setExpanded(null);
  };

  const exportCSV = () => {
    const rows = results.map(r => ({
      'File Name':       r.fileName,
      'Detected Name':   r.detectedName || '—',
      'Verified Name':   r.verifiedName || '—',
      'Status':          r.status,
      'Confidence':      `${Math.round((r.confidence || 0) * 100)}%`,
      'Verification URL':r.verificationUrl || '—',
      'Reasons':         (r.reasons || []).join(' | '),
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `cert-verify-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const stats = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1; return acc;
  }, {});

  return (
    <div className="app">
      {/* ── HEADER ──────────────────────────────────────────── */}
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">🔐</span>
            <div>
              <h1>CertVerify</h1>
              <p>Stateless AI Certificate Verification</p>
            </div>
          </div>
          <div className="header-badges">
            <span className="badge">🧠 OCR + NLP</span>
            <span className="badge">🔍 QR Detection</span>
            <span className="badge">🕵️ Link Scraping</span>
            <span className="badge privacy">🔒 Zero Storage</span>
          </div>
        </div>
      </header>

      <main className="main">
        {results.length === 0 ? (
          /* ── UPLOAD VIEW ─────────────────────────────────── */
          <div className="upload-view">
            <div className="pipeline-row">
              {['Upload','OCR','NER','QR/URL','Scrape','Compare','Result'].map((s, i) => (
                <React.Fragment key={s}>
                  <div className="pipe-step"><span className="pipe-num">{i+1}</span>{s}</div>
                  {i < 6 && <div className="pipe-arrow">→</div>}
                </React.Fragment>
              ))}
            </div>

            {/* Dropzone */}
            <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''} ${files.length ? 'has-files' : ''}`}>
              <input {...getInputProps()} />
              {isDragActive ? (
                <div className="dz-hint">
                  <div className="dz-icon drop">⬇️</div>
                  <p>Drop certificates here…</p>
                </div>
              ) : files.length === 0 ? (
                <div className="dz-hint">
                  <div className="dz-icon">📄</div>
                  <p className="dz-main">Drag &amp; drop certificates here</p>
                  <p className="dz-sub">or click to browse — PDF, JPG, PNG, WEBP · max 10 files · 20 MB each</p>
                </div>
              ) : (
                <div className="file-list">
                  {files.map(f => (
                    <div key={f.name + f.size} className="file-chip">
                      <FileIcon type={f.type} />
                      <span className="file-name">{f.name}</span>
                      <span className="file-size">{(f.size/1024).toFixed(0)} KB</span>
                      <button className="remove-btn" onClick={e => { e.stopPropagation(); removeFile(f.name); }}>×</button>
                    </div>
                  ))}
                  <div className="dz-add-more">+ click or drop to add more</div>
                </div>
              )}
            </div>

            {error && <div className="error-box">⚠️ {error}</div>}

            {files.length > 0 && (
              <div className="action-row">
                <button className="btn-secondary" onClick={handleReset}>Clear All</button>
                <button className="btn-primary" onClick={handleVerify} disabled={loading}>
                  {loading ? <><span className="spinner" />Verifying {files.length} file{files.length>1?'s':''}…</> : `🔍 Verify ${files.length} Certificate${files.length>1?'s':''}`}
                </button>
              </div>
            )}

            {loading && (
              <div className="progress-wrap">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="progress-steps">
                  {['Uploading','OCR Extraction','Name Detection','URL Verification','Comparing'].map((s, i) => (
                    <span key={s} className={progress >= i*20+10 ? 'done' : ''}>{s}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── RESULTS VIEW ────────────────────────────────── */
          <div className="results-view">
            {/* Stats */}
            <div className="stats-row">
              <div className="stat-card total"><div className="stat-num">{results.length}</div><div className="stat-lbl">Total</div></div>
              {Object.entries(STATUS_CONFIG).map(([k, v]) => stats[k] ? (
                <div key={k} className={`stat-card ${v.cls}`} style={{ borderColor: v.border }}>
                  <div className="stat-num" style={{ color: v.text }}>{stats[k]}</div>
                  <div className="stat-lbl">{v.emoji} {v.label}</div>
                </div>
              ) : null)}
            </div>

            {/* Table */}
            <div className="table-wrap">
              <div className="table-header">
                <h2>Verification Results</h2>
                <div className="table-actions">
                  <button className="btn-sm" onClick={exportCSV}>⬇ Export CSV</button>
                  <button className="btn-sm danger" onClick={handleReset}>↩ New Batch</button>
                </div>
              </div>

              <table className="results-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Detected Name</th>
                    <th>Verified Name</th>
                    <th>Confidence</th>
                    <th>Status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const cfg = STATUS_CONFIG[r.status] || STATUS_CONFIG.ERROR;
                    const isOpen = expanded === i;
                    return (
                      <React.Fragment key={i}>
                        <tr className={`result-row ${cfg.cls}`}>
                          <td>
                            <div className="fname-cell">
                              <FileIcon type={r.mimeType} />
                              <span title={r.fileName}>{r.fileName.length > 28 ? r.fileName.slice(0,25)+'…' : r.fileName}</span>
                              <span className="fsize">{r.fileSize}</span>
                            </div>
                          </td>
                          <td><span className="name-pill">{r.detectedName || <em>not found</em>}</span></td>
                          <td>
                            {r.verifiedName
                              ? <span className="name-pill verified" title={r.verifiedName}>
                                  {(() => {
                                    const parts = r.verifiedName.trim().split(' ');
                                    return parts.length >= 2
                                      ? <>{parts[0]}{' '}<span style={{opacity:0.6,fontSize:'0.71rem'}}>{parts.slice(1).join(' ')}</span></>
                                      : r.verifiedName;
                                  })()}
                                </span>
                              : r.verificationUrl
                                ? <span className="name-pill" style={{borderColor:'rgba(245,158,11,0.4)',color:'#fbbf24',fontSize:'0.72rem'}}>⚠ Not found on page</span>
                                : <span className="name-pill" style={{borderColor:'rgba(100,116,139,0.4)',color:'#64748b',fontSize:'0.72rem'}}>— No link / QR</span>}
                          </td>
                          <td><ConfidenceBar value={r.confidence} /></td>
                          <td>
                            <span className="status-badge" style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.text }}>
                              {cfg.emoji} {cfg.label}
                            </span>
                          </td>
                          <td>
                            <button className="expand-btn" onClick={() => setExpanded(isOpen ? null : i)}>
                              {isOpen ? '▲ Hide' : '▼ Show'}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="detail-row">
                            <td colSpan={6}>
                              <div className="detail-panel">
                                <div className="detail-grid">
                                  <div className="detail-section">
                                    <h4>🔍 Analysis</h4>
                                    <ul>{(r.reasons||[]).map((reason,j) => <li key={j}>{reason}</li>)}</ul>
                                  </div>
                                  {r.verificationUrl && (
                                    <div className="detail-section">
                                      <h4>🔗 Verification URL</h4>
                                      <a href={r.verificationUrl} target="_blank" rel="noopener noreferrer" className="url-link">
                                        {r.verificationUrl.length > 60 ? r.verificationUrl.slice(0,57)+'…' : r.verificationUrl}
                                      </a>
                                      {r.pageTitle && <p className="page-title">Page: "{r.pageTitle}"</p>}
                                      {r.scrapeMethod && <p className="page-title">Method: {r.scrapeMethod}</p>}
                                      {r.allNamesOnPage && r.allNamesOnPage.length > 0 && (
                                        <div style={{marginTop:'8px'}}>
                                          <p style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:'4px'}}>Names found on page:</p>
                                          <div style={{display:'flex',flexWrap:'wrap',gap:'4px'}}>
                                            {r.allNamesOnPage.slice(0,8).map((n,i) => (
                                              <span key={i} style={{
                                                fontFamily:'var(--mono)',fontSize:'0.7rem',padding:'2px 7px',
                                                borderRadius:'12px',background:'var(--bg)',border:'1px solid var(--border)',
                                                color: n === r.verifiedName ? '#4ade80' : 'var(--muted)'
                                              }}>{n}</span>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {r.qrContent && (
                                    <div className="detail-section">
                                      <h4>📱 QR Content</h4>
                                      <code className="qr-code">{r.qrContent}</code>
                                    </div>
                                  )}
                                  {r.extractedText && (
                                    <div className="detail-section full">
                                      <h4>📄 OCR Text Preview</h4>
                                      <pre className="ocr-preview">{r.extractedText.slice(0,500)}{r.extractedText.length>500?'\n…':''}</pre>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="privacy-note">
              🔒 All data was processed in-memory only. No files were stored. Results exist only in this browser session.
            </p>
          </div>
        )}
      </main>

      <footer className="footer">
        <p>CertVerify — Stateless AI Certificate Verification Pipeline &nbsp;·&nbsp; OCR · NER · QR · Scraping · Fuzzy Matching</p>
      </footer>
    </div>
  );
}