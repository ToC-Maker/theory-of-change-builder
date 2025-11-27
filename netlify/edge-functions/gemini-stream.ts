export default async (request: Request) => {
  console.log('[Gemini Edge Function] Request received:', request.method);

  // Only allow POST requests
  if (request.method !== 'POST') {
    console.log('[Gemini Edge Function] Method not allowed:', request.method);
    return new Response('Method not allowed', { status: 405 });
  }

  // Get the API key from environment variables
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  console.log('[Gemini Edge Function] API key present:', !!apiKey);
  console.log('[Gemini Edge Function] API key length:', apiKey?.length || 0);

  if (!apiKey) {
    console.error('[Gemini Edge Function] ERROR: GEMINI_API_KEY not configured');
    return new Response(
      JSON.stringify({ error: 'GEMINI_API_KEY not configured on server. Please add it to your Netlify environment variables.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  try {
    // Parse the request body (expects our internal format)
    const body = await request.json();
    console.log('[Gemini Edge Function] Request model:', body.model);
    console.log('[Gemini Edge Function] Messages count:', body.messages?.length || 0);
    console.log('[Gemini Edge Function] System prompt length:', body.system?.length || 0);

    // Convert from our internal format to Gemini format
    const geminiBody = convertToGeminiFormat(body);
    console.log('[Gemini Edge Function] Converted body contents count:', geminiBody.contents?.length || 0);

    // Determine the model to use
    const model = body.model || 'gemini-2.0-flash';
    console.log('[Gemini Edge Function] Using model:', model);

    // Use streaming endpoint
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey.substring(0, 8)}...`;
    console.log('[Gemini Edge Function] Calling Gemini API...');

    // Forward the request to Gemini API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    });

    console.log('[Gemini Edge Function] Gemini API response status:', response.status);

    // If the response is not OK, return the error
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Gemini Edge Function] Gemini API error:', response.status, errorText);
      return new Response(
        JSON.stringify({
          error: `Gemini API error: ${response.status}`,
          details: errorText,
          model: model
        }),
        {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    console.log('[Gemini Edge Function] Starting stream transformation...');

    // Track if we've sent search start event
    let searchStartSent = false;

    // Transform Gemini SSE to Anthropic-compatible format for the frontend
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              // Convert Gemini format to Anthropic-compatible format
              if (parsed.candidates && parsed.candidates[0]) {
                const candidate = parsed.candidates[0];

                // Handle grounding metadata (Google Search results)
                if (candidate.groundingMetadata) {
                  const groundingMetadata = candidate.groundingMetadata;

                  // Send search start event if we haven't yet
                  if (!searchStartSent && (groundingMetadata.webSearchQueries?.length > 0 || groundingMetadata.groundingChunks?.length > 0)) {
                    searchStartSent = true;
                    const searchStartEvent = {
                      type: 'content_block_start',
                      content_block: {
                        type: 'server_tool_use',
                        name: 'web_search'
                      }
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(searchStartEvent)}\n\n`));
                  }

                  // Convert groundingChunks to Anthropic-style search results
                  if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
                    const searchResults = groundingMetadata.groundingChunks.map((chunk: any) => ({
                      type: 'web_search_result',
                      title: chunk.web?.title || chunk.retrievedContext?.title || 'Search Result',
                      url: chunk.web?.uri || chunk.retrievedContext?.uri || '#',
                      page_age: 'recent'
                    }));

                    const searchResultEvent = {
                      type: 'content_block_start',
                      content_block: {
                        type: 'web_search_tool_result',
                        content: searchResults
                      }
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(searchResultEvent)}\n\n`));
                  }
                }

                // Handle text content
                if (candidate.content?.parts) {
                  for (const part of candidate.content.parts) {
                    if (part.text) {
                      const anthropicEvent = {
                        type: 'content_block_delta',
                        delta: {
                          type: 'text_delta',
                          text: part.text
                        }
                      };
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(anthropicEvent)}\n\n`));
                    }
                  }
                }

                // Handle finish reason
                if (candidate.finishReason) {
                  const stopEvent = {
                    type: 'message_stop'
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stopEvent)}\n\n`));
                }
              }

              // Handle usage metadata
              if (parsed.usageMetadata) {
                const usageEvent = {
                  type: 'message_delta',
                  usage: {
                    input_tokens: parsed.usageMetadata.promptTokenCount || 0,
                    output_tokens: parsed.usageMetadata.candidatesTokenCount || 0
                  }
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usageEvent)}\n\n`));
              }
            } catch (e) {
              // Pass through unparseable data
              console.warn('Failed to parse Gemini SSE data:', e);
            }
          }
        }
      }
    });

    // Stream the transformed response back to the client
    return new Response(response.body?.pipeThrough(transformStream), {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[Gemini Edge Function] Caught error:', error);
    console.error('[Gemini Edge Function] Error type:', typeof error);
    console.error('[Gemini Edge Function] Error message:', error instanceof Error ? error.message : 'Unknown');
    console.error('[Gemini Edge Function] Error stack:', error instanceof Error ? error.stack : 'No stack');

    return new Response(
      JSON.stringify({
        error: 'Failed to process request',
        details: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

// Convert our internal format (based on Anthropic) to Gemini format
function convertToGeminiFormat(body: any) {
  const geminiBody: any = {
    contents: [],
    generationConfig: {
      maxOutputTokens: body.max_tokens || 20000,
    }
  };

  // Add system instruction if present
  if (body.system) {
    geminiBody.systemInstruction = {
      parts: [{ text: body.system }]
    };
  }

  // Convert messages to Gemini format
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      geminiBody.contents.push({
        role: role,
        parts: [{ text: msg.content }]
      });
    }
  }

  // Add safety settings (allow all content for flexibility)
  geminiBody.safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
  ];

  // Handle tools/web search if enabled (Gemini has Google Search grounding)
  if (body.tools && body.tools.some((t: any) => t.type === 'web_search_20250305' || t.name === 'web_search')) {
    geminiBody.tools = [{
      google_search: {}
    }];
  }

  // Handle thinking/extended reasoning (Gemini 2.5+ models)
  if (body.thinking?.type === 'enabled') {
    geminiBody.generationConfig.thinkingConfig = {
      thinkingBudget: body.thinking.budget_tokens || 10000
    };
  }

  return geminiBody;
}

export const config = {
  path: '/api/gemini-stream'
};
