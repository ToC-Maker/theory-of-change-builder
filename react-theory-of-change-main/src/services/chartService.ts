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

export interface UserChart {
  chartId: string;
  title: string;
  editUrl: string;
  viewUrl: string;
  updatedAt: string;
  createdAt: string;
  permissionLevel: 'owner' | 'edit';
}

export interface Permission {
  user_id: string;
  user_email: string;
  permission_level: 'owner' | 'edit';
  granted_at: string;
  granted_by: string;
}

export class ChartService {
  // Optional token that can be set by components
  private static authToken: string | null = null;

  // Set the auth token (called from components with useAuth0 hook)
  static setAuthToken(token: string | null) {
    this.authToken = token;
  }

  // Check if auth token is set
  static hasAuthToken(): boolean {
    return this.authToken !== null;
  }

  static async createChart(chartData: ToCData): Promise<CreateChartResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
      console.log('[ChartService] Creating chart with auth token (length:', this.authToken.length, ')');
    } else {
      console.log('[ChartService] Creating chart without auth token (user not authenticated)');
    }

    const response = await fetch(`${API_BASE}/createChart`, {
      method: 'POST',
      headers,
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
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const params = new URLSearchParams();
    params.append('editToken', editToken);

    const response = await fetch(`${API_BASE}/getChart?${params}`, {
      headers
    });

    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = 'Failed to fetch chart';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (e) {
        // If JSON parsing fails, use status-based messages
        if (response.status === 401) {
          errorMessage = 'Authentication required. Please log in to access this chart.';
        } else if (response.status === 404) {
          errorMessage = 'Chart not found. It may have been deleted.';
        }
      }
      throw new Error(errorMessage);
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

  // Get all charts accessible by a user
  static async getUserCharts(userId: string): Promise<UserChart[]> {
    const params = new URLSearchParams();
    params.append('userId', userId);

    const response = await fetch(`${API_BASE}/getUserCharts?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch user charts');
    }

    const result = await response.json();
    return result.charts;
  }

  // Get permissions for a chart (owner only)
  static async getChartPermissions(chartId: string): Promise<{ permissions: Permission[]; linkSharingLevel?: string }> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const params = new URLSearchParams();
    params.append('chartId', chartId);

    const response = await fetch(`${API_BASE}/managePermissions?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.authToken}`
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch chart permissions');
    }

    const result = await response.json();
    // Return the full result object with both permissions and linkSharingLevel
    return result;
  }

  // Remove permission from a user (owner only)
  static async removePermission(
    chartId: string,
    targetUserId: string
  ): Promise<void> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ chartId, targetUserId })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove permission');
    }
  }

  // Update user's permission level (owner only)
  static async updatePermissionLevel(
    chartId: string,
    targetUserId: string,
    permissionLevel: 'owner' | 'edit'
  ): Promise<void> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ chartId, targetUserId, permissionLevel })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update permission');
    }
  }

  // Update link sharing settings (owner only)
  static async updateLinkSharing(
    chartId: string,
    linkSharingLevel: 'restricted' | 'viewer' | 'editor'
  ): Promise<void> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ chartId, linkSharingLevel })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update link sharing');
    }
  }

  // Approve a pending access request (owner only)
  static async approveAccessRequest(
    chartId: string,
    targetUserId: string
  ): Promise<void> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ chartId, targetUserId, action: 'approve' })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to approve access');
    }
  }

  // Reject a pending access request (owner only)
  static async rejectAccessRequest(
    chartId: string,
    targetUserId: string
  ): Promise<void> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ chartId, targetUserId, action: 'reject' })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to reject access');
    }
  }

  // Delete a chart (owner only, or anyone for anonymous charts)
  static async deleteChart(chartId: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    // Add auth header if available (for owned charts)
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(`${API_BASE}/deleteChart`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ chartId })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete chart');
    }
  }

  // Get user's total token usage
  static async getUserTokenUsage(): Promise<{
    totalTokensUsed: number;
    lastUpdatedAt: string | null;
    createdAt: string | null;
  }> {
    if (!this.authToken) {
      throw new Error('Authentication required');
    }

    const response = await fetch(`${API_BASE}/getUserTokenUsage`, {
      headers: {
        'Authorization': `Bearer ${this.authToken}`
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch token usage');
    }

    return response.json();
  }
}