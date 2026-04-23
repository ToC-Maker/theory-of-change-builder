import type { ToCData } from '../types'

/**
 * Parse generated Theory of Change JSON from AI response.
 * Shape is model-generated so we validate before casting to ToCData.
 */
export function parseGeneratedGraph(content: string): ToCData | null {
  try {
    // Look for JSON delimited by [GRAPH_JSON] ... [/GRAPH_JSON]
    const jsonMatch = content.match(/\[GRAPH_JSON\]([\s\S]*?)\[\/GRAPH_JSON\]/);

    if (!jsonMatch) {
      console.log('No [GRAPH_JSON] delimiters found in response');
      return null;
    }

    const jsonString = jsonMatch[1].trim();

    // Parse the JSON
    const graphData: unknown = JSON.parse(jsonString);

    // Validate basic structure
    if (!graphData || typeof graphData !== 'object' || !Array.isArray((graphData as { sections?: unknown }).sections)) {
      console.error('Invalid graph structure: missing sections array', graphData);
      return null;
    }

    const typed = graphData as ToCData;

    // Log detailed structure for debugging
    console.log('Successfully parsed generated graph:');
    console.log('- Title:', typed.title);
    console.log('- Sections count:', typed.sections.length);
    console.log('- Full structure:', typed);

    return typed;

  } catch (error) {
    console.error('Error parsing generated graph JSON:', error);
    return null;
  }
}

/**
 * Check if content contains a generated graph
 */
export function hasGeneratedGraph(content: string): boolean {
  return content.includes('[GRAPH_JSON]') && content.includes('[/GRAPH_JSON]');
}