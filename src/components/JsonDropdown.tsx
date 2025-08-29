import React, { useState, useRef } from 'react';

interface JsonDropdownProps {
  data: any;
  title?: string;
}

export function JsonDropdown({ data, title = "Current Graph JSON" }: JsonDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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