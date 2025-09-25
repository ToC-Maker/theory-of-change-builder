import React, { useState, useRef } from 'react';

interface JsonDropdownProps {
  data: any;
  title?: string;
  copyGraphJSON?: () => Promise<void>;
  resetToOriginal?: () => void;
  onUploadJSON?: (jsonData: any) => void;
  loading?: boolean;
}

export function JsonDropdown({ data, title = "Current Graph JSON", copyGraphJSON, resetToOriginal, onUploadJSON, loading }: JsonDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showCopiedMessage, setShowCopiedMessage] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCopyClick = async () => {
    if (copyGraphJSON) {
      await copyGraphJSON();
      setShowCopiedMessage(true);
      setTimeout(() => setShowCopiedMessage(false), 2000); // Hide after 2 seconds
    }
  };

  const handleDownloadClick = () => {
    const graphData = {
      ...data,
      _metadata: {
        exportedAt: new Date().toISOString(),
      }
    };
    
    const jsonString = JSON.stringify(graphData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `toc-graph-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const jsonData = JSON.parse(e.target?.result as string);
        if (onUploadJSON) {
          onUploadJSON(jsonData);
        }
      } catch (error) {
        alert('Invalid JSON file. Please check the file format.');
        console.error('Error parsing JSON:', error);
      }
    };
    reader.readAsText(file);
    
    // Reset the input so the same file can be selected again
    event.target.value = '';
  };

  return (
    <div className="bg-white shadow-sm border-t border-gray-200 overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-left text-gray-700 hover:bg-gray-50 transition-colors focus:outline-none focus:bg-gray-50 active:bg-gray-100"
        type="button"
      >
        <span className="font-medium">{title}</span>
        <svg
          className={`w-5 h-10 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {isOpen && (
        <div className="border-t border-gray-200 p-4">
          {/* Hidden file input for upload */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".json"
            style={{ display: 'none' }}
          />
          
          {(resetToOriginal || copyGraphJSON || onUploadJSON) && (
            <div className="mb-3 flex flex-wrap gap-2 items-center">
              {/* Reset to Original button */}
              {resetToOriginal && (
                <button
                  onClick={resetToOriginal}
                  disabled={loading}
                  className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors border border-gray-200 text-gray-700 hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Reset to the original graph and clear all saved progress"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Reset to Original</span>
                </button>
              )}
              
              {/* Download JSON button */}
              <button
                onClick={handleDownloadClick}
                className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors border border-gray-200 text-gray-700 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                title="Download graph as JSON file"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Download JSON</span>
              </button>

              {/* Upload JSON button */}
              {onUploadJSON && (
                <button
                  onClick={handleUploadClick}
                  className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors border border-gray-200 text-gray-700 hover:bg-purple-50 hover:text-purple-600 hover:border-purple-200"
                  title="Upload graph from JSON file"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <span>Upload JSON</span>
                </button>
              )}

              {/* Copy JSON button on the right */}
              {copyGraphJSON && (
                <button
                  onClick={handleCopyClick}
                  className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors border border-gray-200 ${
                    showCopiedMessage 
                      ? 'bg-green-50 text-green-600 border-green-200' 
                      : 'text-gray-700 hover:bg-green-50 hover:text-green-600'
                  }`}
                >
                  {showCopiedMessage ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
          <div 
            ref={scrollContainerRef}
            className="relative bg-gray-50 rounded border border-gray-200"
            // 1/3 viewport height with max height of 24rem (96)
            style={{ height: '33vh', maxHeight: '24rem' }}
          >
            <div className="h-full overflow-y-scroll p-3 text-left">
              <pre className="text-xs font-mono text-gray-800 whitespace-pre leading-relaxed text-left">
                {JSON.stringify(data, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}