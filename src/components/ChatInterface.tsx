import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useParams, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { chatService, ChatMessage } from '../services/chatService';
import { applyEdits, cleanResponseContent } from '../utils/graphEdits';
import { loggingService } from '../services/loggingService';
import { useApiKey } from '../contexts/ApiKeyContext';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import { parseGeneratedGraph, hasGeneratedGraph } from '../utils/parseGeneratedGraph';
import { MDXEditorComponent } from './MDXEditor';
import { parseFile, getFileTypeDescription } from '../utils/fileParser';
import { ByokPanel } from './ByokPanel';
import { AttachedFilesBar, type AttachedFile } from './AttachedFilesBar';
import {
  formatCostUsd,
  estimateCostLowBound,
  roughInputTokensFromChars,
} from '../utils/cost';
import {
  ChevronLeftIcon,
  Cog6ToothIcon,
  MagnifyingGlassIcon,
  ChevronDownIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  CloudArrowUpIcon,
  XMarkIcon,
  DocumentPlusIcon,
  ArrowUpTrayIcon,
  ChatBubbleLeftRightIcon,
  DocumentTextIcon,
  MagnifyingGlassCircleIcon,
  StopIcon,
  SparklesIcon
} from '@heroicons/react/24/outline';

export type AIMode = 'chat' | 'generate' | 'search';

interface UploadedFile {
  file: File;
  content: string;
  status: 'reading' | 'ready' | 'error';
  errorMessage?: string;
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
  highlightedNodes?: Set<string>;
}

const MODELS = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-7': 'Claude Opus 4.7',
} as const;

// Cloudflare Turnstile site key for anonymous rate-limit enforcement.
// Public (surfaced in the bundle by Vite). Unset in dev = widget skipped,
// mirroring the server-side behavior (U9 skips verification when its
// secret is absent).
const TURNSTILE_SITE_KEY: string = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script';

// Global reference to Cloudflare's injected helper. We attach it via the
// raw <script> element because we don't ship @marsidev/react-turnstile in
// the bundle.
interface TurnstileGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: (err: unknown) => void;
      'expired-callback'?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

/**
 * Renders a Cloudflare Turnstile challenge widget. Loads the CF script
 * lazily, renders into a div we control, and surfaces the verification
 * token via `onToken`. `null` is emitted when the token expires or errors
 * so the caller can disable the send button until re-challenged.
 *
 * Noop when `siteKey` is empty. U9's server-side verification is also
 * skipped when the corresponding secret is unset, so empty-key deployments
 * stay functional anonymously.
 */
function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey) return;

    let cancelled = false;

    const renderWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
    };

    // The explicit render mode requires the script to be loaded once; we
    // reuse the same <script> element across mounts to avoid re-fetching.
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (window.turnstile) {
      renderWidget();
    } else if (existing) {
      existing.addEventListener('load', renderWidget, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', renderWidget, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      // `remove` is idempotent; guard only because `turnstile` may be gone
      // on hot reload.
      try {
        if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      } catch {
        // widget already removed
      }
    };
  }, [siteKey, onToken]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="cf-turnstile" />;
}

