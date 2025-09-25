import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { chatService, ChatMessage } from '../services/chatService';
import { applyEdits } from '../utils/graphEdits';
import { useApiKey, validateApiKey } from '../contexts/ApiKeyContext';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import { parseGeneratedGraph, hasGeneratedGraph } from '../utils/parseGeneratedGraph';

export type AIMode = 'chat' | 'generate' | 'search';

interface UploadedFile {
  file: File;
  content: string;
  status: 'reading' | 'ready' | 'error';
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface ChatInterfaceProps {
  height?: number;
  isCollapsed: boolean;
  onToggle: () => void;
  graphData?: any;
  onGraphUpdate?: (newGraphData: any) => void;
}

export function ChatInterface({ height, isCollapsed, onToggle, graphData, onGraphUpdate }: ChatInterfaceProps) {
  const { apiKey, setApiKey, isConfigured } = useApiKey();
  const [currentMode, setCurrentMode] = useState<AIMode>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // Generate mode state
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [conversationStarted, setConversationStarted] = useState(false);
  const [fullConversation, setFullConversation] = useState('');
  const [generatedGraphData, setGeneratedGraphData] = useState<any>(null);

  // Search mode state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAnswer, setSearchAnswer] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingMessageRef = useRef<ChatMessage | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Check if user is near the bottom of the chat
  const checkIfNearBottom = () => {
    if (!chatContainerRef.current) return false;

    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    const threshold = 100; // pixels from bottom
    return scrollHeight - scrollTop - clientHeight < threshold;
  };

  // Handle scroll events to track if user is near bottom
  const handleScroll = () => {
    setIsNearBottom(checkIfNearBottom());
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Smart auto-scroll during streaming - only if user is near bottom
  useEffect(() => {
    if (isStreaming && streamingContent && isNearBottom) {
      scrollToBottom();
    }
  }, [isStreaming, streamingContent, isNearBottom]);

  useEffect(() => {
    if (!isCollapsed && inputRef.current && isConfigured) {
      inputRef.current.focus();
    }
  }, [isCollapsed, isConfigured]);

  useEffect(() => {
    // Initialize API key input with current value
    setApiKeyInput(apiKey);
  }, [apiKey]);

  const handleSaveApiKey = () => {
    const validation = validateApiKey(apiKeyInput);
    
    if (!validation.isValid) {
      setApiKeyError(validation.error || 'Invalid API key');
      return;
    }

    setApiKey(apiKeyInput);
    setApiKeyError('');
  };

  const handleApiKeyKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveApiKey();
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading || isStreaming) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingContent('');
    // Assume user wants to see the response, so set near bottom to true
    setIsNearBottom(true);

    // Create a placeholder streaming message
    const streamingId = (Date.now() + 1).toString();
    streamingMessageRef.current = {
      id: streamingId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    try {
      await chatService.streamMessage(
        [...messages, userMessage],
        graphData,
        'chat',
        apiKey,
        {
          onSearchStart: () => {
            setIsSearching(true);
          },
          onSearchComplete: (results?: any[]) => {
            setIsSearching(false);
            // Update search section with results from chat searches
            if (results && results.length > 0) {
              setSearchResults(results.map(result => ({
                title: result.title || '',
                url: result.url || '',
                content: result.content || '',
                score: result.score || 0
              })));
            }
          },
          onContent: (chunk: string, fullContent: string) => {
            setStreamingContent(fullContent);
          },
          onComplete: (finalMessage: string, editInstructions?: any, usage?: any) => {
          console.log('=== CHAT INTERFACE ONCOMPLETE ===');
          console.log('Usage parameter:', usage);
          console.log('=== END CHAT INTERFACE ===');
          
          const assistantMessage: ChatMessage = {
            id: streamingId,
            role: 'assistant',
            content: finalMessage,
            timestamp: new Date(),
            usage: usage ? {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
            } : undefined
          };
          
          setMessages(prev => [...prev, assistantMessage]);
          setIsStreaming(false);
          setStreamingContent('');
          streamingMessageRef.current = null;
          
          // Handle edit instructions if present
          if (editInstructions && onGraphUpdate && graphData) {
            console.log('Edit instructions detected in ChatInterface:', editInstructions);
            try {
              const updatedGraph = applyEdits(graphData, editInstructions);
              onGraphUpdate(updatedGraph);
            } catch (error) {
              console.error('Error applying graph edits:', error);
              // Add an error message to the chat
              const errorMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `❌ **Edit Error**: I couldn't apply the requested changes to the graph. ${error instanceof Error ? error.message : 'Unknown error occurred'}. The graph remains unchanged.`,
                timestamp: new Date()
              };
              setMessages(prev => [...prev, errorMessage]);
            }
          } else {
            console.log('No edit instructions, callback, or graph data:', {
              hasEditInstructions: !!editInstructions,
              hasCallback: !!onGraphUpdate,
              hasGraphData: !!graphData
            });
          }
        },
        onError: (error: string) => {
          const errorMessage: ChatMessage = {
            id: streamingId,
            role: 'assistant',
            content: `Error: ${error}`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev, errorMessage]);
          setIsStreaming(false);
          setStreamingContent('');
          setIsSearching(false);
          streamingMessageRef.current = null;
        }
      });
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: streamingId,
        role: 'assistant',
        content: 'Sorry, there was an error processing your request.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
      setIsStreaming(false);
      setStreamingContent('');
      setIsSearching(false);
      streamingMessageRef.current = null;
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
    // Allow Shift+Enter for new lines - no preventDefault needed
  };

