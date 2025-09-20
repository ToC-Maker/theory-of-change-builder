import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { chatService, ChatMessage } from '../services/chatService';
import conversationPromptContent from '../prompts/generateModePrompt.md?raw';
import { useApiKey } from '../contexts/ApiKeyContext';

interface ToCGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGraphGenerated?: (graphData: any) => void;
}

interface UploadedFile {
  file: File;
  content: string;
  status: 'reading' | 'ready' | 'error';
}

export function ToCGeneratorModal({ isOpen, onClose, onGraphGenerated }: ToCGeneratorModalProps) {
  const { apiKey, isConfigured } = useApiKey();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationStarted, setConversationStarted] = useState(false);
  const [fullConversation, setFullConversation] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        const content = await readFileContent(uploadedFile.file);
        uploadedFile.content = content;
        uploadedFile.status = 'ready';
        setFiles(prev => [...prev]); // Trigger re-render
      } catch (error) {
        uploadedFile.status = 'error';
        setFiles(prev => [...prev]);
      }
    }
  };

  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      // For now, we'll handle text files and try to read other formats as text
      // In a production app, you'd want to add proper PDF parsing, etc.
      const fileExtension = file.name.toLowerCase().split('.').pop();
      
      if (fileExtension === 'pdf') {
        // For PDFs, we'll provide a placeholder - in production you'd use a PDF parser
        resolve(`[PDF Document: ${file.name}]\nNote: PDF parsing not yet implemented. Please extract text manually and upload as .txt file.`);
        return;
      }
      
      reader.onload = (e) => {
        try {
          const result = e.target?.result as string;
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to read ${file.name}: ${error}`));
        }
      };
      
      reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
      reader.readAsText(file);
    });
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const startConversation = async () => {
    if (files.filter(f => f.status === 'ready').length === 0) {
      return;
    }

    // Check if API key is configured
    if (!isConfigured) {
      alert('Please configure your Anthropic API key in the chat panel first.');
      return;
    }

    setConversationStarted(true);
    setIsStreaming(true);
    setStreamingContent('');
    
    // Create abort controller for this request
    const controller = new AbortController();
    setAbortController(controller);
    
    // Combine all file contents
    const documentContent = files
      .filter(f => f.status === 'ready')
      .map(f => `=== ${f.file.name} ===\n${f.content}`)
      .join('\n\n');

    // Create the specialized conversation prompt
    const conversationPrompt = `${conversationPromptContent}

## Document Content:
${documentContent}

${additionalInstructions.trim() ? `## Additional Instructions:
${additionalInstructions.trim()}

` : ''}Based on this information, generate a comprehensive Theory of Change development conversation following the gold standard process. The conversation should demonstrate evidence-based thinking, counterfactual discipline, and result in a complete, implementable JSON graph structure.

IMPORTANT: Generate this as a realistic conversation between Strategy Co-Pilot and Organization Representative, with back-and-forth exchanges that show the thinking process.`;

    const initialMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: conversationPrompt,
      timestamp: new Date()
    };

    setMessages([initialMessage]);
    
    try {
      await chatService.sendStreamingMessage([initialMessage], null, {
        onContent: (chunk: string, fullContent: string) => {
          setStreamingContent(fullContent);
          setFullConversation(fullContent);
        },
        onComplete: (finalMessage: string) => {
          const assistantMessage: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: finalMessage,
            timestamp: new Date()
          };
          
          setMessages(prev => [...prev, assistantMessage]);
          setStreamingContent('');
          setIsStreaming(false);
          setAbortController(null);
          setFullConversation(finalMessage);
        },
        onError: (error: string) => {
          console.error('Streaming error:', error);
          setIsStreaming(false);
          setAbortController(null);
        }
      }, apiKey, controller.signal);
    } catch (error) {
      console.error('Error starting conversation:', error);
      setIsStreaming(false);
      setAbortController(null);
    }
  };

  const downloadConversation = () => {
    if (!fullConversation) return;
    
    const blob = new Blob([fullConversation], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `theory_of_change_conversation_${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const extractJsonFromConversation = (conversation: string): any | null => {
    try {
      // Look for JSON blocks in the conversation (between ```json and ```)
      const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
      const match = conversation.match(jsonBlockRegex);
      
      if (match && match[1]) {
        const jsonString = match[1].trim();
        return JSON.parse(jsonString);
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting JSON from conversation:', error);
      return null;
    }
  };

  const stopGeneration = () => {
    if (abortController) {
      console.log('Stopping conversation generation...');
      abortController.abort();
      setAbortController(null);
      setIsStreaming(false);
    }
  };

  const loadGraphFromConversation = () => {
    if (!fullConversation) return;
    
    const extractedData = extractJsonFromConversation(fullConversation);
    if (extractedData && onGraphGenerated) {
      console.log('Loading extracted graph data:', extractedData);
      onGraphGenerated(extractedData);
      onClose(); // Close the modal after loading
    } else {
      alert('No valid JSON graph data found in the conversation. Please ensure the conversation was completed successfully.');
    }
  };

  const resetModal = () => {
    // Stop any ongoing generation
    if (abortController) {
      abortController.abort();
    }
    
    setFiles([]);
    setAdditionalInstructions('');
    setMessages([]);
    setStreamingContent('');
    setIsStreaming(false);
    setConversationStarted(false);
    setFullConversation('');
    setAbortController(null);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  React.useEffect(() => {
    if (streamingContent) {
      scrollToBottom();
    }
  }, [streamingContent]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                {conversationStarted ? 'Theory of Change Generation' : 'Generate Theory of Change Conversation'}
              </h2>
              {conversationStarted && (
                <p className="text-sm text-gray-600 mt-1">
                  {isStreaming ? 'Generating conversation...' : 'Conversation complete'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {isStreaming && (
                <button
                  onClick={stopGeneration}
                  className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  Stop Generation
                </button>
              )}
              {conversationStarted && fullConversation && !isStreaming && (
                <>
                  <button
                    onClick={loadGraphFromConversation}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Load into Graph
                  </button>
                  <button
                    onClick={downloadConversation}
                    className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                  >
                    Download Conversation
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                disabled={isStreaming}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {!conversationStarted ? (
            /* Setup Form */
            <div className="p-6 overflow-y-auto w-full">
              {/* Additional Instructions */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Additional Instructions (Optional)
                </label>
                <textarea
                  value={additionalInstructions}
                  onChange={(e) => setAdditionalInstructions(e.target.value)}
                  placeholder="Enter any specific instructions or requirements for the Theory of Change generation..."
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-vertical"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Optional: Provide specific guidance, focus areas, or requirements for the Theory of Change development process.
                </p>
              </div>

              {/* File Upload */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Upload Documents
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.pdf,.doc,.docx"
                    onChange={(e) => e.target.files && handleFileUpload(e.target.files)}
                    className="hidden"
                  />
                  <div className="text-gray-500 mb-2">
                    <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm">Drop files here or click to upload</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Supported: .txt, .md, .pdf, .doc, .docx
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Choose Files
                  </button>
                </div>
              </div>

              {/* File List */}
              {files.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Uploaded Files</h3>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {files.map((file, index) => (
                      <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded-md">
                        <div className="flex items-center">
                          <div className={`w-2 h-2 rounded-full mr-2 ${
                            file.status === 'ready' ? 'bg-green-500' : 
                            file.status === 'error' ? 'bg-red-500' : 'bg-yellow-500'
                          }`} />
                          <span className="text-sm text-gray-700">{file.file.name}</span>
                        </div>
                        <button
                          onClick={() => removeFile(index)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Start Button */}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={startConversation}
                  disabled={files.filter(f => f.status === 'ready').length === 0}
                  className="px-6 py-3 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Start Theory of Change Generation
                </button>
              </div>
            </div>
          ) : (
            /* Streaming Conversation */
            <div className="flex-1 flex flex-col">
              <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                  {streamingContent ? (
                    <div className="prose prose-sm max-w-none text-left prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-100 prose-pre:text-gray-800">
                      <ReactMarkdown>{streamingContent}</ReactMarkdown>
                    </div>
                  ) : fullConversation ? (
                    <div className="prose prose-sm max-w-none text-left prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-100 prose-pre:text-gray-800">
                      <ReactMarkdown>{fullConversation}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-8">
                      <div className="text-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                        <p className="text-gray-600">Starting conversation generation...</p>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}