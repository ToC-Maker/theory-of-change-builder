export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

export interface TavilySearchResponse {
  answer?: string;
  query: string;
  results: TavilySearchResult[];
  follow_up_questions?: string[];
  images?: string[];
  search_time: number;
}

export interface TavilySearchOptions {
  search_depth?: 'basic' | 'advanced';
  include_answer?: boolean;
  include_images?: boolean;
  include_raw_content?: boolean;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  time_range?: 'day' | 'week' | 'month' | 'year';
  topic?: 'general' | 'news';
}

class TavilyService {

  async search(
    query: string,
    options: TavilySearchOptions = {}
  ): Promise<{ data?: TavilySearchResponse; error?: string }> {
    if (!query || !query.trim()) {
      return {
        error: "Search query cannot be empty."
      };
    }

    try {
      const requestBody = {
        query: query.trim(),
        maxResults: options.max_results || 5,
        recent: true,
        searchDepth: options.search_depth || 'advanced',
        includeAnswer: options.include_answer ?? true,
        timeRange: options.time_range || 'week'
      };

      console.log('Netlify function search request:', { query, options });

      const response = await fetch('/.netlify/functions/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Search function error:', { status: response.status, error: errorData });

        if (response.status === 429) {
          return { error: "Rate limit exceeded. Please wait a moment and try again." };
        }
        if (response.status === 400) {
          return { error: errorData.error || "Invalid search request." };
        }

        return { error: errorData.error || `Search failed: ${response.status}` };
      }

      const responseData = await response.json();

      if (!responseData.success) {
        return { error: responseData.error || "Search failed" };
      }

      console.log('Search completed successfully:', { query, resultCount: responseData.data?.results?.length });
      console.log('=== CLIENT SEARCH RESULTS ===');
      console.log('Query:', query);
      console.log('Response data:', responseData);
      console.log('=== END CLIENT RESULTS ===');

      return { data: responseData.data };

    } catch (error) {
      console.error('Search service error:', error);

      if (error instanceof TypeError && error.message.includes('fetch')) {
        return { error: "Network error. Please check your internet connection and try again." };
      }

      return { error: "Search failed due to an unexpected error. Please try again." };
    }
  }

  async getContextForQuery(
    query: string,
    maxResults: number = 5,
    recent: boolean = true
  ): Promise<{ context?: string; error?: string }> {
    try {
      const requestBody = {
        query: query.trim(),
        maxResults: maxResults,
        recent: recent,
        searchDepth: 'advanced' as const,
        includeAnswer: true,
        timeRange: 'week' as const
      };

      const response = await fetch('/.netlify/functions/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Search service unavailable' }));
        return { error: errorData.error || `Search failed: ${response.status}` };
      }

      const responseData = await response.json();

      if (!responseData.success) {
        return { error: responseData.error || "Search failed" };
      }

      // Use the pre-formatted context from the Netlify function
      console.log('=== CONTEXT FOR QUERY ===');
      console.log('Query:', query);
      console.log('Context length:', responseData.context?.length);
      console.log('Context preview:', responseData.context?.substring(0, 300) + '...');
      console.log('=== END CONTEXT ===');

      return { context: responseData.context };

    } catch (error) {
      console.error('Context query error:', error);
      return { error: "Failed to get search context" };
    }
  }

  isConfigured(): boolean {
    // Since we're using Netlify functions, we assume it's configured if the function exists
    // The actual API key check happens server-side
    return true;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await this.getContextForQuery('test', 1, false);
      return !result.error;
    } catch {
      return false;
    }
  }
}

export const tavilyService = new TavilyService();