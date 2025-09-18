import { ToCData } from '../types';

const API_BASE = '/.netlify/functions';

export interface CreateChartResponse {
  chartId: string;
  editToken: string;
  viewUrl: string;
  editUrl: string;
}

export interface GetChartResponse {
  chartData: ToCData;
  chartId: string;
  canEdit: boolean;
}

export class ChartService {
  static async createChart(chartData: ToCData): Promise<CreateChartResponse> {
    const response = await fetch(`${API_BASE}/createChart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartData })
    });

    if (!response.ok) {
      throw new Error('Failed to create chart');
    }

    return response.json();
  }

  static async getChart(chartId: string): Promise<ToCData> {
    const params = new URLSearchParams();
    params.append('chartId', chartId);

    const response = await fetch(`${API_BASE}/getChart?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch chart');
    }

    const result = await response.json();
    return result.chartData;
  }

  static async getChartByEditToken(editToken: string): Promise<GetChartResponse> {
    const params = new URLSearchParams();
    params.append('editToken', editToken);

    const response = await fetch(`${API_BASE}/getChart?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch chart');
    }

    return response.json();
  }

  static async updateChart(editToken: string, chartData: ToCData): Promise<void> {
    const response = await fetch(`${API_BASE}/updateChart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken, chartData })
    });

    if (!response.ok) {
      throw new Error('Failed to update chart');
    }
  }

  // Helper to extract edit token from URL
  static getEditTokenFromUrl(): string | null {
    const path = window.location.pathname;
    const match = path.match(/^\/edit\/([^/]+)$/);
    return match ? match[1] : null;
  }

  // Helper to extract chart ID from URL
  static getChartIdFromUrl(): string | null {
    const path = window.location.pathname;
    const match = path.match(/^\/chart\/([^/]+)$/);
    return match ? match[1] : null;
  }

  // Get chart ID from an edit token by calling the API
  static async getChartIdFromEditToken(editToken: string): Promise<string> {
    const result = await this.getChartByEditToken(editToken);
    return result.chartId;
  }

  // Save edit token to localStorage for persistence
  static saveEditToken(chartId: string, editToken: string): void {
    const tokens = JSON.parse(localStorage.getItem('editTokens') || '{}');
    tokens[chartId] = editToken;
    localStorage.setItem('editTokens', JSON.stringify(tokens));
  }

  // Get edit token from localStorage
  static getStoredEditToken(chartId: string): string | null {
    const tokens = JSON.parse(localStorage.getItem('editTokens') || '{}');
    return tokens[chartId] || null;
  }
}