  const clearChat = () => {
    setMessages([]);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || isLoading) return;

    setIsLoading(true);
    setIsSearching(true);
    setSearchResults([]);
    setSearchAnswer('');

    try {
      const response = await fetch('/.netlify/functions/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: searchQuery.trim(),
          maxResults: 5,
          recent: true,
          searchDepth: 'advanced',
          includeAnswer: true,
          timeRange: 'week'
        }),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }

      const result = await response.json();

      if (result.success && result.data) {
        setSearchResults(result.data.results || []);
        setSearchAnswer(result.data.answer || '');
      } else {
        throw new Error('Invalid search response');
      }
    } catch (error) {
      console.error('Search error:', error);
      setSearchAnswer(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
      setIsSearching(false);
    }
  };

  const handleFileUpload = async (selectedFiles: FileList) => {
    const newFiles: UploadedFile[] = [];

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const uploadedFile: UploadedFile = {
        file,
        content: '',
        status: 'reading'
      };
      newFiles.push(uploadedFile);
    }

    setFiles(prev => [...prev, ...newFiles]);

    // Read file contents
    for (let i = 0; i < newFiles.length; i++) {
      const uploadedFile = newFiles[i];
      try {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(uploadedFile.file);
        });

        uploadedFile.content = content;
        uploadedFile.status = 'ready';
      } catch (error) {
        console.error('Error reading file:', error);
        uploadedFile.status = 'error';
      }

      setFiles(prev => prev.map(f =>
        f.file === uploadedFile.file ? uploadedFile : f
      ));
    }
  };

  const removeFile = (fileToRemove: File) => {
    setFiles(prev => prev.filter(f => f.file !== fileToRemove));
  };

  const loadGeneratedGraph = () => {
    if (generatedGraphData && onGraphUpdate) {
      console.log('Manually loading generated graph');
      onGraphUpdate(generatedGraphData);
      setGeneratedGraphData(null); // Clear after loading

      // Add confirmation message
      const confirmMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '🎯 **Graph Loaded!** The Theory of Change has been loaded into your workspace.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, confirmMessage]);
    }
  };

  const startGeneration = async () => {
    if (files.filter(f => f.status === 'ready').length === 0) {
      return;
    }

    if (!isConfigured) {
      alert('Please configure your Anthropic API key first.');
      return;
    }

    setIsLoading(true);
    setIsStreaming(true);
    setStreamingContent('');
    setConversationStarted(true);

    // Combine all file contents
    const documentContent = files
      .filter(f => f.status === 'ready')
      .map(f => `=== ${f.file.name} ===\n${f.content}`)
      .join('\n\n');

    // Create the specialized conversation prompt
    const conversationPrompt = `${generateModePromptContent}

## Document Content:
${documentContent}

${additionalInstructions.trim() ? `## Additional Instructions:
${additionalInstructions.trim()}

` : ''}Based on this information, generate a comprehensive Theory of Change development conversation following the gold standard process. The conversation should demonstrate evidence-based thinking, counterfactual discipline, and result in a complete, implementable JSON graph structure.

IMPORTANT: Generate this as a realistic conversation between Strategy Co-Pilot and Organization Representative, with back-and-forth exchanges that show the thinking process.`;

    const generationMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: conversationPrompt,
      timestamp: new Date()
    };

    // Switch to chat mode to show the generation
    setCurrentMode('chat');
    setMessages([generationMessage]);

    const streamingId = (Date.now() + 1).toString();
    streamingMessageRef.current = {
      id: streamingId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    try {
      await chatService.streamMessage(
        [generationMessage],
        graphData,
        'generate',
        apiKey,
        {
          onContent: (chunk: string, fullContent: string) => {
            setStreamingContent(fullContent);
          },
          onComplete: (finalMessage: string, editInstructions?: any, usage?: any) => {
          const assistantMessage: ChatMessage = {
            id: streamingId,
            role: 'assistant',
            content: finalMessage,
            timestamp: new Date(),
            usage: usage ? {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
            } : undefined
          };

          setMessages(prev => [...prev, assistantMessage]);
          setIsStreaming(false);
          setStreamingContent('');
          setFullConversation(finalMessage);
          streamingMessageRef.current = null;

          // Check for generated graph JSON and store it
          if (hasGeneratedGraph(finalMessage)) {
            const generatedGraph = parseGeneratedGraph(finalMessage);
            console.log('Generated graph:', generatedGraph);
            console.log('onGraphUpdate available:', !!onGraphUpdate);

            if (generatedGraph) {
              // Store the generated graph for manual loading
              console.log('Storing generated graph for manual loading');
              setGeneratedGraphData(generatedGraph);

              // Add a success message with load button
              const successMessage: ChatMessage = {
                id: (Date.now() + 2).toString(),
                role: 'assistant',
                content: '✅ **Graph Generated Successfully!** A complete Theory of Change has been created. Click the button below to load it into your workspace.',
                timestamp: new Date()
              };
              setMessages(prev => [...prev, successMessage]);
            } else {
              // Add an error message if parsing failed
              const errorMessage: ChatMessage = {
                id: (Date.now() + 2).toString(),
                role: 'assistant',
                content: '⚠️ **Graph Parse Error**: The AI generated a complete Theory of Change conversation, but there was an issue parsing the JSON structure. Please check the generated JSON manually.',
                timestamp: new Date()
              };
              setMessages(prev => [...prev, errorMessage]);
            }
          }

          // Handle edit instructions if present (for regular chat mode)
          if (editInstructions && onGraphUpdate && graphData) {
            try {
              const updatedGraph = applyEdits(graphData, editInstructions);
              onGraphUpdate(updatedGraph);
            } catch (error) {
              console.error('Error applying graph edits:', error);
            }
          }
        },
        onError: (error: string) => {
          const errorMessage: ChatMessage = {
            id: streamingId,
            role: 'assistant',
            content: `Error: ${error}`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev, errorMessage]);
          setIsStreaming(false);
          setStreamingContent('');
          streamingMessageRef.current = null;
        }
      });
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: streamingId,
        role: 'assistant',
        content: 'Sorry, there was an error processing your request.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
      setIsStreaming(false);
      setStreamingContent('');
      streamingMessageRef.current = null;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className={`fixed left-0 z-40 bg-white border-r border-gray-300 shadow-sm flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-12' : 'w-1/4'
      }`}
      style={{
        top: '52px',
        bottom: 0,
        height: 'calc(100vh - 52px)'
      }}
    >
      {/* Toggle Button */}
      <div className="flex-shrink-0 p-2 border-b border-gray-200">
        <button
          onClick={onToggle}
          className="w-full h-8 flex items-center justify-center text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded transition-colors"
          title={isCollapsed ? "Expand AI Assistant" : "Collapse AI Assistant"}
        >
          {!isCollapsed && <span className="mr-2 text-sm font-medium">AI Assistant</span>}
          <svg 
            className={`w-4 h-4 transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Chat Content */}
      <div className={`flex-1 overflow-hidden transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
        <div className="h-full flex flex-col">
          {/* Chat Header */}
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {((currentMode === 'chat' && messages.length > 0) || (currentMode === 'search' && searchResults.length > 0)) && isConfigured && (
                  <button
                    onClick={() => {
                      if (currentMode === 'chat') clearChat();
                      if (currentMode === 'search') {
                        setSearchResults([]);
                        setSearchAnswer('');
                        setSearchQuery('');
                      }
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 p-1 rounded"
                    title={currentMode === 'chat' ? 'Clear chat' : 'Clear search'}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Mode Switcher */}
            <div className="flex bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setCurrentMode('chat')}
                className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors ${
                  currentMode === 'chat'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                💬 Chat
              </button>
              <button
                onClick={() => setCurrentMode('generate')}
                className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors ${
                  currentMode === 'generate'
                    ? 'bg-white text-purple-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                📄 Generate
              </button>
              <button
                onClick={() => setCurrentMode('search')}
                className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors ${
                  currentMode === 'search'
                    ? 'bg-white text-green-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                🔍 Search
              </button>
            </div>
          </div>


          {/* Content Area */}
          <div
            ref={chatContainerRef}
            className="flex-1 overflow-y-auto p-3 space-y-3"
            onScroll={handleScroll}
          >
            {!isConfigured ? (
              <div className="p-4">
                <div className="mb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">Setup Required</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    To use the AI assistant, please enter your Anthropic API key below.
                  </p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-1">
                      Anthropic API Key
                    </label>
                    <input
                      id="apiKey"
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyPress={handleApiKeyKeyPress}
                      placeholder="sk-ant-api03-..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    />
                    {apiKeyError && (
                      <p className="text-red-600 text-xs mt-1">{apiKeyError}</p>
                    )}
                  </div>

                  <button
                    onClick={handleSaveApiKey}
                    disabled={!apiKeyInput.trim()}
                    className="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Save API Key
                  </button>
                </div>

                <div className="mt-4 p-3 bg-blue-50 rounded-md">
                  <p className="text-xs text-blue-800">
                    <strong>How to get your API key:</strong><br/>
                    1. Visit <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-900">console.anthropic.com</a><br/>
                    2. Sign up or log in to your Anthropic account<br/>
                    3. Go to "API Keys" in the left sidebar<br/>
                    4. Click "Create Key" and give it a name<br/>
                    5. Copy the key (starts with "sk-ant-api03-...")
                  </p>
                  <p className="text-xs text-blue-700 mt-2">
                    <strong>Security:</strong> Your API key is stored locally in your browser and never sent to our servers.
                  </p>
                </div>
              </div>
            ) : currentMode === 'chat' ? (
              <>
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-8">
                    <div className="mb-2">💬</div>
                    <p>Hi! I'm here to help you build and improve your Theory of Change.</p>
                    <p className="mt-2 text-xs">Ask me about connections, suggest new nodes, or get strategic advice!</p>
                  </div>
                ) : null}

                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] p-2 rounded-lg text-sm ${
                        message.role === 'user'
                          ? 'bg-blue-500 text-white rounded-br-sm'
                          : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                      }`}
                    >
                      {message.role === 'assistant' ? (
                        <div className="text-left prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-200 prose-pre:text-gray-800">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap text-left">{message.content}</div>
                      )}
                      <div className={`text-xs mt-1 opacity-70 ${
                        message.role === 'user' ? 'text-blue-100' : 'text-gray-500'
                      }`}>
                        <div>{message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        {message.usage && (
                          <div className="mt-1">
                            Tokens: {message.usage.input_tokens} in, {message.usage.output_tokens} out ({message.usage.total_tokens} total)
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            ) : currentMode === 'generate' ? (
              <div className="space-y-4">
                <div className="text-center text-gray-500 text-sm py-4">
                  <div className="mb-2">📄</div>
                  <p>Upload documents to generate a Theory of Change conversation</p>
                </div>

                {/* File Upload */}
                <div
                  className="border-2 border-dashed border-gray-300 rounded-lg p-4 hover:border-gray-400 transition-colors"
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-blue-400', 'bg-blue-50'); }}
                  onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50'); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50');
                    const files = e.dataTransfer.files;
                    if (files.length > 0) handleFileUpload(files);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.pdf,.doc,.docx"
                    onChange={(e) => e.target.files && handleFileUpload(e.target.files)}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 p-3 text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    Click to upload or drag & drop documents
                  </button>
                  <p className="text-xs text-gray-500 text-center mt-2">
                    Supports .txt, .md, .pdf, .doc, .docx files
                  </p>
                </div>

                {/* Uploaded Files */}
                {files.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-gray-700">Uploaded Files:</h4>
                    {files.map((file, index) => (
                      <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${
                            file.status === 'ready' ? 'bg-green-400' :
                            file.status === 'reading' ? 'bg-yellow-400' : 'bg-red-400'
                          }`}></div>
                          <span className="text-sm text-gray-700">{file.file.name}</span>
                        </div>
                        <button
                          onClick={() => removeFile(file.file)}
                          className="text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Additional Instructions */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Additional Instructions (Optional)
                  </label>
                  <textarea
                    value={additionalInstructions}
                    onChange={(e) => setAdditionalInstructions(e.target.value)}
                    placeholder="Any specific focus areas or requirements for your Theory of Change..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                    rows={3}
                  />
                </div>

                {/* Generate Button */}
                <button
                  onClick={startGeneration}
                  disabled={files.filter(f => f.status === 'ready').length === 0 || isLoading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Generating...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Generate Theory of Change
                    </>
                  )}
                </button>
              </div>
            ) : currentMode === 'search' ? (
              <div className="space-y-4">
                <div className="text-center text-gray-500 text-sm py-4">
                  <div className="mb-2">🔍</div>
                  <p>Search the web for current information and insights</p>
                </div>

                {/* Search Results */}
                {searchAnswer && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <h4 className="text-sm font-medium text-blue-800 mb-2">AI Summary:</h4>
                    <div className="text-sm text-blue-700">
                      <ReactMarkdown>{searchAnswer}</ReactMarkdown>
                    </div>
                  </div>
                )}

                {searchResults.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium text-gray-700">Search Results:</h4>
                    {searchResults.map((result, index) => (
                      <div key={index} className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
                        <h5 className="text-sm font-medium text-gray-800 mb-1">
                          <a
                            href={result.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-blue-600 hover:underline"
                          >
                            {result.title}
                          </a>
                        </h5>
                        <p className="text-xs text-gray-500 mb-2">{result.url}</p>
                        <p className="text-sm text-gray-600">{result.content}</p>
                        <div className="text-xs text-gray-400 mt-2">Score: {result.score.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                )}

                {isSearching && (
                  <div className="text-center py-4">
                    <div className="flex items-center justify-center gap-2 text-blue-600">
                      <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                      <span className="text-sm">Searching...</span>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Chat mode streaming indicators */}
            {isConfigured && currentMode === 'chat' && (
              <>
                {/* Search indicator */}
                {isSearching && (
                  <div className="flex justify-start">
                    <div className="bg-blue-50 text-blue-800 rounded-lg rounded-bl-sm p-2 text-sm border border-blue-200">
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 animate-spin text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <span className="text-blue-700">Searching the web for current information...</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Streaming message */}
                {isStreaming && streamingContent && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] p-2 rounded-lg text-sm bg-gray-100 text-gray-800 rounded-bl-sm">
                      <div className="text-left prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-200 prose-pre:text-gray-800">
                        <ReactMarkdown>{streamingContent}</ReactMarkdown>
                      </div>
                      <div className="text-xs mt-1 opacity-70 text-gray-500">
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></div>
                          <span>Streaming...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {isLoading && !isStreaming && !isSearching && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 text-gray-800 rounded-lg rounded-bl-sm p-2 text-sm">
                      <div className="flex items-center gap-1">
                        <div className="flex space-x-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                        <span className="ml-2">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Load Generated Graph Button */}
            {generatedGraphData && (
              <div className="px-3 py-2 border-t border-gray-200">
                <button
                  onClick={loadGeneratedGraph}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Load Theory of Change into Workspace
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          {isConfigured && (
            <div className="p-3 border-t border-gray-200">
              {currentMode === 'chat' ? (
                <div className="flex gap-2">
                  <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Ask about your Theory of Change..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none overflow-y-auto"
                    disabled={isLoading || isStreaming}
                    rows={1}
                    style={{ minHeight: '2.5rem', maxHeight: '8rem' }}
                    onInput={(e) => {
                      // Auto-resize textarea based on content
                      const target = e.target as HTMLTextAreaElement;
                      target.style.height = 'auto';
                      const newHeight = Math.min(target.scrollHeight, 128); // Max 8rem (128px)
                      target.style.height = newHeight + 'px';
                    }}
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={!inputValue.trim() || isLoading || isStreaming}
                    className="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </button>
                </div>
              ) : currentMode === 'search' ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search the web for current information..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    disabled={isLoading}
                  />
                  <button
                    onClick={handleSearch}
                    disabled={!searchQuery.trim() || isLoading}
                    className="px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}