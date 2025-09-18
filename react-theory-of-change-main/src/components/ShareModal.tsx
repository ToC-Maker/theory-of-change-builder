import React, { useState, useEffect } from 'react';
import { ToCData } from '../types';
import { ChartService, CreateChartResponse } from '../services/chartService';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  chartData: ToCData;
  currentEditToken?: string | null;
}

export function ShareModal({ isOpen, onClose, chartData, currentEditToken }: ShareModalProps) {
  const [shareData, setShareData] = useState<CreateChartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Load existing share data when modal opens and we have an edit token
  useEffect(() => {
    if (isOpen && currentEditToken && !shareData && !loading) {
      loadExistingShareData();
    } else if (!isOpen) {
      // Reset state when modal closes
      setShareData(null);
      setError(null);
      setCopiedField(null);
    }
  }, [isOpen, currentEditToken]);

  const loadExistingShareData = async () => {
    if (!currentEditToken) return;

    setLoading(true);
    setError(null);

    try {
      const chartId = await ChartService.getChartIdFromEditToken(currentEditToken);
      setShareData({
        chartId,
        editToken: currentEditToken,
        viewUrl: `${window.location.origin}/chart/${chartId}`,
        editUrl: `${window.location.origin}/edit/${currentEditToken}`
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load share data');
    } finally {
      setLoading(false);
    }
  };

  const handleShare = async () => {
    setLoading(true);
    setError(null);

    try {
      // If we already have an edit token, just update; otherwise create new
      if (currentEditToken) {
        await ChartService.updateChart(currentEditToken, chartData);
        // Get the correct chartId from the API
        const chartId = await ChartService.getChartIdFromEditToken(currentEditToken);
        setShareData({
          chartId,
          editToken: currentEditToken,
          viewUrl: `${window.location.origin}/chart/${chartId}`,
          editUrl: `${window.location.origin}/edit/${currentEditToken}`
        });
      } else {
        const response = await ChartService.createChart(chartData);
        setShareData(response);
        // Store the edit token locally
        ChartService.saveEditToken(response.chartId, response.editToken);
        // Update the URL to the edit URL
        window.history.replaceState(null, '', `/edit/${response.editToken}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share chart');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-800">Share Your Chart</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!shareData && !loading && (
          <div className="text-center py-4">
            <p className="text-gray-600 mb-4">
              Generate shareable links for your chart
            </p>
            <button
              onClick={handleShare}
              disabled={loading}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              Generate Links
            </button>
          </div>
        )}

        {loading && (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
            <p className="mt-2 text-gray-600">Creating shareable links...</p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <p className="text-red-600">{error}</p>
          </div>
        )}

        {shareData && !loading && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                View Link (Read-only)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareData.viewUrl}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm"
                />
                <button
                  onClick={() => copyToClipboard(shareData.viewUrl, 'view')}
                  className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  {copiedField === 'view' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Share this link with anyone to view your chart
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Edit Link (Owner only)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareData.editUrl}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-yellow-50 text-sm"
                />
                <button
                  onClick={() => copyToClipboard(shareData.editUrl, 'edit')}
                  className="px-3 py-2 text-sm bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors"
                >
                  {copiedField === 'edit' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-yellow-700 mt-1">
                ⚠️ Keep this link private - anyone with it can edit your chart
              </p>
            </div>

            <div className="pt-4 border-t border-gray-200">
              <p className="text-sm text-gray-600">
                Chart ID: <code className="bg-gray-100 px-1 rounded">{shareData.chartId}</code>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}