export function ChatInterface({ height, isCollapsed, onToggle, graphData, onGraphUpdate, highlightedNodes = new Set() }: ChatInterfaceProps) {
  const { hasKey, keyLast4, verified, useForChat, setUseForChat, clearKey } = useApiKey();
  const { isAuthenticated, getIdTokenClaims } = useAuth0();
  const [currentMode, setCurrentMode] = useState<AIMode>('chat');
  const [selectedModel, setSelectedModel] = useState<keyof typeof MODELS>('claude-opus-4-7');

  // Get route parameters to create unique storage key
  const params = useParams<{ filename?: string; chartId?: string; editToken?: string }>();
  const location = useLocation();

  // Create a unique storage key based on the current route
  const getStorageKey = () => {
    if (params.chartId) {
      return `chatHistory_chart_${params.chartId}`;
    } else if (params.editToken) {
      return `chatHistory_edit_${params.editToken}`;
    } else if (params.filename) {
      return `chatHistory_file_${params.filename}`;
    } else if (location.pathname === '/') {
      return 'chatHistory_root';
    } else {
      // Fallback for any other routes
      return `chatHistory_${location.pathname.replace(/\//g, '_')}`;
    }
  };

  // Load chat history from localStorage on mount
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const storageKey = getStorageKey();
      const savedMessages = localStorage.getItem(storageKey);
      if (savedMessages) {
        const parsed = JSON.parse(savedMessages);
        // Convert timestamp strings back to Date objects
        return parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
      }
    } catch (error) {
      console.error('Failed to load chat history:', error);
    }
    return [];
  });

  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  // Extended thinking is always enabled on Opus 4.7; the server defaults to
  // adaptive thinking when extendedThinkingEnabled is omitted/true.

  // Usage / progress bar state populated from /api/usage. `tier` is 'anon' |
  // 'authenticated' | 'byok' | 'unlimited'; null until the first fetch returns.
  const [usage, setUsage] = useState<{
    used_usd: number;
    limit_usd: number;
    tier: string;
    global?: { used_usd: number; limit_usd: number };
  } | null>(null);

  // Running cost for the in-flight assistant turn (updated via onCostUpdate).
  const [runningCostUsd, setRunningCostUsd] = useState<number | null>(null);

  // Composer-side cost estimate (input-only lower bound). Debounced so
  // typing doesn't recompute on each keystroke.
  const [composerEstimateUsd, setComposerEstimateUsd] = useState<number>(0);

  // Inline error banner shown under the last user message when the server
  // rejects the request on cost/quota grounds (429/402). Persists the chat
  // history (decision 8).
  const [costErrorBanner, setCostErrorBanner] = useState<
    | { kind: 'lifetime_cap' | 'global_budget' | 'turnstile' | 'body_too_large' | 'service_unavailable' | 'other'; message: string }
    | null
  >(null);

  // Turnstile challenge token for anonymous requests. Re-issued on each
  // successful challenge; cleared after use.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);

  // BYOK panel state for 429/402 recovery and voluntary key entry.
  const [byokPanelMode, setByokPanelMode] = useState<'generate' | 'cap_reached' | 'voluntary' | null>(null);
  const [byokMenuOpen, setByokMenuOpen] = useState(false);

  // Files attached in Chat mode (separate from Generate-mode `files`). These
  // can be inline text (content in-memory) or Anthropic Files API uploads
  // (stored as file_id). Only `fileId` is sent to the worker on submit.
  const [chatAttachedFiles, setChatAttachedFiles] = useState<
    Array<AttachedFile & {
      // discriminated: text files carry inline content; upload files carry fileId
      kind: 'text' | 'upload';
      content?: string; // text files only
      fileId?: string; // upload files only
      raw?: File; // retained for retry
    }>
  >([]);

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

  // Settings modal state
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string>(
    localStorage.getItem('customSystemPrompt') || ''
  );
  const [tempSystemPrompt, setTempSystemPrompt] = useState(
    localStorage.getItem('customSystemPrompt') || systemPromptContent
  );

  // Get selected nodes info from graphData and highlightedNodes
  const selectedNodes = React.useMemo(() => {
    if (!graphData || !highlightedNodes.size) return []

    const nodes: Array<{id: string, title: string, path: string}> = []

    graphData.sections?.forEach((section: any, sectionIndex: number) => {
      section.columns?.forEach((column: any, columnIndex: number) => {
        column.nodes?.forEach((node: any) => {
          if (highlightedNodes.has(node.id)) {
            const sectionTitle = section.title || `Section ${sectionIndex + 1}`
            const path = `${sectionTitle} → Column ${columnIndex + 1}`
            nodes.push({
              id: node.id,
              title: node.title || 'Untitled',
              path: path
            })
          }
        })
      })
    })

    return nodes
  }, [graphData, highlightedNodes])

  // Initialize temp prompt when modal opens
  useEffect(() => {
    if (showSettingsModal) {
      const promptToUse = customSystemPrompt.trim() ? customSystemPrompt : systemPromptContent;
      console.log('Setting temp prompt:', { customSystemPrompt, systemPromptContent: systemPromptContent.substring(0, 100) + '...', promptToUse: promptToUse.substring(0, 100) + '...' });
      setTempSystemPrompt(promptToUse);
    }
  }, [showSettingsModal]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingMessageRef = useRef<ChatMessage | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
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

  // Reload chat history when route changes
  useEffect(() => {
    try {
      // Clear chat when navigating to root path (new ToC)
      if (location.pathname === '/') {
        setMessages([]);
        const storageKey = getStorageKey();
        localStorage.removeItem(storageKey);
        return;
      }

      const storageKey = getStorageKey();
      const savedMessages = localStorage.getItem(storageKey);
      if (savedMessages) {
        const parsed = JSON.parse(savedMessages);
        // Convert timestamp strings back to Date objects
        const loadedMessages = parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
        setMessages(loadedMessages);
      } else {
        // Clear messages if no saved history for this route
        setMessages([]);
      }
    } catch (error) {
      console.error('Failed to load chat history on route change:', error);
      setMessages([]);
    }
  }, [params.chartId, params.editToken, params.filename, location.pathname]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    try {
      const storageKey = getStorageKey();
      // Only save non-empty message arrays to avoid clearing on mount
      if (messages.length > 0) {
        localStorage.setItem(storageKey, JSON.stringify(messages));
      }
    } catch (error) {
      console.error('Failed to save chat history:', error);
    }
  }, [messages]);

  useEffect(() => {
    scrollToBottom();
    // Keep focus on input if we're in chat mode and not loading
    if (currentMode === 'chat' && !isCollapsed && inputRef.current && !isLoading) {
      // Use setTimeout to ensure this happens after all DOM updates
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [messages, currentMode, isCollapsed, isLoading]);

  // Smart auto-scroll during streaming - only if user is near bottom
  useEffect(() => {
    if (isStreaming && streamingContent && isNearBottom) {
      scrollToBottom();
    }
  }, [isStreaming, streamingContent, isNearBottom]);

  useEffect(() => {
    if (!isCollapsed && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCollapsed]);

  // Save custom system prompt to localStorage when it changes
  useEffect(() => {
    if (customSystemPrompt) {
      localStorage.setItem('customSystemPrompt', customSystemPrompt);
    } else {
      localStorage.removeItem('customSystemPrompt');
    }
  }, [customSystemPrompt]);

  // Close model dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false);
      }
    };

    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelDropdown]);

  // Auth header helper shared by /api/usage and file-upload callers. Returns
  // an empty object for anonymous visitors; those requests hit the worker
  // anonymously and rely on the Turnstile token for quota attribution.
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!isAuthenticated) return {};
    try {
      const claims = await getIdTokenClaims();
      const idToken = claims?.__raw;
      return idToken ? { Authorization: `Bearer ${idToken}` } : {};
    } catch (err) {
      console.error('[ChatInterface] Failed to read ID token:', err);
      return {};
    }
  }, [isAuthenticated, getIdTokenClaims]);

  // Poll /api/usage on mount and after each stream completion. The worker
  // tallies cost/usage server-side (U9); we just render the progress bar.
  const refreshUsage = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch('/api/usage', { headers });
      if (!response.ok) return; // transient errors: keep prior state
      const data = await response.json();
      setUsage(data);
    } catch (err) {
      // Silently swallow — a missing progress bar is acceptable; the
      // authoritative enforcement lives server-side.
      console.warn('[ChatInterface] refreshUsage failed:', err);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  // Classify a streaming error string into a cost/quota category if it
  // matches one of U9's error payloads, or `null` if it's a generic error
  // to render normally. Keyword-based detection is a stopgap until U10
  // threads a structured `onCostError` callback through chatService.
  const classifyCostError = useCallback(
    (message: string): { kind: 'lifetime_cap' | 'global_budget' | 'turnstile' | 'body_too_large' | 'service_unavailable'; message: string } | null => {
      const lower = message.toLowerCase();
      if (lower.includes('lifetime_cap_reached') || lower.includes('free quota')) {
        return {
          kind: 'lifetime_cap',
          message: "You've reached the free quota. Keep going with your own Anthropic key, or donate to refill the shared pool.",
        };
      }
      if (lower.includes('global_budget_exhausted') || lower.includes('shared budget')) {
        return {
          kind: 'global_budget',
          message: 'Our shared monthly budget is exhausted. Keep going with your own key, or donate to refill the pool.',
        };
      }
      if (lower.includes('turnstile_required') || lower.includes('turnstile_failed')) {
        return {
          kind: 'turnstile',
          message: 'Please complete the challenge before sending.',
        };
      }
      if (lower.includes('body_too_large') || lower.includes('payload too large')) {
        return {
          kind: 'body_too_large',
          message: 'Your message is too large. Try a shorter message or fewer attachments.',
        };
      }
      if (lower.includes('database_unavailable') || lower.includes('authentication_service_unavailable')) {
        return {
          kind: 'service_unavailable',
          message: 'Service temporarily unavailable. Please try again shortly.',
        };
      }
      if (lower.includes('idempotent_replay')) {
        // Silent — user probably double-clicked; nothing to show.
        return null;
      }
      return null;
    },
    [],
  );

  // Debounced cost estimate: recomputes 300ms after the last keystroke or
  // attachment change. Includes inline text file content since those bytes
  // also hit the input-token count.
  useEffect(() => {
    const timeout = setTimeout(() => {
      const attachedChars = chatAttachedFiles
        .filter((f) => f.kind === 'text' && f.status === 'ready' && f.content)
        .reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
      const totalChars = inputValue.length + attachedChars;
      if (totalChars === 0) {
        setComposerEstimateUsd(0);
        return;
      }
      const tokens = roughInputTokensFromChars(totalChars, selectedModel);
      setComposerEstimateUsd(estimateCostLowBound(tokens, selectedModel));
    }, 300);
    return () => clearTimeout(timeout);
  }, [inputValue, chatAttachedFiles, selectedModel]);

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
      setIsLoading(false);
      setStreamingContent('');
      setIsSearching(false);
      setIsThinking(false);

      // If there's a streaming message, finalize it with current content
      if (streamingMessageRef.current && streamingContent) {
        const finalMessage: ChatMessage = {
          ...streamingMessageRef.current,
          content: streamingContent
        };
        setMessages(prev => [...prev, finalMessage]);
        streamingMessageRef.current = null;
      }
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading || isStreaming) return;

    // Reject sends while any chip is still uploading. The server would accept
    // the request but the files wouldn't be attached; better to fail loud
    // client-side.
    if (chatAttachedFiles.some((f) => f.status === 'uploading')) return;

    // Generate UUIDs for message logging
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    // Idempotency key binds the user-perceived turn to a specific worker
    // request; on network retry the worker returns the cached response
    // instead of re-billing Anthropic. Forwarded once U10's chatService
    // accepts the param.
    const idempotencyKey = crypto.randomUUID();

    // Fold attached text-file contents into the user message so the model
    // sees them inline. File-API uploads (PDFs) are referenced by file_id
    // only — see `attachedFileIds`.
    const inlineFileSections = chatAttachedFiles
      .filter((f) => f.kind === 'text' && f.status === 'ready' && f.content)
      .map((f) => `=== ${f.filename} ===\n${f.content}`);
    const attachedFileIds = chatAttachedFiles
      .filter((f) => f.kind === 'upload' && f.status === 'ready' && f.fileId)
      .map((f) => f.fileId!) as string[];

    const userMessageBody =
      inlineFileSections.length > 0
        ? `${inputValue.trim()}\n\n${inlineFileSections.join('\n\n')}`
        : inputValue.trim();

    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: userMessageBody,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    // Clear the chip tray now that the files are in-flight with the message.
    setChatAttachedFiles([]);
    setIsLoading(true);
    setIsStreaming(true);
    setStreamingContent('');
    // Consume the turnstile token: the next send needs a new challenge.
    setTurnstileToken(null);
    setCostErrorBanner(null);
    // Assume user wants to see the response, so set near bottom to true
    setIsNearBottom(true);

    // Extended thinking is always on; show the thinking indicator until the
    // first text delta arrives.
    setIsThinking(true);

    // TODO(U10 integration): forward `idempotencyKey`, `attachedFileIds`,
    // `turnstileToken`, and `hasKey && useForChat ? userAnthropicKey : undefined`
    // to chatService.streamMessage once U10 exposes the new params. Until
    // then the server derives these from the request (or falls back).
    void idempotencyKey;
    void attachedFileIds;

    // Log user message (fire and forget)
    loggingService.logUserMessage({
      messageId: userMessageId,
      role: 'user',
      content: userMessage.content,
    });

    // Create a placeholder streaming message
    streamingMessageRef.current = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    // Create a new abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      await chatService.streamMessage(
        [...messages, userMessage],
        graphData,
        'chat',
        '', // apiKey param kept for back-compat; BYOK flows through the worker
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
            // Clear thinking state when content starts streaming
            if (isThinking) {
              setIsThinking(false);
            }
            setStreamingContent(fullContent);
          },
          onComplete: (finalMessage: string, editInstructions?: any, usage?: any) => {
          const assistantMessage: ChatMessage = {
            id: assistantMessageId,
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
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;

          // Refresh the usage progress bar after the server-side tally lands.
          void refreshUsage();

          // Log assistant message (fire and forget)
          loggingService.logUserMessage({
            messageId: assistantMessageId,
            role: 'assistant',
            content: finalMessage,
            tokenUsage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined,
          });

          // Cost + usage tallies are tracked server-side in the worker; the
          // client refreshes /api/usage below (see usage useEffect).

          // Handle edit instructions if present
          if (editInstructions && onGraphUpdate && graphData) {
            console.log('Edit instructions detected in ChatInterface:', editInstructions);
            try {
              const updatedGraph = applyEdits(graphData, editInstructions);
              onGraphUpdate(updatedGraph);

              // Log successful AI edit
              loggingService.logAIEdit({
                graphData: updatedGraph,
                messageId: assistantMessageId,
                editInstructions,
                success: true,
              });
            } catch (error) {
              console.error('Error applying graph edits:', error);

              // Log failed AI edit
              loggingService.logAIEdit({
                graphData: graphData, // Original unchanged graph
                messageId: assistantMessageId,
                editInstructions,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              });

              // Add an error message to the chat
              const errorMessage: ChatMessage = {
                id: crypto.randomUUID(),
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
          const classified = classifyCostError(error);
          if (classified) {
            // Surface as inline banner, don't pollute chat history
            // (decision 8: preserve chat history on quota/cost failures so
            // BYOK-recovered retries re-use the same messages array).
            setCostErrorBanner(classified);
          } else {
            const errorMessage: ChatMessage = {
              id: assistantMessageId,
              role: 'assistant',
              content: `Error: ${error}`,
              timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessage]);
          }
          setIsStreaming(false);
          setStreamingContent('');
          setIsSearching(false);
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        }
      },
      abortControllerRef.current?.signal, // signal parameter
      selectedModel,
      webSearchEnabled,
      customSystemPrompt,
      highlightedNodes,
      true // extendedThinkingEnabled — always on for Opus 4.7
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sorry, there was an error processing your request.';
      const classified = classifyCostError(message);
      if (classified) {
        setCostErrorBanner(classified);
      } else {
        const errorMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: 'Sorry, there was an error processing your request.',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errorMessage]);
      }
      setIsStreaming(false);
      setStreamingContent('');
      setIsSearching(false);
      setIsThinking(false);
      setRunningCostUsd(null);
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
    setChatAttachedFiles([]);
    setCostErrorBanner(null);
    // Clear chat history from localStorage
    try {
      const storageKey = getStorageKey();
      localStorage.removeItem(storageKey);
    } catch (error) {
      console.error('Failed to clear chat history from localStorage:', error);
    }

    // Fire-and-forget: purge server-side Files API uploads tied to this
    // chart so we don't leak Anthropic storage. The user-visible response
    // doesn't wait on this — they've already moved on.
    const chartIdForCleanup = params.chartId ?? params.editToken;
    if (chartIdForCleanup) {
      void (async () => {
        try {
          const headers = await getAuthHeaders();
          await fetch(`/api/chart-files?chart_id=${encodeURIComponent(chartIdForCleanup)}`, {
            method: 'DELETE',
            headers,
          });
        } catch (err) {
          console.warn('[ChatInterface] chart-files cleanup failed:', err);
        }
      })();
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

    // Parse file contents using our new parser
    for (let i = 0; i < newFiles.length; i++) {
      const uploadedFile = newFiles[i];
      try {
        const result = await parseFile(uploadedFile.file);

        if (result.success) {
          uploadedFile.content = result.content;
          uploadedFile.status = 'ready';
        } else {
          console.error('Error parsing file:', result.error);
          uploadedFile.content = '';
          uploadedFile.status = 'error';
          uploadedFile.errorMessage = result.error;
        }
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

  // File inputs for the Chat-mode paperclip. Separate ref so we can reset
  // the input value after each pick (browsers ignore re-picking the same
  // file without a clear).
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  // Upload a single file into the chat attachment tray. Text files are
  // inlined (carries `content`); PDFs are pushed to /api/upload-file and
  // the returned `file_id` is stored for the next message. On error the
  // chip flips to an error state with a Retry affordance.
  const uploadChatFile = useCallback(
    async (file: File, existingId?: string) => {
      const id = existingId ?? crypto.randomUUID();

      const parsed = await parseFile(file);

      if (parsed.kind === 'error' || parsed.success === false) {
        setChatAttachedFiles((prev) => {
          const next = prev.filter((f) => f.id !== id);
          return [
            ...next,
            {
              id,
              filename: file.name,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              status: 'error',
              error: parsed.kind === 'error' ? parsed.error : 'Failed to parse file',
              kind: 'text',
              raw: file,
            },
          ];
        });
        return;
      }

      if (parsed.kind === 'text') {
        setChatAttachedFiles((prev) => {
          const next = prev.filter((f) => f.id !== id);
          return [
            ...next,
            {
              id,
              filename: parsed.filename,
              mimeType: file.type || 'text/plain',
              sizeBytes: parsed.sizeBytes,
              status: 'ready',
              kind: 'text',
              content: parsed.content,
              raw: file,
            },
          ];
        });
        return;
      }

      // kind === 'upload' — PDF flow via the Anthropic Files API proxy.
      // Chip starts in 'uploading', flips to 'ready' once the worker
      // returns a file_id, or 'error' on failure.
      setChatAttachedFiles((prev) => {
        const next = prev.filter((f) => f.id !== id);
        return [
          ...next,
          {
            id,
            filename: parsed.filename,
            mimeType: parsed.mimeType,
            sizeBytes: parsed.sizeBytes,
            status: 'uploading',
            kind: 'upload',
            raw: file,
          },
        ];
      });

      try {
        if (!params.chartId && !params.editToken) {
          // The worker requires a chart_id so the file can be associated
          // with a specific chart (and cleaned up via chart-files DELETE).
          // Without one (e.g. on the root / create page pre-save), we'd
          // strand the uploaded file. Reject upfront with a clear message.
          throw new Error('Save the chart before attaching files');
        }
        const formData = new FormData();
        formData.append('file', file);
        // `chart_id` in the upload endpoint is the chart's chart_id (not
        // the edit token). Prefer chartId; fall back to edit token (the
        // worker resolves either in U4).
        const chartIdForUpload = params.chartId ?? params.editToken ?? '';
        formData.append('chart_id', chartIdForUpload);

        const headers = await getAuthHeaders();
        const response = await fetch('/api/upload-file', {
          method: 'POST',
          headers, // let the browser set multipart boundary
          body: formData,
        });
        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new Error(errorBody?.error ?? `Upload failed (${response.status})`);
        }
        const data: { file_id: string; filename: string; size_bytes: number; mime_type: string } =
          await response.json();

        setChatAttachedFiles((prev) =>
          prev.map((f) =>
            f.id === id
              ? {
                  ...f,
                  status: 'ready',
                  fileId: data.file_id,
                  filename: data.filename,
                  mimeType: data.mime_type,
                  sizeBytes: data.size_bytes,
                }
              : f,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setChatAttachedFiles((prev) =>
          prev.map((f) =>
            f.id === id ? { ...f, status: 'error', error: message } : f,
          ),
        );
      }
    },
    [getAuthHeaders, params.chartId, params.editToken],
  );

  const handleChatFileSelect = useCallback(
    (selected: FileList | File[]) => {
      const list = Array.from(selected);
      for (const file of list) {
        void uploadChatFile(file);
      }
    },
    [uploadChatFile],
  );

  const handleChatFileRemove = useCallback((id: string) => {
    setChatAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleChatFileRetry = useCallback(
    (id: string) => {
      setChatAttachedFiles((prev) => {
        const target = prev.find((f) => f.id === id);
        if (target?.raw) {
          // Re-kick the upload; the existing id is reused so the chip
          // remains in place and flips back to 'uploading'.
          void uploadChatFile(target.raw, id);
        }
        return prev;
      });
    },
    [uploadChatFile],
  );

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

    setIsLoading(true);
    setIsStreaming(true);
    setStreamingContent('');
    setConversationStarted(true);

    // Extended thinking is always on.
    setIsThinking(true);

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

    // Generate UUIDs for message consistency
    const userMessageId = crypto.randomUUID();
    const generationAssistantId = crypto.randomUUID();

    const generationMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: conversationPrompt,
      timestamp: new Date()
    };

    // Switch to chat mode to show the generation
    setCurrentMode('chat');
    setMessages([generationMessage]);

    streamingMessageRef.current = {
      id: generationAssistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    // Create a new abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      await chatService.streamMessage(
        [generationMessage],
        graphData,
        'generate',
        '', // apiKey param kept for back-compat; BYOK flows through the worker
        {
          onContent: (chunk: string, fullContent: string) => {
            // Clear thinking state when content starts streaming
            if (isThinking) {
              setIsThinking(false);
            }
            setStreamingContent(fullContent);
          },
          onComplete: (finalMessage: string, editInstructions?: any, usage?: any) => {
          const assistantMessage: ChatMessage = {
            id: generationAssistantId,
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
          setIsThinking(false);
          setFullConversation(finalMessage);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;

          // Cost + usage tallies are tracked server-side in the worker;
          // refresh the progress bar now that the tally has landed.
          void refreshUsage();

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
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '✅ **Graph Generated Successfully!** A complete Theory of Change has been created. Click the button below to load it into your workspace.',
                timestamp: new Date()
              };
              setMessages(prev => [...prev, successMessage]);
            } else {
              // Add an error message if parsing failed
              const errorMessage: ChatMessage = {
                id: crypto.randomUUID(),
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
          const classified = classifyCostError(error);
          if (classified) {
            setCostErrorBanner(classified);
          } else {
            const errorMessage: ChatMessage = {
              id: generationAssistantId,
              role: 'assistant',
              content: `Error: ${error}`,
              timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessage]);
          }
          setIsStreaming(false);
          setStreamingContent('');
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        }
      },
      abortControllerRef.current?.signal, // signal parameter
      selectedModel,
      webSearchEnabled,
      customSystemPrompt,
      highlightedNodes,
      true // extendedThinkingEnabled — always on for Opus 4.7
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sorry, there was an error processing your request.';
      const classified = classifyCostError(message);
      if (classified) {
        setCostErrorBanner(classified);
      } else {
        const errorMessage: ChatMessage = {
          id: generationAssistantId,
          role: 'assistant',
          content: 'Sorry, there was an error processing your request.',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errorMessage]);
      }
      setIsStreaming(false);
      setStreamingContent('');
      setIsThinking(false);
      setRunningCostUsd(null);
      streamingMessageRef.current = null;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {!isCollapsed && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-30 md:hidden"
          onClick={onToggle}
        />
      )}

      {/* Mobile floating toggle button - only shown when collapsed on mobile, positioned above JSON dropdown */}
      {isCollapsed && (
        <button
          onClick={onToggle}
          className="fixed left-4 bottom-10 z-40 md:hidden w-12 h-12 bg-blue-600 text-white rounded-full shadow-lg flex items-center justify-center hover:bg-blue-700 transition-colors"
          title="Open AI Assistant"
        >
          <ChatBubbleLeftRightIcon className="w-6 h-6" />
        </button>
      )}

      <div
        className={`fixed left-0 z-40 bg-white border-r border-gray-300 shadow-sm flex flex-col transition-all duration-300 ${
          isCollapsed
            ? 'w-12 -translate-x-full md:translate-x-0'
            : 'w-full sm:w-80 md:w-1/4 md:min-w-[280px] md:max-w-[400px]'
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
          <ChevronLeftIcon className={`w-4 h-4 transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Chat Content */}
      <div className={`flex-1 overflow-hidden transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
        <div className="h-full flex flex-col">
          {/* Chat Header */}
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {((currentMode === 'chat' && messages.length > 0) || (currentMode === 'search' && searchResults.length > 0)) && (
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

            {/* Mode Switcher and Model Selector */}
            <div className="space-y-2">
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setCurrentMode('chat')}
                  className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1 ${
                    currentMode === 'chat'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  <ChatBubbleLeftRightIcon className="w-4 h-4" />
                  <span>Chat</span>
                </button>
              <button
                onClick={() => setCurrentMode('generate')}
                className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1 ${
                  currentMode === 'generate'
                    ? 'bg-white text-purple-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <DocumentTextIcon className="w-4 h-4" />
                <span>Generate</span>
              </button>
              <button
                onClick={() => setCurrentMode('search')}
                className={`flex-1 px-3 py-1 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1 ${
                  currentMode === 'search'
                    ? 'bg-white text-green-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <MagnifyingGlassCircleIcon className="w-4 h-4" />
                <span>Search Results</span>
              </button>
            </div>

            {/* Usage / quota indicator. BYOK users see a pill instead of a
                progress bar (no shared pool is consumed). Unlimited-tier
                users (e.g. admin grants) also skip the progress bar. */}
            {usage && usage.tier !== 'unlimited' && (
              <div className="mt-2">
                {usage.tier === 'byok' ? (
                  <div className="relative flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-xs text-gray-700">
                      <span aria-hidden>🔑</span>
                      <span>BYOK{keyLast4 ? ` · ...${keyLast4}` : ''}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setByokMenuOpen((v) => !v)}
                      className="text-xs text-gray-500 hover:text-gray-700 px-1 rounded"
                      title="BYOK options"
                    >
                      Options
                    </button>
                    {byokMenuOpen && (
                      <div className="absolute right-0 top-6 z-40 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 space-y-1 text-xs">
                        <button
                          type="button"
                          onClick={async () => {
                            setByokMenuOpen(false);
                            await clearKey();
                            await refreshUsage();
                          }}
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-gray-700"
                        >
                          Clear key
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setByokMenuOpen(false);
                            setByokPanelMode('voluntary');
                          }}
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-gray-700"
                        >
                          Change key
                        </button>
                        <label className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-gray-50 text-gray-700 cursor-pointer">
                          <span>Use for Chat too</span>
                          <input
                            type="checkbox"
                            checked={useForChat}
                            onChange={(e) => setUseForChat(e.target.checked)}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div
                      className="w-full h-1 bg-gray-200 rounded overflow-hidden"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={usage.limit_usd}
                      aria-valuenow={usage.used_usd}
                      aria-label={`AI budget usage: ${formatCostUsd(usage.used_usd)} of ${formatCostUsd(usage.limit_usd)}`}
                    >
                      <div
                        className={`h-full rounded transition-all ${
                          usage.used_usd >= usage.limit_usd
                            ? 'bg-red-500'
                            : usage.used_usd / Math.max(usage.limit_usd, 0.01) > 0.75
                            ? 'bg-amber-500'
                            : 'bg-blue-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (usage.used_usd / Math.max(usage.limit_usd, 0.01)) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-500 mt-1">
                      <span>
                        Used {formatCostUsd(usage.used_usd)} of {formatCostUsd(usage.limit_usd)}
                      </span>
                      {hasKey && (
                        <span className="inline-flex items-center gap-0.5 text-gray-600">
                          <span aria-hidden>🔑</span>
                          <span>Key ready</span>
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
          </div>


          {/* Content Area */}
          <div
            ref={chatContainerRef}
            className="flex-1 overflow-y-auto p-3 space-y-3"
            onScroll={handleScroll}
          >
            {currentMode === 'chat' ? (
              <>
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-8">
                    <div className="mb-2"><ChatBubbleLeftRightIcon className="w-8 h-8 mx-auto text-gray-400" /></div>
                    <p>Type anything to start creating your Theory of Change step-by-step.</p>
                    <p className="mt-2 text-xs">If you already have a Theory of Change, you can use the flowchart editing features.</p>
                    <p className="mt-2 text-xs">Or use the "Generate" tab to create a new Theory of Change from existing documents.</p>
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
                          <ReactMarkdown>{cleanResponseContent(message.content)}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap text-left">{cleanResponseContent(message.content)}</div>
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
                  <div className="mb-2"><DocumentTextIcon className="w-8 h-8 mx-auto text-gray-400" /></div>
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
                    accept=".txt,.md,.markdown,.pdf,.csv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rtf"
                    onChange={(e) => e.target.files && handleFileUpload(e.target.files)}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 p-3 text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded transition-colors"
                  >
                    <CloudArrowUpIcon className="w-5 h-5" />
                    Click to upload or drag & drop documents
                  </button>
                  <p className="text-xs text-gray-500 text-center mt-2">
                    Supports PDF, TXT, MD, CSV, JSON, XML, HTML, YAML, and other text formats
                  </p>
                </div>

                {/* Uploaded Files */}
                {files.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-gray-700">Uploaded Files:</h4>
                    {files.map((file, index) => (
                      <div key={index} className="p-2 bg-gray-50 rounded">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 flex-1">
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              file.status === 'ready' ? 'bg-green-400' :
                              file.status === 'reading' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'
                            }`}></div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-700 truncate">{file.file.name}</span>
                                <span className="text-xs text-gray-500">({getFileTypeDescription(file.file.name)})</span>
                              </div>
                              {file.status === 'reading' && (
                                <span className="text-xs text-gray-500">Reading file...</span>
                              )}
                              {file.status === 'ready' && file.content && (
                                <span className="text-xs text-green-600">
                                  {Math.round(file.content.length / 1000)}KB of text extracted
                                </span>
                              )}
                              {file.status === 'error' && (
                                <span className="text-xs text-red-600">
                                  {file.errorMessage || 'Failed to read file'}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => removeFile(file.file)}
                            className="text-gray-400 hover:text-red-500 transition-colors ml-2 flex-shrink-0"
                            title="Remove file"
                          >
                            <XMarkIcon className="w-4 h-4" />
                          </button>
                        </div>
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

                {/* Generate gate: require a verified BYOK key. Rationale
                    (plan §Subtask 2 + decision 7): generation is expensive
                    and we don't subsidize it from the shared pool. If the
                    user doesn't have a key yet, surface the inline
                    ByokPanel with a cost estimate instead of the button.
                    Files and instructions remain visible above so context
                    is preserved across the key-entry step. */}
                {hasKey && verified ? (
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
                        <DocumentPlusIcon className="w-4 h-4" />
                        Generate Theory of Change
                      </>
                    )}
                  </button>
                ) : files.filter((f) => f.status === 'ready').length > 0 ? (
                  <ByokPanel
                    mode="generate"
                    costEstimate={(() => {
                      const promptChars =
                        files
                          .filter((f) => f.status === 'ready')
                          .reduce((sum, f) => sum + (f.content?.length ?? 0), 0) +
                        additionalInstructions.length +
                        // Rough constant for the generate-mode prompt scaffolding.
                        generateModePromptContent.length;
                      const low = estimateCostLowBound(
                        roughInputTokensFromChars(promptChars, selectedModel),
                        selectedModel,
                      );
                      const remaining = usage
                        ? Math.max(0, usage.limit_usd - usage.used_usd)
                        : undefined;
                      return { low_usd: low, remaining_usd: remaining };
                    })()}
                    onSubmitted={() => {
                      void refreshUsage();
                      void startGeneration();
                    }}
                  />
                ) : (
                  <div className="text-xs text-gray-500 text-center">
                    Upload at least one document to continue.
                  </div>
                )}
              </div>
            ) : currentMode === 'search' ? (
              <div className="space-y-4">
                {searchResults.length === 0 && !searchAnswer ? (
                  <div className="text-center text-gray-500 text-sm py-4">
                    <div className="mb-2"><MagnifyingGlassCircleIcon className="w-8 h-8 mx-auto text-gray-400" /></div>
                    <p>Web search results will appear here</p>
                    <p className="mt-2 text-xs">Use the chat to search for current information</p>
                  </div>
                ) : null}

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
            {currentMode === 'chat' && (
              <>
                {/* Search indicator */}
                {isSearching && (
                  <div className="flex justify-start">
                    <div className="bg-blue-50 text-blue-800 rounded-lg rounded-bl-sm p-2 text-sm border border-blue-200">
                      <div className="flex items-center gap-2">
                        <MagnifyingGlassIcon className="w-4 h-4 animate-spin text-blue-600" />
                        <span className="text-blue-700">Searching the web for current information...</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Thinking indicator */}
                {isThinking && !isSearching && (
                  <div className="flex justify-start">
                    <div className="bg-purple-50 text-purple-800 rounded-lg rounded-bl-sm p-2 text-sm border border-purple-200">
                      <div className="flex items-center gap-2">
                        <SparklesIcon className="w-4 h-4 animate-pulse text-purple-600" />
                        <span className="text-purple-700">Thinking about your request...</span>
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
                          {runningCostUsd != null && (
                            <span className="ml-2 text-gray-600">
                              · {formatCostUsd(runningCostUsd)} so far
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Cost-error banner: rendered under the last user message
                    in lieu of toast-style popups, so we preserve chat
                    history across quota/cap failures (plan decision 8). */}
                {costErrorBanner && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] p-3 rounded-lg text-sm bg-amber-50 border border-amber-200 text-amber-900">
                      <div className="mb-2">{costErrorBanner.message}</div>
                      {(costErrorBanner.kind === 'lifetime_cap' ||
                        costErrorBanner.kind === 'global_budget') && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            onClick={() => setByokPanelMode('cap_reached')}
                          >
                            Bring your own key
                          </button>
                          <a
                            href="#donate"
                            className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                          >
                            Donate
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline BYOK panel for cap_reached / voluntary flows */}
                {byokPanelMode && byokPanelMode !== 'generate' && (
                  <ByokPanel
                    mode={byokPanelMode}
                    onSubmitted={() => {
                      setByokPanelMode(null);
                      setCostErrorBanner(null);
                      void refreshUsage();
                      // In cap_reached mode, let the user hit send again;
                      // we don't auto-retry since the chat composer still
                      // holds their last message context.
                    }}
                  />
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
                  <ArrowUpTrayIcon className="w-4 h-4" />
                  Load Theory of Change into Workspace
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-3 border-t border-gray-200">
              {currentMode === 'chat' ? (
                <div className="space-y-2">
                  {/* Selected Nodes Context */}
                  {selectedNodes.length > 0 && (
                    <div className="text-sm text-gray-600 mb-2">
                      {selectedNodes.length === 1 ? '1 node selected' : `${selectedNodes.length} nodes selected`}
                    </div>
                  )}
                  {/* Turnstile challenge: anonymous visitors only. With a site
                      key configured, the widget is rendered until verified;
                      without one, we skip (matches server-side U9 skip). In
                      DEV, surface a hint so developers know why sends are
                      unchallenged. */}
                  {!isAuthenticated && TURNSTILE_SITE_KEY ? (
                    <div className="flex flex-col gap-1">
                      <TurnstileWidget
                        siteKey={TURNSTILE_SITE_KEY}
                        onToken={setTurnstileToken}
                      />
                    </div>
                  ) : null}
                  {!isAuthenticated && !TURNSTILE_SITE_KEY && import.meta.env.DEV ? (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      Anonymous quota unavailable (VITE_TURNSTILE_SITE_KEY unset); please sign in.
                    </div>
                  ) : null}
                  {/* File attachment tray + drop target. Stays mounted so
                      files dropped on the composer area land here. */}
                  <AttachedFilesBar
                    files={chatAttachedFiles}
                    onRemove={handleChatFileRemove}
                    onRetry={handleChatFileRetry}
                    onDropFiles={handleChatFileSelect}
                  />
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.markdown,.pdf,.csv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rtf"
                    onChange={(e) => {
                      if (e.target.files) handleChatFileSelect(e.target.files);
                      // Clear the input so re-picking the same file fires onChange again.
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Ask about your Theory of Change..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none overflow-y-auto"
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
                  {composerEstimateUsd > 0 && (
                    <div className="text-xs text-gray-500">
                      Est. {formatCostUsd(composerEstimateUsd)} (input only)
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setShowSettingsModal(true);
                        }}
                        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Settings"
                      >
                        <Cog6ToothIcon className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => chatFileInputRef.current?.click()}
                        className="p-2 rounded-lg transition-colors text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                        title="Attach a file"
                        aria-label="Attach a file"
                      >
                        <PaperClipIcon className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                        className={`p-2 rounded-lg transition-colors ${
                          webSearchEnabled
                            ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
                            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                        }`}
                        title={webSearchEnabled ? "Web search enabled" : "Enable web search"}
                      >
                        <MagnifyingGlassIcon className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative" ref={modelDropdownRef}>
                        <button
                          onClick={() => setShowModelDropdown(!showModelDropdown)}
                          className="w-[140px] text-xs border border-gray-300 rounded-lg px-2.5 py-2 bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 flex items-center justify-between"
                          title="Select AI Model"
                        >
                          <span className="font-medium">{MODELS[selectedModel]}</span>
                          <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${showModelDropdown ? 'rotate-180' : ''}`} />
                        </button>

                        {showModelDropdown && (
                          <div className="absolute bottom-full mb-1 left-0 w-[200px] bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
                            {Object.entries(MODELS).map(([key, name]) => (
                              <button
                                key={key}
                                onClick={() => {
                                  setSelectedModel(key as keyof typeof MODELS);
                                  setShowModelDropdown(false);
                                }}
                                className={`w-full text-left px-2.5 py-2 text-xs hover:bg-gray-50 transition-colors ${
                                  selectedModel === key ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
                                }`}
                              >
                                {name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {isStreaming ? (
                        <button
                          onClick={handleStopStreaming}
                          className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                          title="Stop generation"
                        >
                          <StopIcon className="w-5 h-5" />
                        </button>
                      ) : (
                        <button
                          onClick={handleSendMessage}
                          disabled={!inputValue.trim() || isLoading}
                          className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Send message"
                        >
                          <PaperAirplaneIcon className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-800">Chat Settings</h2>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XMarkIcon className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Custom System Prompt
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Override the default system prompt with your own instructions.
                  </p>
                  <MDXEditorComponent
                    markdown={tempSystemPrompt}
                    onChange={(value) => setTempSystemPrompt(value)}
                    placeholder="Enter your custom system prompt here..."
                  />
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex justify-between">
              <button
                onClick={() => {
                  setTempSystemPrompt(systemPromptContent);
                }}
                className="px-4 py-2 text-sm text-red-600 hover:text-red-700 transition-colors"
              >
                Reset to Default
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setCustomSystemPrompt(tempSystemPrompt);
                    setShowSettingsModal(false);
                  }}
                  className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}