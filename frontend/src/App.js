import React, { useState } from 'react';
import { ShieldCheck, History, Upload, Link as LinkIcon, Loader2, Download, CheckCircle, AlertTriangle, XCircle, ExternalLink, Info } from 'lucide-react';
import axios from 'axios';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000/api';

export default function App() {
  const [driveUrl, setDriveUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);

  const handleDriveSubmit = async (e) => {
    e.preventDefault();
    if (!driveUrl) return;
    setLoading(true); setError(null);
    try {
      const res = await axios.post(`${API_URL}/verify-drive-link`, { url: driveUrl });
      setSession(res.data.session || { ...res.data, timestamp: new Date().toISOString() });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (event) => {
    const files = event.target.files;
    if (!files.length) return;
    setLoading(true); setError(null);
    
    const formData = new FormData();
    Array.from(files).forEach(f => formData.append('certificates', f));

    try {
      const res = await axios.post(`${API_URL}/verify-certificates`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSession(res.data.session || { ...res.data, timestamp: new Date().toISOString() });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status) => {
    if (status === 'REAL') return <CheckCircle size={20} />;
    if (status === 'SUSPICIOUS') return <AlertTriangle size={20} />;
    if (status === 'FAKE') return <XCircle size={20} />;
    return <Info size={20} />;
  };

  return (
    <div className="layout-container">
      <header className="header">
        <div className="logo" onClick={() => setSession(null)} style={{ cursor: 'pointer' }}>
          <ShieldCheck size={32} />
          <span style={{ background: 'linear-gradient(to right, #3b82f6, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 'bold', fontSize: '1.6rem' }}>CertVerify</span>
        </div>
      </header>

      <main>
        {!session ? (
          <div className="home-container" style={{ animation: 'fadeIn 0.5s ease-out', paddingTop: '8vh' }}>

            {error && (
              <div style={{ background: 'var(--status-fake-bg)', color: 'var(--status-fake)', padding: '16px', borderRadius: '8px', marginBottom: '24px', border: '1px solid var(--status-fake)', textAlign: 'center' }}>
                {error}
              </div>
            )}

            {loading && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', margin: '40px 0', color: 'var(--accent-primary)' }}>
                <Loader2 size={48} className="animate-spin" />
                <p style={{ marginTop: '16px', fontWeight: '500' }}>Processing your request... This might take a moment.</p>
              </div>
            )}

            {!loading && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
                


                {/* Drive Link */}
                <div className="glass-panel hover-lift">
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ background: 'rgba(139, 92, 246, 0.1)', width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: 'var(--accent-secondary)' }}>
                      <LinkIcon size={32} />
                    </div>
                    <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Drive Link Verification</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '16px' }}>Paste a public Google Drive or direct file link.</p>
                  </div>
                  <form onSubmit={handleDriveSubmit} style={{ display: 'flex', gap: '8px' }}>
                    <input 
                      type="url" 
                      placeholder="https://drive.google.com/..." 
                      value={driveUrl}
                      onChange={(e) => setDriveUrl(e.target.value)}
                      required
                      style={{ flex: 1, padding: '10px 16px', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--glass-border)', color: 'white' }}
                    />
                    <button type="submit" className="btn-primary">Verify</button>
                  </form>
                </div>

                {/* Batch Upload */}
                <div className="glass-panel hover-lift" style={{ position: 'relative', cursor: 'pointer', textAlign: 'center' }}>
                  <input 
                    type="file" 
                    accept=".pdf,image/*" 
                    multiple
                    onChange={handleFileUpload}
                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                    title="Upload Certificates"
                  />
                  <div style={{ background: 'rgba(16, 185, 129, 0.1)', width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: 'var(--status-real)' }}>
                    <Upload size={32} />
                  </div>
                  <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Batch Certificates</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Upload up to 10 certificates (PDF, JPG, PNG) at once for verification.</p>
                </div>

              </div>
            )}
          </div>
        ) : (
          <div style={{ animation: 'fadeIn 0.5s ease-out' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '8px' }}>Verification Report</h2>
                <p style={{ color: 'var(--text-secondary)' }}>
                  {session.sessionId && `Session ID: ${session.sessionId} • `} 
                  {new Date(session.timestamp).toLocaleString()}
                </p>
              </div>
              <button onClick={() => setSession(null)} className="btn-secondary">
                Verify Another
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '32px' }}>
              <div className="glass-panel" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>{session.count || (session.results ? session.results.length : 1)}</div>
                <div style={{ color: 'var(--text-secondary)' }}>Total Processed</div>
              </div>
            </div>

            <h3 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>Detailed Results</h3>
            <div style={{ display: 'grid', gap: '16px' }}>
              {(session.results || [session.result]).filter(Boolean).map((result, i) => (
                <div key={i} className="glass-panel" style={{ position: 'relative', overflow: 'hidden' }}>
                  <div style={{ 
                    position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px',
                    background: result.status === 'REAL' ? 'var(--status-real)' : result.status === 'SUSPICIOUS' ? 'var(--status-suspicious)' : result.status === 'FAKE' ? 'var(--status-fake)' : 'var(--status-error)'
                  }} />
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                    <div>
                      <h4 style={{ fontSize: '1.25rem', marginBottom: '4px' }}>{result.fileName || result.originalname || `Certificate ${i+1}`}</h4>
                      {result.platform && <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Platform: {result.platform}</span>}
                    </div>
                    <span className={`status-badge ${result.status?.toLowerCase() || 'error'}`}>
                      {getStatusIcon(result.status)} 
                      <span style={{ marginLeft: '4px' }}>
                        {result.status === 'REAL' ? 'Authentic' : result.status === 'FAKE' ? 'Fraudulent' : 'Suspicious'} 
                        {result.confidence !== undefined && ` (${(result.confidence * 100).toFixed(0)}%)`}
                      </span>
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
                    <div>
                      <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '0.875rem' }}>Detected Name</span>
                      <strong>{result.detectedName || 'Unknown'}</strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '0.875rem' }}>Verified Name (Source)</span>
                      {result.verifiedName ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong>{result.verifiedName}</strong>
                          {result.verificationUrl && (
                            <a href={result.verificationUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>
                              <ExternalLink size={14} />
                            </a>
                          )}
                        </div>
                      ) : 'Not found'}
                    </div>
                  </div>

                  {result.reasons && result.reasons.length > 0 && (
                    <div>
                      <h5 style={{ fontSize: '1rem', marginBottom: '8px', color: 'var(--text-secondary)' }}>Analysis Log</h5>
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {result.reasons.map((reason, idx) => (
                          <li key={idx} style={{ marginBottom: '4px', fontSize: '0.875rem', display: 'flex', gap: '8px' }}>
                            <span style={{ color: 'var(--accent-secondary)' }}>•</span> {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}