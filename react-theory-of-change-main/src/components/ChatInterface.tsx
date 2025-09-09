import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { chatService, ChatMessage } from '../services/chatService';
import { applyEdits } from '../utils/graphEdits';
import { useApiKey, validateApiKey } from '../contexts/ApiKeyContext';

interface ChatInterfaceProps {
  height?: number;
  isCollapsed: boolean;
  onToggle: () => void;
  graphData?: any;
  onGraphUpdate?: (newGraphData: any) => void;
  onShowToCGenerator?: () => void;
}

export function ChatInterface({ height, isCollapsed, onToggle, graphData, onGraphUpdate, onShowToCGenerator }: ChatInterfaceProps) {
  const { apiKey, setApiKey, isConfigured } = useApiKey();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingMessageRef = useRef<ChatMessage | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

    // Create a placeholder streaming message
    const streamingId = (Date.now() + 1).toString();
    streamingMessageRef.current = {
      id: streamingId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    try {
      await chatService.sendStreamingMessage([...messages, userMessage], graphData, {
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
          streamingMessageRef.current = null;
        }
      }, apiKey);
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

  return (
    <div 
      className={`bg-white rounded-lg shadow-lg border border-gray-200 flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-12' : 'w-80'
      }`}
      style={{ 
        height: height ? `${height}px` : 'fit-content',
        minHeight: height ? `${height}px` : 'auto'
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
          <div className="p-3 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-400 rounded-full"></div>
              <span className="text-sm font-medium text-gray-700">Theory of Change Assistant</span>
            </div>
            <div className="flex items-center gap-2">
              {messages.length > 0 && isConfigured && (
                <button
                  onClick={clearChat}
                  className="text-xs text-gray-500 hover:text-gray-700 p-1 rounded"
                  title="Clear chat"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          {isConfigured && (
            <div className="px-3 py-2 border-b border-gray-200 flex flex-col gap-2">
              {onShowToCGenerator && (
                <button
                  onClick={onShowToCGenerator}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700 transition-colors"
                  title="Generate Theory of Change conversation from documents"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Generate from documents
                </button>
              )}
            </div>
          )}

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
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
            ) : messages.length === 0 ? (
              <div className="text-center text-gray-500 text-sm py-8">
                <div className="mb-2">👋</div>
                <p>Hi! I'm here to help you build and improve your Theory of Change.</p>
                <p className="mt-2 text-xs">Ask me about connections, suggest new nodes, or get strategic advice!</p>
              </div>
            ) : null}
            
            {isConfigured && messages.map((message) => (
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
            
            {/* Streaming message */}
            {isConfigured && isStreaming && streamingContent && (
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
            
            {isConfigured && isLoading && !isStreaming && (
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
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-3 border-t border-gray-200">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask about your Theory of Change..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none overflow-hidden"
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
          </div>
        </div>
      </div>
    </div>
  );
}