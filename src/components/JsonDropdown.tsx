import React, { useState, useRef } from 'react';

interface JsonDropdownProps {
  data: any;
  title?: string;
  copyGraphJSON?: () => Promise<void>;
}

export function JsonDropdown({ data, title = "Current Graph JSON", copyGraphJSON }: JsonDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showCopiedMessage, setShowCopiedMessage] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleCopyClick = async () => {
    if (copyGraphJSON) {
      await copyGraphJSON();
      setShowCopiedMessage(true);
      setTimeout(() => setShowCopiedMessage(false), 2000); // Hide after 2 seconds
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 mt-4 overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-left text-gray-700 hover:bg-gray-50 transition-colors focus:outline-none focus:bg-gray-50 active:bg-gray-100"
        type="button"
      >
        <span className="font-medium">{title}</span>
        <svg
          className={`w-5 h-5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {isOpen && (
        <div className="border-t border-gray-200 p-4">
          {copyGraphJSON && (
            <div className="mb-3 flex justify-end">
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
            </div>
          )}
          <div 
            ref={scrollContainerRef}
            className="relative bg-gray-50 rounded border border-gray-200"
            style={{ height: '384px' }} // Fixed height equivalent to max-h-96 (24rem = 384px)
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