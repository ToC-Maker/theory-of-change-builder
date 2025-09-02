import React, { useState, useRef, useEffect } from 'react';
import { chatService, ChatMessage } from '../services/chatService';
import { applyEdits } from '../utils/graphEdits';

interface ChatInterfaceProps {
  height?: number;
  isCollapsed: boolean;
  onToggle: () => void;
  graphData?: any;
  onGraphUpdate?: (newGraphData: any) => void;
}

export function ChatInterface({ height, isCollapsed, onToggle, graphData, onGraphUpdate }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!isCollapsed && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCollapsed]);

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const response = await chatService.sendMessage([...messages, userMessage], graphData);
      
      if (response.error) {
        const errorMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `Error: ${response.error}`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errorMessage]);
      } else {
        const assistantMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: response.message,
          timestamp: new Date(),
          usage: response.usage
        };
        setMessages(prev => [...prev, assistantMessage]);
        
        // Handle edit instructions if present
        if (response.editInstructions && onGraphUpdate && graphData) {
          console.log('Edit instructions detected in ChatInterface:', response.editInstructions);
          const updatedGraph = applyEdits(graphData, response.editInstructions);
          onGraphUpdate(updatedGraph);
        } else {
          console.log('No edit instructions, callback, or graph data:', {
            hasEditInstructions: !!response.editInstructions,
            hasCallback: !!onGraphUpdate,
            hasGraphData: !!graphData
          });
        }
      }
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Sorry, there was an error processing your request.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
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
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="text-xs text-gray-500 hover:text-gray-700 p-1 rounded"
                title="Clear chat"
              >
                Clear
              </button>
            )}
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-500 text-sm py-8">
                <div className="mb-2">👋</div>
                <p>Hi! I'm here to help you build and improve your Theory of Change.</p>
                <p className="mt-2 text-xs">Ask me about connections, suggest new nodes, or get strategic advice!</p>
              </div>
            )}
            
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
                  <div className="whitespace-pre-wrap">{message.content}</div>
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
            
            {isLoading && (
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
                disabled={isLoading}
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
                disabled={!inputValue.trim() || isLoading}
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