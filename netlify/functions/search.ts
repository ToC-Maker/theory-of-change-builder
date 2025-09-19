import { Handler } from '@netlify/functions';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

interface TavilySearchResponse {
  answer?: string;
  query: string;
  results: TavilySearchResult[];
  follow_up_questions?: string[];
  images?: string[];
  search_time: number;
}

interface SearchRequest {
  query: string;
  maxResults?: number;
  recent?: boolean;
  searchDepth?: 'basic' | 'advanced';
  includeAnswer?: boolean;
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

function timeRangeToDays(timeRange: 'day' | 'week' | 'month' | 'year'): number {
  switch (timeRange) {
    case 'day': return 1;
    case 'week': return 7;
    case 'month': return 30;
    case 'year': return 365;
    default: return 7;
  }
}

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Tavily API key not configured' })
      };
    }

    const {
      query,
      maxResults = 5,
      recent = true,
      searchDepth = 'advanced',
      includeAnswer = true,
      timeRange = 'week'
    }: SearchRequest = JSON.parse(event.body || '{}');

    if (!query || !query.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Search query is required' })
      };
    }

    const requestBody = {
      api_key: apiKey,
      query: query.trim(),
      search_depth: searchDepth,
      include_answer: includeAnswer,
      include_images: false,
      include_raw_content: false,
      max_results: maxResults,
      ...(recent && { days: timeRangeToDays(timeRange) })
    };

    console.log('Tavily search request:', { query, searchDepth, maxResults });

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tavily API error:', { status: response.status, errorText });

      if (response.status === 401) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Invalid Tavily API key configuration' })
        };
      }
      if (response.status === 429) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({ error: 'Rate limit exceeded. Please wait and try again.' })
        };
      }
      if (response.status === 400) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid search request' })
        };
      }

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `Search failed: ${response.status}` })
      };
    }

    const data: TavilySearchResponse = await response.json();
    console.log('Tavily search completed:', { query, resultCount: data.results?.length });
    console.log('=== TAVILY SEARCH RESULTS ===');
    console.log('Query:', query);
    console.log('Answer:', data.answer);
    console.log('Results:', data.results?.map(r => ({
      title: r.title,
      url: r.url,
      content: r.content.substring(0, 150) + '...'
    })));
    console.log('=== END TAVILY RESULTS ===');

    // Format context for RAG usage
    const snippets: string[] = [];

    // Include the AI-generated answer if available
    if (data.answer) {
      snippets.push(`AI Summary: ${data.answer}`);
    }

    // Add search results
    for (const result of data.results || []) {
      const snippet = `From ${result.title} (${result.url}): ${result.content.substring(0, 200)}${result.content.length > 200 ? '...' : ''}`;
      snippets.push(snippet);
    }

    const context = snippets.join('\n\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: data,
        context: context,
        query: query
      })
    };

  } catch (error) {
    console.error('Search function error:', error);

    if (error instanceof TypeError && error.message.includes('fetch')) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Network error connecting to search service' })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Search failed due to an unexpected error' })
    };
  }
};