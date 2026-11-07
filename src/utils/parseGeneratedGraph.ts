import { ChartShapeError, normalizeChart, type ToCData } from '../types';

/**
 * Parse generated Theory of Change JSON from AI response.
 * The shape is model-generated, so the chart goes through `normalizeChart`: what
 * comes back is a chart the app can load (ids on every section and column), or
 * null, which the chat reports as a parse error.
 */
export function parseGeneratedGraph(content: string): ToCData | null {
  // Look for JSON delimited by [GRAPH_JSON] ... [/GRAPH_JSON]
  const jsonMatch = content.match(/\[GRAPH_JSON\]([\s\S]*?)\[\/GRAPH_JSON\]/);

  if (!jsonMatch) {
    console.log('No [GRAPH_JSON] delimiters found in response');
    return null;
  }

  const jsonString = jsonMatch[1].trim();

  try {
    const chart = normalizeChart(JSON.parse(jsonString));

    // Log detailed structure for debugging
    console.log('Successfully parsed generated graph:');
    console.log('- Title:', chart.title);
    console.log('- Sections count:', chart.sections.length);
    console.log('- Full structure:', chart);

    return chart;
  } catch (error) {
    // Instead of throwing: the reply is not a usable chart, and the caller
    // tells the user so.
    if (error instanceof ChartShapeError) {
      console.error('Invalid graph structure:', error.reason);
    } else if (error instanceof SyntaxError) {
      console.error('Error parsing generated graph JSON:', error);
    } else {
      throw error;
    }
    return null;
  }
}

/**
 * Check if content contains a generated graph
 */
export function hasGeneratedGraph(content: string): boolean {
  return content.includes('[GRAPH_JSON]') && content.includes('[/GRAPH_JSON]');
}
