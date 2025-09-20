/**
 * Parse generated Theory of Change JSON from AI response
 */
export function parseGeneratedGraph(content: string): any | null {
  try {
    // Look for JSON delimited by [GRAPH_JSON] ... [/GRAPH_JSON]
    const jsonMatch = content.match(/\[GRAPH_JSON\]([\s\S]*?)\[\/GRAPH_JSON\]/);

    if (!jsonMatch) {
      console.log('No [GRAPH_JSON] delimiters found in response');
      return null;
    }

    const jsonString = jsonMatch[1].trim();

    // Parse the JSON
    const graphData = JSON.parse(jsonString);

    // Validate basic structure
    if (!graphData.sections || !Array.isArray(graphData.sections)) {
      console.error('Invalid graph structure: missing sections array', graphData);
      return null;
    }

    // Log detailed structure for debugging
    console.log('Successfully parsed generated graph:');
    console.log('- Title:', graphData.title);
    console.log('- Sections count:', graphData.sections.length);
    console.log('- Full structure:', graphData);

    return graphData;

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