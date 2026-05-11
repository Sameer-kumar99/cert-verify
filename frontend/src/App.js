import React, { useState, useCallback } from 'react';
import axios from 'axios';
import { useDropzone } from 'react-dropzone';

const API_BASE = 'http://localhost:4000';

function App() {
  const [view, setView] = useState('home'); // 'home', 'report'
  const [loading, setLoading] = useState(false);
  const [driveUrl, setDriveUrl] = useState('');
  const [reportData, setReportData] = useState(null);
  const [error, setError] = useState('');

  const handleVerifyDriveLink = async () => {
    if (!driveUrl) return;
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(`${API_BASE}/api/verify-drive-link`, { url: driveUrl });
      setReportData({
        isBatch: false,
        results: [res.data.result],
        timestamp: new Date().toLocaleString()
      });
      setView('report');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return;
    setLoading(true);
    setError('');
    
    const formData = new FormData();
    acceptedFiles.forEach(file => {
      formData.append('certificates', file);
    });

    try {
      const res = await axios.post(`${API_BASE}/api/verify-certificates`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setReportData({
        isBatch: acceptedFiles.length > 1,
        results: res.data.results,
        timestamp: new Date().toLocaleString()
      });
      setView('report');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/jpeg': [],
      'image/png': [],
      'application/pdf': []
    },
    maxFiles: 10
  });

  const renderNav = () => (
    <header className="bg-surface/70 backdrop-blur-md border-b border-outline-variant shadow-sm sticky top-0 z-50">
      <div className="flex justify-between items-center w-full px-margin-x h-16 max-w-container-max mx-auto">
        <div className="text-title-sm font-display-lg font-bold text-primary flex items-center gap-2 cursor-pointer" onClick={() => setView('home')}>
          <span className="material-symbols-outlined text-primary" style={{fontVariationSettings: "'FILL' 1"}}>verified_user</span>
          CertVerify
        </div>

      </div>
    </header>
  );

  const renderHome = () => (
    <main className="flex-grow flex flex-col items-center justify-center px-4 py-stack-lg max-w-container-max mx-auto w-full">


      {error && <div className="mb-4 text-error bg-error-container/20 p-4 rounded-lg w-full max-w-2xl text-center border border-error/50">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter w-full">
        {/* Drive Link Verification Card */}
        <div className="glass-card rounded-xl p-stack-lg flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-stack-md">
            <span className="material-symbols-outlined text-primary text-4xl">link</span>
          </div>
          <h2 className="font-headline-md text-headline-md text-on-surface mb-stack-sm">Drive Link Verification</h2>
          <p className="text-body-sm text-on-surface-variant mb-stack-lg max-w-[300px]">Paste a public Google Drive or direct file link for automated background scanning.</p>
          <div className="w-full flex flex-col sm:flex-row gap-stack-sm mt-auto">
            <input 
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              disabled={loading}
              className="flex-grow bg-surface-container-low border border-outline-variant rounded-lg px-4 py-3 text-on-surface focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all placeholder:text-outline" 
              placeholder="https://drive.google.com/..." 
              type="text" 
            />
            <button 
              onClick={handleVerifyDriveLink}
              disabled={loading}
              className="primary-gradient-btn text-white font-bold px-8 py-3 rounded-lg transition-all active:scale-95 text-label-xs flex items-center justify-center"
            >
              {loading ? <span className="material-symbols-outlined animate-spin">refresh</span> : 'Verify'}
            </button>
          </div>
        </div>

        {/* Batch Certificates Card */}
        <div {...getRootProps()} className={`glass-card rounded-xl p-stack-lg flex flex-col items-center text-center cursor-pointer group ${isDragActive ? 'border-primary bg-primary/5' : ''}`}>
          <input {...getInputProps()} />
          <div className="w-16 h-16 rounded-full bg-secondary-container/20 flex items-center justify-center mb-stack-md group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-secondary text-4xl">upload</span>
          </div>
          <h2 className="font-headline-md text-headline-md text-on-surface mb-stack-sm">Batch Certificates</h2>
          <p className="text-body-sm text-on-surface-variant mb-stack-lg max-w-[300px]">Upload up to 10 certificates (PDF, JPG, PNG) at once for parallel verification.</p>
          <div className="w-full h-32 border-2 border-dashed border-outline-variant rounded-xl flex flex-col items-center justify-center bg-surface-container-lowest/50 hover:bg-surface-container-low transition-colors mt-auto">
            {loading ? (
               <span className="material-symbols-outlined text-primary animate-spin text-4xl">refresh</span>
            ) : (
              <>
                <span className="material-symbols-outlined text-outline mb-2">cloud_upload</span>
                <span className="text-label-xs text-outline">{isDragActive ? "Drop files here" : "Drag and drop files here"}</span>
              </>
            )}
          </div>
        </div>
      </div>


    </main>
  );

  const renderResultCard = (res, index) => {
    const isAuthentic = res.status === 'REAL';
    const isSuspicious = res.status === 'SUSPICIOUS';
    
    return (
      <div key={index} className="glass-surface rounded-xl overflow-hidden mb-6">
        <div className="p-stack-md md:p-8 flex flex-col gap-6">
          <div className="flex justify-between items-start">
            <h3 className="text-title-sm font-title-sm text-primary truncate max-w-[70%]">{res.fileName}</h3>
            {isAuthentic ? (
              <div className="flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 rounded-full text-label-xs border border-primary/20 authentic-glow">
                <span className="material-symbols-outlined text-[14px]" style={{fontVariationSettings: "'FILL' 1"}}>verified</span>
                Authentic ({(res.confidence * 100).toFixed(0)}%)
              </div>
            ) : isSuspicious ? (
              <div className="flex items-center gap-2 bg-error-container/20 text-tertiary px-3 py-1 rounded-full text-label-xs border border-tertiary/20">
                <span className="material-symbols-outlined text-[14px]">warning</span>
                Suspicious ({(res.confidence * 100).toFixed(0)}%)
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-error-container/50 text-error px-3 py-1 rounded-full text-label-xs border border-error/50">
                <span className="material-symbols-outlined text-[14px]" style={{fontVariationSettings: "'FILL' 1"}}>cancel</span>
                Failed ({(res.confidence * 100).toFixed(0)}%)
              </div>
            )}
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-stack-lg">
            <div>
              <span className="text-label-xs text-on-surface-variant block mb-1">Detected Name</span>
              <p className="text-body-md font-semibold text-on-surface">{res.detectedName || 'Unknown'}</p>
            </div>
            <div>
              <span className="text-label-xs text-on-surface-variant block mb-1">Verified Name (Source)</span>
              <div className="flex items-center gap-2">
                <p className="text-body-md font-semibold text-on-surface">{res.verifiedName || 'N/A'}</p>
                {res.verificationUrl && (
                  <a href={res.verificationUrl} target="_blank" rel="noreferrer" className="flex items-center">
                    <span className="material-symbols-outlined text-[16px] text-primary cursor-pointer">open_in_new</span>
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-outline-variant/30">
            <span className="text-label-xs text-on-surface-variant block mb-4">Analysis Log</span>
            <ul className="space-y-4 relative analysis-thread">
              {res.reasons && res.reasons.map((reason, rIdx) => (
                <li key={rIdx} className="flex gap-3 items-start relative z-10">
                  {reason.includes('✅') ? (
                    <span className="material-symbols-outlined text-[16px] text-[#B4FFAB] mt-1" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                  ) : reason.includes('⚠️') ? (
                    <span className="material-symbols-outlined text-[16px] text-tertiary mt-1" style={{fontVariationSettings: "'FILL' 1"}}>warning</span>
                  ) : reason.includes('❌') ? (
                    <span className="material-symbols-outlined text-[16px] text-error mt-1" style={{fontVariationSettings: "'FILL' 1"}}>cancel</span>
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center mt-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary"></div>
                    </span>
                  )}
                  <p className="text-body-sm text-on-surface-variant">{reason.replace(/[✅⚠️❌ℹ️]\s*/g, '')}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  };

  const renderReport = () => {
    if (!reportData) return null;
    
    const successCount = reportData.results.filter(r => r.status === 'REAL').length;
    const successRate = reportData.results.length ? ((successCount / reportData.results.length) * 100).toFixed(0) : 0;

    return (
      <main className="max-w-container-max mx-auto px-margin-x py-10">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-stack-md mb-stack-lg">
          <div>
            <h1 className="text-display-lg font-display-lg text-on-surface tracking-tight">Verification Report</h1>
            <p className="text-body-sm text-on-surface-variant mt-2">{reportData.timestamp}</p>
          </div>
          <button 
            onClick={() => setView('home')}
            className="bg-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-label-xs hover:opacity-90 transition-opacity flex items-center gap-2 primary-glow"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            Verify Another
          </button>
        </div>

        {reportData.isBatch ? (
          <section className="grid grid-cols-1 md:grid-cols-4 gap-gutter mb-section-gap">
            <div className="glass-surface p-8 rounded-xl flex flex-col items-center justify-center text-center col-span-1 md:col-span-1">
              <span className="text-[48px] font-display-lg text-primary leading-none">{reportData.results.length}</span>
              <span className="text-label-xs text-on-surface-variant uppercase tracking-widest mt-2">Total Processed</span>
            </div>
            <div className="glass-surface p-8 rounded-xl flex flex-col items-center justify-center text-center col-span-1 md:col-span-1">
              <span className={`text-[48px] font-display-lg leading-none ${successRate == 100 ? 'text-secondary' : 'text-tertiary'}`}>{successRate}%</span>
              <span className="text-label-xs text-on-surface-variant uppercase tracking-widest mt-2">Success Rate</span>
            </div>
            <div className="glass-surface p-6 rounded-xl col-span-1 md:col-span-2 relative overflow-hidden group">
              <div className="relative z-10">
                <span className="text-title-sm text-on-surface mb-2 block">Batch Integrity Secure</span>
                <p className="text-body-sm text-on-surface-variant max-w-[280px]">All processed certificates have been cryptographically cross-referenced against official institution registries.</p>
              </div>
              <div className="absolute -right-10 -bottom-10 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-[140px]" style={{fontVariationSettings: "'FILL' 1"}}>verified_user</span>
              </div>
            </div>
          </section>
        ) : (
          <section className="mb-stack-lg">
            <div className="glass-card rounded-xl p-stack-lg text-center flex flex-col items-center justify-center min-h-[140px] shadow-sm">
              <span className="font-display-lg text-[48px] text-primary block leading-none">1</span>
              <span className="text-label-xs text-on-surface-variant mt-2 uppercase tracking-widest">Total Processed</span>
            </div>
          </section>
        )}

        <section className="space-y-gutter">
          <div className="flex items-center gap-4 mb-stack-md">
            <h2 className="text-headline-md text-on-surface">Detailed Results</h2>
            <div className="h-[1px] flex-grow bg-outline-variant/30"></div>
          </div>
          {reportData.results.map((res, idx) => renderResultCard(res, idx))}
        </section>
      </main>
    );
  };

  return (
    <div className="flex flex-col min-h-screen">
      {renderNav()}
      {view === 'home' ? renderHome() : renderReport()}
    </div>
  );
}

export default App;