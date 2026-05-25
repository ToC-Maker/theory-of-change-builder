import React, { useState, useEffect } from 'react';
import { TrashIcon, PencilIcon } from '@heroicons/react/24/outline';
import { getContrastTextColor } from '../utils';
import { MDXEditorComponent } from './MDXEditor';
import type { EdgePopupState } from './ConnectionsComponent';

interface EdgePopupProps {
  edgePopup: EdgePopupState;
  setEdgePopup: React.Dispatch<React.SetStateAction<EdgePopupState | null>>;
  updateConfidence: (sourceId: string, targetId: string, newConfidence: number) => void;
  findNodeTitle: (nodeId: string) => string;
  findNodeColor: (nodeId: string) => string;
  /** Reserved: currently unused, kept for layout/debugging hooks. */
  svgSize?: { width: number; height: number };
  editMode?: boolean;
  onUpdateConnection?: (
    sourceId: string,
    targetId: string,
    evidence: string,
    assumptions: string,
  ) => void;
  onDeleteConnection?: (sourceId: string, targetId: string) => void;
  fontFamily?: string;
  viewportOffset?: { left: number; top: number; right: number; bottom: number };
  /** Reserved: currently unused, the backdrop uses absolute viewport units. */
  zoomScale?: number;
}

export function EdgePopup({
  edgePopup,
  setEdgePopup,
  updateConfidence,
  findNodeTitle,
  findNodeColor,
  editMode = false,
  onUpdateConnection,
  onDeleteConnection,
  fontFamily,
  viewportOffset = { left: 0, top: 0, right: 0, bottom: 0 },
}: EdgePopupProps) {
  const [editEvidence, setEditEvidence] = useState(edgePopup.evidence || '');
  const [editAssumptions, setEditAssumptions] = useState(edgePopup.assumptions || '');
  const [isEditing, setIsEditing] = useState(editMode);
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1000,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });

  // Update window size on resize
  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Calculate scale based on available viewport size
  const availableWidth = windowSize.width - viewportOffset.left - viewportOffset.right;
  const availableHeight = windowSize.height - viewportOffset.top - viewportOffset.bottom;
  const isMobile = windowSize.width < 768;
  const scaleX = Math.min(1, (availableWidth - 40) / 800); // 800px width + 40px margin
  const scaleY = Math.min(1, (availableHeight - 40) / 600); // 600px height + 40px margin
  const popupScale = Math.min(scaleX, scaleY);

  useEffect(() => {
    setEditEvidence(edgePopup.evidence || '');
    setEditAssumptions(edgePopup.assumptions || '');
    setIsEditing(editMode);
  }, [edgePopup, editMode]);

  const handleEvidenceChange = (newEvidence: string) => {
    setEditEvidence(newEvidence);
    // Don't save immediately - let MDXEditor handle undo/redo internally
  };

  const handleAssumptionsChange = (newAssumptions: string) => {
    setEditAssumptions(newAssumptions);
    // Don't save immediately - let MDXEditor handle undo/redo internally
  };

  const saveChanges = () => {
    if (
      onUpdateConnection &&
      (editEvidence !== (edgePopup.evidence || '') ||
        editAssumptions !== (edgePopup.assumptions || ''))
    ) {
      onUpdateConnection(edgePopup.sourceId, edgePopup.targetId, editEvidence, editAssumptions);
    }
  };

  const handleDeleteConnection = () => {
    if (onDeleteConnection) {
      onDeleteConnection(edgePopup.sourceId, edgePopup.targetId);
      setEdgePopup(null);
    }
  };

  return (
    <>
      {/* Backdrop with blur - covers entire viewport */}
      <div
        className="fixed z-[200] bg-black bg-opacity-40 backdrop-blur-[2px]"
        style={{
          left: '-1000vw',
          top: '-1000vh',
          right: '-1000vw',
          bottom: '-1000vh',
          width: '2000vw',
          height: '2000vh',
        }}
        onClick={() => {
          saveChanges();
          setEdgePopup(null);
        }}
      />

      {/* Modal container - centered in available viewport area (accounting for sidebar) */}
      <div
        className="fixed z-[210] flex items-center justify-center transition-all duration-150 ease-out pointer-events-none"
        style={{
          top: isMobile ? 0 : viewportOffset.top,
          left: isMobile ? 0 : viewportOffset.left,
          right: isMobile ? 0 : viewportOffset.right,
          bottom: isMobile ? 0 : viewportOffset.bottom,
          animation: 'fadeIn 0.15s ease-out',
        }}
      >
        {/* Modal content - fixed size, scaled to fit viewport (full screen on mobile) */}
        <div
          className={`relative bg-white shadow-2xl pointer-events-auto ${isMobile ? 'overflow-y-auto' : 'flex flex-col'}`}
          style={{
            width: isMobile ? '100vw' : '800px',
            height: isMobile ? '100vh' : '600px',
            borderRadius: isMobile ? 0 : '0.75rem',
            transform: isMobile ? 'none' : `scale(${popupScale})`,
          }}
          onWheel={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          {/* Header - fixed on desktop, scrolls on mobile */}
          <div
            className={`relative border-b border-gray-200 ${isMobile ? 'p-4 pb-3' : 'flex-shrink-0 p-8 pb-4'}`}
          >
            {/* Delete button - top left */}
            {editMode && onDeleteConnection && (
              <button
                className="absolute top-4 left-4 text-gray-400 hover:text-red-600 transition-colors"
                onClick={handleDeleteConnection}
                title="Delete connection"
              >
                <TrashIcon className="w-5 h-5" />
              </button>
            )}

            {/* Close button - top right */}
            <button
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
              onClick={() => {
                saveChanges();
                setEdgePopup(null);
              }}
            >
              ×
            </button>

            <h2
              className={`font-bold text-gray-900 ${isMobile ? 'text-xl mb-2' : 'text-4xl mb-2'}`}
              style={{ fontFamily }}
            >
              Connection Details
            </h2>
            <div
              className={`bg-gray-50 rounded-lg border-l-4 border-r-4 ${isMobile ? 'p-2' : 'p-4'}`}
              style={{
                borderLeftColor: '#000000',
                borderRightColor: '#000000',
              }}
            >
              <div
                className={`text-gray-600 uppercase tracking-wide font-semibold ${isMobile ? 'text-xs mb-1' : 'text-sm mb-2'}`}
                style={{ fontFamily }}
              >
                Connection
              </div>
              <div className={`flex items-center ${isMobile ? 'gap-1' : 'gap-4'}`}>
                <div
                  className={`flex-1 rounded-lg border-0 text-center ${isMobile ? 'p-1.5 shadow-md' : 'p-3 rounded-xl shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)]'}`}
                  style={{ backgroundColor: findNodeColor(edgePopup.sourceId) }}
                >
                  <div
                    className={`opacity-75 ${isMobile ? 'text-[10px] mb-0' : 'text-sm mb-1'}`}
                    style={{
                      color: getContrastTextColor(findNodeColor(edgePopup.sourceId)),
                      fontFamily,
                    }}
                  >
                    From
                  </div>
                  <div
                    className={`font-medium ${isMobile ? 'text-xs leading-tight' : 'text-lg'}`}
                    style={{
                      color: getContrastTextColor(findNodeColor(edgePopup.sourceId)),
                      fontFamily,
                    }}
                  >
                    {findNodeTitle(edgePopup.sourceId)}
                  </div>
                </div>
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className={`rounded-full flex items-center justify-center ${isMobile ? 'w-5 h-5' : 'w-8 h-8'}`}
                    style={{ backgroundColor: '#000000' }}
                  >
                    <svg
                      className={`text-white ${isMobile ? 'w-2.5 h-2.5' : 'w-5 h-5'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5-5 5M6 12h12"
                      />
                    </svg>
                  </div>
                  <div
                    className={`text-gray-500 ${isMobile ? 'text-[8px] mt-0.5' : 'text-xs mt-1'}`}
                    style={{ fontFamily }}
                  >
                    leads to
                  </div>
                </div>
                <div
                  className={`flex-1 rounded-lg border-0 text-center ${isMobile ? 'p-1.5 shadow-md' : 'p-3 rounded-xl shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)]'}`}
                  style={{ backgroundColor: findNodeColor(edgePopup.targetId) }}
                >
                  <div
                    className={`opacity-75 ${isMobile ? 'text-[10px] mb-0' : 'text-sm mb-1'}`}
                    style={{
                      color: getContrastTextColor(findNodeColor(edgePopup.targetId)),
                      fontFamily,
                    }}
                  >
                    To
                  </div>
                  <div
                    className={`font-medium ${isMobile ? 'text-xs leading-tight' : 'text-lg'}`}
                    style={{
                      color: getContrastTextColor(findNodeColor(edgePopup.targetId)),
                      fontFamily,
                    }}
                  >
                    {findNodeTitle(edgePopup.targetId)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Scrollable Content */}
          <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-8'}`}>
            <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
              <div>
                <h3
                  className={`font-semibold text-gray-800 ${isMobile ? 'text-lg mb-2' : 'text-2xl mb-3'}`}
                  style={{ fontFamily }}
                >
                  Confidence Level
                </h3>
                <div className={isMobile ? 'space-y-2' : 'space-y-4'}>
                  <div className="text-center">
                    <span
                      className={`font-bold text-gray-800 ${isMobile ? 'text-xl' : 'text-2xl'}`}
                      style={{ fontFamily }}
                    >
                      {Math.round(edgePopup.confidence)}%
                    </span>
                  </div>

                  <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
                    {editMode && (
                      <div className="flex items-center space-x-4">
                        <span className="text-xs text-gray-600 font-medium" style={{ fontFamily }}>
                          0%
                        </span>
                        <div className="flex-1 relative">
                          <style>
                            {`
                          .black-slider::-webkit-slider-thumb {
                            appearance: none;
                            height: 16px;
                            width: 16px;
                            border-radius: 50%;
                            background: #000000;
                            cursor: pointer;
                            border: none;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                          }
                          .black-slider::-moz-range-thumb {
                            height: 16px;
                            width: 16px;
                            border-radius: 50%;
                            background: #000000;
                            cursor: pointer;
                            border: none;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                          }
                        `}
                          </style>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={edgePopup.confidence}
                            onChange={(e) => {
                              const newConfidence = parseInt(e.target.value);
                              updateConfidence(
                                edgePopup.sourceId,
                                edgePopup.targetId,
                                newConfidence,
                              );
                              setEdgePopup({ ...edgePopup, confidence: newConfidence });
                            }}
                            className="black-slider w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-200"
                          />
                        </div>
                        <span className="text-xs text-gray-600 font-medium" style={{ fontFamily }}>
                          100%
                        </span>
                      </div>
                    )}
                    <div className="text-xs text-gray-700 text-center" style={{ fontFamily }}>
                      {edgePopup.confidence >= 80
                        ? `Very high confidence (${Math.round(edgePopup.confidence)}%). This connection has robust evidence and high certainty.`
                        : edgePopup.confidence >= 60
                          ? `High confidence (${Math.round(edgePopup.confidence)}%). This connection has solid evidence with some certainty.`
                          : edgePopup.confidence >= 40
                            ? `Medium confidence (${Math.round(edgePopup.confidence)}%). This connection has reasonable evidence but uncertainty remains.`
                            : edgePopup.confidence >= 20
                              ? `Low confidence (${Math.round(edgePopup.confidence)}%). This connection has limited evidence and significant uncertainty.`
                              : `Very low confidence (${Math.round(edgePopup.confidence)}%). This connection is speculative with minimal supporting evidence.`}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3 relative">
                  {editMode && !isEditing && (
                    <button
                      onClick={() => {
                        saveChanges();
                        setIsEditing(true);
                      }}
                      className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                      title="Edit connection details"
                    >
                      <PencilIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="space-y-4 text-left">
                  <div>
                    <h4 className="font-medium text-gray-800 mb-2 text-left" style={{ fontFamily }}>
                      Assumptions
                    </h4>
                    {editMode && isEditing ? (
                      <MDXEditorComponent
                        markdown={editAssumptions}
                        onChange={handleAssumptionsChange}
                        placeholder="What assumptions are being made for this connection to hold true?"
                        fontFamily={fontFamily}
                      />
                    ) : (
                      <div className="text-gray-600 leading-relaxed text-left">
                        {editAssumptions ? (
                          <MDXEditorComponent
                            markdown={editAssumptions}
                            readOnly={true}
                            fontFamily={fontFamily}
                          />
                        ) : (
                          <p className="text-gray-400 italic" style={{ fontFamily }}>
                            No assumptions documented yet.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="font-medium text-gray-800 mb-2 text-left" style={{ fontFamily }}>
                      Evidence/Reasoning
                    </h4>
                    {editMode && isEditing ? (
                      <MDXEditorComponent
                        markdown={editEvidence}
                        onChange={handleEvidenceChange}
                        placeholder="What evidence supports this connection?"
                        fontFamily={fontFamily}
                      />
                    ) : (
                      <div className="text-gray-600 leading-relaxed text-left">
                        {editEvidence ? (
                          <MDXEditorComponent
                            markdown={editEvidence}
                            readOnly={true}
                            fontFamily={fontFamily}
                          />
                        ) : (
                          <p className="text-gray-400 italic" style={{ fontFamily }}>
                            No evidence documented yet.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Footnote */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <p className="text-xs text-gray-500 text-left" style={{ fontFamily }}>
                  * This connection represents the causal relationship between these two elements in
                  the theory of change. The source element directly contributes to or enables the
                  target element.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
