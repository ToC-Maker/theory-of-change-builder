import React, { useCallback, useState, useRef, useEffect, useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import { useParams, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { chatService, ChatMessage, type CostError } from '../services/chatService';
import { ChartService } from '../services/chartService';
import { applyEdits } from '../utils/graphEdits';
import { loggingService } from '../services/loggingService';
import { useApiKey } from '../contexts/ApiKeyContext';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { parseGeneratedGraph, hasGeneratedGraph } from '../utils/parseGeneratedGraph';
import { MDXEditorComponent } from './MDXEditor';
import { parseFile, getFileTypeDescription } from '../utils/fileParser';
import { ByokPanel } from './ByokPanel';
import { AttachedFilesBar, type AttachedFile } from './AttachedFilesBar';
import {
  formatCostUsd,
  estimateCostLowBound,
  roughInputTokensFromChars,
  MODEL_INPUT_RATES_USD_PER_MTOK,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER_VALUE,
  CACHE_TTL_MILLIS,
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
  // Called when an action in Chat/Generate (e.g. auto-saving the chart on
  // first file upload) creates a new chart row. The parent uses this to
  // sync its own state (currentEditToken/currentChartId) without needing
  // a full navigation — URL is updated in place via history.replaceState.
  onChartCreated?: (editToken: string, chartId: string) => void;
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

// User-facing copy for each cost-error category. Reused by both the legacy
// keyword classifier (classifyCostError) and the structured handler
// (handleCostError), so copy stays consistent between the two paths.
type CostErrorKind =
  | 'lifetime_cap'
  | 'global_budget'
  | 'turnstile'
  | 'body_too_large'
  | 'service_unavailable';

const COST_ERROR_COPY: Record<CostErrorKind, string> = {
  lifetime_cap:
    "You've reached the free quota. Bring your own Anthropic key to keep going, or donate to help us keep the free tier available for others.",
  global_budget:
    "We've hit our shared monthly AI spend cap. Bring your own Anthropic key to keep going, or donate to help us raise the cap and keep this tool sustainable.",
  turnstile: 'Please complete the challenge before sending.',
  body_too_large:
    'Your message is too large. Try a shorter message or fewer attachments.',
  service_unavailable: 'Service temporarily unavailable. Please try again shortly.',
};

// Keyword table for classifyCostError(). Order matters: first match wins.
const COST_ERROR_CATEGORIES: ReadonlyArray<
  readonly [CostErrorKind, readonly string[]]
> = [
  ['lifetime_cap', ['lifetime_cap_reached', 'free quota']],
  ['global_budget', ['global_budget_exhausted', 'shared budget']],
  ['turnstile', ['turnstile_required', 'turnstile_failed']],
  ['body_too_large', ['body_too_large', 'payload too large']],
  ['service_unavailable', ['database_unavailable', 'estimation_unavailable', 'authentication_service_unavailable']],
];

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

/**
 * Memoized single-message renderer. Extracted + React.memo'd because
 * otherwise every keystroke in the composer re-parses every historical
 * assistant message's markdown from scratch (ReactMarkdown is not cheap
 * on a long conversation), which made pasting large strings freeze the
 * UI. Each message's identity is stable after append, so the shallow
 * prop comparison skips re-renders in the common case.
 *
 * message.content is already the cleaned (marker-stripped) version —
 * cleanResponseContent was applied in onComplete before the row landed
 * in `messages` state; no per-render cleaning needed here.
 */
const MessageBubble = React.memo(function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
          {message.usage && typeof message.usage.cost_usd === 'number' && message.usage.cost_usd > 0 && (
            <div className="mt-1">{formatCostUsd(message.usage.cost_usd)}</div>
          )}
        </div>
      </div>
    </div>
  );
});

export function ChatInterface({ height, isCollapsed, onToggle, graphData, onGraphUpdate, highlightedNodes = new Set(), onChartCreated }: ChatInterfaceProps) {
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
  } | null>(null);

  // Running cost for the in-flight assistant turn (updated via onCostUpdate).
  const [runningCostUsd, setRunningCostUsd] = useState<number | null>(null);


  // Pre-send cost estimates (input-only lower bound from count_tokens).
  // Separate slots so the Chat composer estimate and the Generate panel
  // estimate can update independently; both are debounced to avoid
  // hammering /api/count-tokens-estimate on every keystroke.
  const [composerEstimateUsd, setComposerEstimateUsd] = useState<number>(0);
  const [generateEstimateUsd, setGenerateEstimateUsd] = useState<number>(0);
  // Loading flag so the composer can show a spinner while the debounced
  // fetch is in flight; avoids displaying a stale number that's about to
  // change, and signals to the user that the field is being updated.
  const [estimatingCost, setEstimatingCost] = useState<boolean>(false);

  // Inline error banner shown under the last user message when the server
  // rejects the request on cost/quota grounds (429/402). Persists the chat
  // history (decision 8).
  const [costErrorBanner, setCostErrorBanner] = useState<
    { kind: CostErrorKind; message: string } | null
  >(null);

  // Turnstile session flag. Flipped to `true` once POST /api/verify-turnstile
  // succeeds; the Worker sets an httpOnly `tocb_anon` cookie that rides along
  // automatically on subsequent same-origin fetches. We don't carry the raw
  // token around — it's single-use and irrelevant after verification.
  // Reset to `false` whenever the Worker returns `turnstile_required` mid-flow
  // (cookie expired / IP changed) so the widget re-renders for a fresh solve.
  //
  // `null` = probe in flight (on first load for anon users): we don't yet
  // know if the browser holds a still-valid cookie. Render neither widget
  // nor composer during this (~100ms) window so we don't flash the "please
  // verify" banner for returning users who are already verified.
  const [hasTurnstileSession, setHasTurnstileSession] = useState<boolean | null>(null);
  // Inline error copy shown adjacent to the Turnstile widget after a failed
  // verification, so the user knows to retry the challenge rather than just
  // seeing a silent re-render.
  const [turnstileError, setTurnstileError] = useState<string | null>(null);

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
  // PDFs uploaded for Generate mode via the Files API. Kept as an ordered
  // list of {id, file_id} chips so the chip area can render them with the
  // same AttachedFilesBar as Chat mode. Text/markdown files continue to be
  // inlined via the existing `files` state.
  const [generateAttachedChips, setGenerateAttachedChips] = useState<
    Array<AttachedFile & { fileId?: string; raw?: File }>
  >([]);
  const generateAttachedFileIds = React.useMemo(
    () =>
      generateAttachedChips
        .filter((f) => f.status === 'ready' && f.fileId)
        .map((f) => f.fileId!) as string[],
    [generateAttachedChips],
  );

  // First-upload privacy notice. Persisted across sessions via localStorage
  // so a returning user doesn't see it again after dismissing. We render
  // the banner above the chip area on the first upload of either mode and
  // hide it once the user clicks "Got it".
  const [showFileUploadNotice, setShowFileUploadNotice] = useState<boolean>(
    () => localStorage.getItem('tocb_file_upload_notice_shown') !== 'true',
  );
  const dismissFileUploadNotice = useCallback(() => {
    localStorage.setItem('tocb_file_upload_notice_shown', 'true');
    setShowFileUploadNotice(false);
  }, []);

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
      const response = await fetch('/api/usage', { headers, credentials: 'include' });
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
  // matches one of U9's error payloads. Keyword-based detection covers the
  // legacy error-string path; structured errors from `onCostError` skip this
  // classifier and go through `handleCostError` below.
  const classifyCostError = useCallback(
    (message: string) => {
      const lower = message.toLowerCase();
      for (const [kind, keywords] of COST_ERROR_CATEGORIES) {
        if (keywords.some((k) => lower.includes(k))) {
          return { kind, message: COST_ERROR_COPY[kind] };
        }
      }
      return null;
    },
    [],
  );

  // Structured cost-error handler. Maps CostErrorType → UI state transition
  // (CRITICAL: never clear chat history; 429/402/etc. show an inline banner
  // under the last user message so BYOK retries can reuse the same messages
  // array — plan v2 decision 8).
  const handleCostError = useCallback((error: CostError) => {
    switch (error.type) {
      case 'turnstile_required':
        // Cookie expired or IP changed mid-flow. Bring the widget back so
        // the user can re-solve, and clear any stale error copy.
        setHasTurnstileSession(false);
        setTurnstileError(null);
        return;
      case 'turnstile_failed':
        // Siteverify rejected. Keep the widget visible, surface the error.
        setHasTurnstileSession(false);
        setTurnstileError('Challenge failed; please try again.');
        return;
      case 'idempotent_replay':
        // Silent: the user double-clicked or the browser replayed. The
        // original request is already in flight or completed on the server;
        // surfacing an error would confuse them.
        return;
      case 'lifetime_cap_reached':
        setCostErrorBanner({ kind: 'lifetime_cap', message: COST_ERROR_COPY.lifetime_cap });
        return;
      case 'global_budget_exhausted':
        setCostErrorBanner({ kind: 'global_budget', message: COST_ERROR_COPY.global_budget });
        return;
      case 'request_cost_ceiling_exceeded':
        // Re-use the cap-reached copy + BYOK remedy; the cause is different
        // (per-request ceiling rather than lifetime cap) but the user action
        // is identical: pay with your own key or shorten the prompt.
        setCostErrorBanner({
          kind: 'lifetime_cap',
          message:
            'This request would exceed the per-request cost ceiling. Try a shorter prompt or use your own key.',
        });
        return;
      case 'body_too_large':
        setCostErrorBanner({ kind: 'body_too_large', message: COST_ERROR_COPY.body_too_large });
        return;
      case 'chart_deleted':
        setCostErrorBanner({
          kind: 'service_unavailable',
          message: 'This chart was deleted in another tab. Reload the page to continue.',
        });
        return;
      case 'file_unavailable':
        setCostErrorBanner({
          kind: 'service_unavailable',
          message: 'A file referenced by this chat is no longer available. Remove it and retry.',
        });
        return;
      default:
        // database_unavailable / estimation_unavailable /
        // authentication_service_unavailable / invalid_token all fall
        // through to a generic service banner.
        setCostErrorBanner({
          kind: 'service_unavailable',
          message: COST_ERROR_COPY.service_unavailable,
        });
    }
  }, []);

  // Page-load probe: ask the worker whether an existing tocb_anon cookie is
  // still valid for this caller. The cookie is httpOnly so the client can't
  // read it directly; this lets a returning anon visitor skip the widget for
  // the remaining 24h window instead of re-solving on every refresh.
  // Authenticated users and environments without a site key get promoted to
  // `valid` immediately (no gate to render).
  useEffect(() => {
    if (isAuthenticated || !TURNSTILE_SITE_KEY) {
      setHasTurnstileSession(true);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/verify-turnstile', {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) {
          setHasTurnstileSession(false);
          return;
        }
        const data = (await response.json()) as { valid?: boolean };
        setHasTurnstileSession(data.valid === true);
      } catch {
        // Network error: fall back to showing the widget rather than silently
        // blocking the composer.
        setHasTurnstileSession(false);
      }
    })();
    return () => controller.abort();
  }, [isAuthenticated]);

  // Turnstile: exchange the raw token for an httpOnly session cookie. After a
  // successful verify the widget is hidden (hasTurnstileSession=true) and the
  // browser rides the cookie on subsequent /api/anthropic-stream requests.
  // Failures keep the widget visible with an inline error. Called by the
  // TurnstileWidget on solve, expiry, or error (null payload).
  const handleTurnstileToken = useCallback(async (token: string | null) => {
    if (!token) {
      // Widget reports expiry or error — force a re-render with a prompt.
      setHasTurnstileSession(false);
      return;
    }
    try {
      const response = await fetch('/api/verify-turnstile', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        setHasTurnstileSession(true);
        setTurnstileError(null);
        return;
      }
      // Treat 401 turnstile_failed the same as any other non-200: keep the
      // widget visible, show an error. Other statuses (5xx, 501) also fall
      // through — the user can re-solve to retry.
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      const message =
        body.error === 'turnstile_failed'
          ? 'Challenge failed; please try again.'
          : 'Verification failed; please try again.';
      setHasTurnstileSession(false);
      setTurnstileError(message);
    } catch (err) {
      console.warn('[ChatInterface] verify-turnstile failed:', err);
      setHasTurnstileSession(false);
      setTurnstileError('Network error while verifying; please try again.');
    }
  }, []);

  // Defer inputValue for the estimate effect so React yields to urgent
  // user-input renders during a paste + rapid typing. Without this, the
  // 600ms debounce still gets re-scheduled on every keystroke of a fast
  // paste, and the effect hook's cleanup+schedule adds up when the value
  // is huge.
  const deferredInputValue = useDeferredValue(inputValue);

  // Refs mirroring values we WANT the estimate to read on fire but NOT
  // to retrigger it. Anthropic's count_tokens is rate-limited (Tier 1:
  // 100 RPM); re-running the estimate every time the user nudges a node
  // burns budget for no user benefit — the result is only consumed at
  // send time.
  const graphDataRef = useRef(graphData);
  useEffect(() => { graphDataRef.current = graphData; }, [graphData]);
  const customSystemPromptRef = useRef(customSystemPrompt);
  useEffect(() => { customSystemPromptRef.current = customSystemPrompt; }, [customSystemPrompt]);

  // Debounced input-cost estimate for the Chat composer. Mirrors the
  // request shape streamMessage assembles so the number reflects actual
  // billing, not just the visible textarea:
  //   - system: baseSystemPrompt + chatModePromptContent
  //   - messages: full history + current draft, with [CURRENT_GRAPH_DATA]
  //     JSON appended to the draft (chatService.ts:546-557)
  //   - cache_control: ephemeral, defaulting to 5m TTL per Anthropic docs
  //
  // Rate-limit hygiene: 600ms debounce + graphData/customSystemPrompt
  // read via ref so graph nudges and rare prompt edits don't refire the
  // effect. Tier 1 is 100 RPM; a continuously-typing user would otherwise
  // fire ~100 RPM alone between pauses.
  //
  // Cache accounting: count_tokens returns a flat input-token count with no
  // write-vs-read split. We approximate by timing the last assistant turn:
  //   cold (no prior turn or last turn > 5m ago) → tokens × rate × 1.25
  //     (cache-write multiplier)
  //   warm (last turn within 5m) → new-draft chars at full rate,
  //     system+history at 0.1× (cache-read multiplier)
  // Anthropic's default ephemeral TTL is 5m (optional "1h" if we set it;
  // we don't, so 5m it is).
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const attachedChars = chatAttachedFiles
        .filter((f) => f.kind === 'text' && f.status === 'ready' && f.content)
        .reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
      const draftChars = deferredInputValue.length + attachedChars;
      if (draftChars === 0 && messages.length === 0) {
        setComposerEstimateUsd(0);
        setEstimatingCost(false);
        return;
      }

      const inlineSections = chatAttachedFiles
        .filter((f) => f.kind === 'text' && f.status === 'ready' && f.content)
        .map((f) => `=== ${f.filename} ===\n${f.content}`);
      let draftBody =
        inlineSections.length > 0
          ? `${deferredInputValue}\n\n${inlineSections.join('\n\n')}`
          : deferredInputValue;

      // Mirror chatService.ts:551-557: the last user message gets graph data
      // appended inside [CURRENT_GRAPH_DATA] tags. Read graph via ref so
      // node nudges don't retrigger the estimate.
      const currentGraph = graphDataRef.current;
      if (currentGraph) {
        try {
          const dataWithPaths = addNodePaths(currentGraph);
          draftBody += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
        } catch {
          // addNodePaths shape mismatch; skip rather than break the estimate.
        }
      }

      const baseSystemPrompt = customSystemPromptRef.current?.trim() || systemPromptContent;
      const systemPrompt = `${baseSystemPrompt}\n\n${chatModePromptContent}`;
      const historyForEstimate = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const messagesForEstimate = draftBody
        ? [...historyForEstimate, { role: 'user' as const, content: draftBody }]
        : historyForEstimate;

      // Cache warmth: cached for CACHE_TTL_MILLIS after the last assistant
      // turn (shared constant, default 5m ephemeral TTL from Anthropic).
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const cacheWarm =
        !!lastAssistant &&
        Date.now() - lastAssistant.timestamp.getTime() < CACHE_TTL_MILLIS;

      setEstimatingCost(true);
      void (async () => {
        try {
          const response = await fetch('/api/count-tokens-estimate', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: selectedModel,
              system: [{ type: 'text', text: systemPrompt }],
              messages: messagesForEstimate,
            }),
          });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const data = (await response.json()) as {
            input_tokens?: number;
            estimated_cost_usd?: number;
          };
          const totalTokens = data.input_tokens ?? 0;
          const inputRate = MODEL_INPUT_RATES_USD_PER_MTOK[selectedModel] ?? 5;
          // Approximate draft-only tokens via char ratio (no second fetch).
          const draftOnlyTokens =
            totalTokens > 0 && draftBody.length > 0
              ? Math.round(
                  totalTokens *
                    (draftBody.length /
                      (systemPrompt.length +
                        messagesForEstimate.reduce(
                          (n, m) =>
                            n +
                            (typeof m.content === 'string' ? m.content.length : 0),
                          0,
                        ))),
                )
              : 0;
          const cachedTokens = Math.max(0, totalTokens - draftOnlyTokens);
          // Warm-cache: prior system+history read at 0.1×. The *new draft*
          // isn't free either — top-level `cache_control: {ephemeral}`
          // auto-extends the breakpoint to include the latest turn, so
          // the draft tokens get written to cache at 1.25× (same write
          // multiplier as the cold path). Not applying 1.25× to the draft
          // under-estimated warm-cache turns by the write markup, which
          // is exactly what we observed on a large paste (estimate $0.85
          // vs billed $1.10 — the ~20% gap matches the 1/1.25 factor).
          const estimate = cacheWarm
            ? (draftOnlyTokens * inputRate * CACHE_WRITE_MULTIPLIER +
                cachedTokens * inputRate * CACHE_READ_MULTIPLIER_VALUE) /
              1_000_000
            : (totalTokens * inputRate * CACHE_WRITE_MULTIPLIER) / 1_000_000;
          setComposerEstimateUsd(estimate);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          const historyChars = messages.reduce((sum, m) => sum + m.content.length, 0);
          const tokens = roughInputTokensFromChars(
            systemPrompt.length + historyChars + draftChars,
            selectedModel,
          );
          setComposerEstimateUsd(estimateCostLowBound(tokens, selectedModel));
        } finally {
          setEstimatingCost(false);
        }
      })();
    }, 600);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [deferredInputValue, chatAttachedFiles, selectedModel, messages]);

  // Debounced input-cost estimate for Generate mode. Assembles the same
  // prompt shape startGeneration() builds (system prompt + document
  // content + optional additional instructions) and runs it through
  // count-tokens-estimate. Unlike Chat, this is a one-shot request so the
  // estimate reflects what a single Generate click will cost.
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const readyTextFiles = files.filter((f) => f.status === 'ready');
      if (readyTextFiles.length === 0 && generateAttachedFileIds.length === 0 && !additionalInstructions.trim()) {
        setGenerateEstimateUsd(0);
        return;
      }

      const documentContent = readyTextFiles
        .map((f) => `=== ${f.file.name} ===\n${f.content}`)
        .join('\n\n');
      const assembled = `${generateModePromptContent}\n\n## Document Content:\n${documentContent}\n\n${
        additionalInstructions.trim()
          ? `## Additional Instructions:\n${additionalInstructions.trim()}\n\n`
          : ''
      }`;

      const baseSystemPrompt = customSystemPromptRef.current?.trim() || systemPromptContent;
      const systemPromptForEstimate = `${baseSystemPrompt}\n\n${generateModePromptContent}`;

      setEstimatingCost(true);
      void (async () => {
        try {
          const response = await fetch('/api/count-tokens-estimate', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: selectedModel,
              system: [{ type: 'text', text: systemPromptForEstimate }],
              messages: [{ role: 'user', content: assembled }],
            }),
          });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const data = (await response.json()) as {
            input_tokens?: number;
            estimated_cost_usd?: number;
          };
          const totalTokens = data.input_tokens ?? 0;
          const inputRate = MODEL_INPUT_RATES_USD_PER_MTOK[selectedModel] ?? 5;
          // Generate is one-shot with a fresh user turn each click; the
          // system prompt caches across runs but the documents don't, so
          // the system prompt gets cache-write on first submit. Apply the
          // write multiplier to the whole count — matches startGeneration's
          // actual behavior on the first click and is close enough for
          // consecutive clicks too (output cost shown live dominates).
          const estimate = (totalTokens * inputRate * CACHE_WRITE_MULTIPLIER) / 1_000_000;
          setGenerateEstimateUsd(estimate);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          const chars =
            systemPromptForEstimate.length +
            assembled.length +
            readyTextFiles.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
          const tokens = roughInputTokensFromChars(chars, selectedModel);
          setGenerateEstimateUsd(estimateCostLowBound(tokens, selectedModel));
        } finally {
          setEstimatingCost(false);
        }
      })();
    }, 600);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [files, additionalInstructions, generateAttachedFileIds, selectedModel]);

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
    setCostErrorBanner(null);
    // Assume user wants to see the response, so set near bottom to true
    setIsNearBottom(true);

    // Extended thinking is always on; show the thinking indicator until the
    // first text delta arrives.
    setIsThinking(true);

    // NOTE: `userAnthropicKey` is not passed from the client in the
    // server-stored BYOK flow — the client never retains the raw key after
    // it's been submitted to /api/byok-key. Server-side transparent BYOK
    // decrypt-and-forward in anthropic-stream is a follow-up; until then,
    // explicit per-request BYOK requires the user to re-enter the key.

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
      await chatService.streamMessage({
        messages: [...messages, userMessage],
        currentGraphData: graphData,
        mode: 'chat',
        callbacks: {
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
          onContent: (_chunk: string, fullContent: string) => {
            // Clear thinking state when content starts streaming
            if (isThinking) {
              setIsThinking(false);
            }
            setStreamingContent(fullContent);
          },
          onComplete: (finalMessage: string, editInstructions?: any, usage?: any, rawMessage?: string) => {
          const assistantMessage: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: finalMessage,
            timestamp: new Date(),
            usage: usage ? {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
              cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usage.cache_read_input_tokens || 0,
              web_search_requests: usage.server_tool_use?.web_search_requests || 0,
              cost_usd: runningCostUsd ?? undefined,
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

          // Log the RAW streamed content (pre-clean) so the audit trail
          // captures exactly what Claude produced, including
          // [EDIT_INSTRUCTIONS] / [CURRENT_GRAPH_DATA] / [SELECTED_NODES]
          // blocks. The displayed message above uses the cleaned version;
          // they're different views of the same event, not duplicates.
          // Snapshots still carry parsed edit_instructions separately for
          // structured queries.
          loggingService.logUserMessage({
            messageId: assistantMessageId,
            role: 'assistant',
            content: rawMessage ?? finalMessage,
            tokenUsage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined,
          });

          // Cost + usage tallies are tracked server-side in anthropic-stream.ts
          // via SSE `message_delta.usage` parsing.

          // Handle edit instructions if present. Check length — an empty
          // array is truthy in JS, so omitting this check causes the
          // whole graph-update + snapshot path to run for every reply
          // that parsed to zero edits (leading to a 500 on saveSnapshot
          // when the assistant message wasn't persisted).
          if (editInstructions && editInstructions.length > 0 && onGraphUpdate && graphData) {
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
          // Legacy keyword-based classifier for generic error strings. New
          // shapes (turnstile_required, idempotent_replay, body_too_large, …)
          // arrive via onCostError below with structured data; we don't rely
          // on the error-string path for them.
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
        },
        onCostUpdate: (runningUsd: number) => {
          setRunningCostUsd(runningUsd);
        },
        onCostError: (error) => {
          handleCostError(error);
          setIsStreaming(false);
          setStreamingContent('');
          setIsSearching(false);
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        },
      },
      signal: abortControllerRef.current?.signal,
      model: selectedModel,
      webSearchEnabled,
      customSystemPrompt,
      highlightedNodes,
      extendedThinkingEnabled: true,
      attachedFileIds,
      idempotencyKey,
      chartId: params.chartId ?? params.editToken,
      loggingMessageId: userMessageId,
      // userAnthropicKey: server-stored BYOK; the raw key is never retained client-side.
    });
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
            credentials: 'include',
            headers,
          });
        } catch (err) {
          console.warn('[ChatInterface] chart-files cleanup failed:', err);
        }
      })();
    }
  };


  // Upload a single PDF to the Files API. Returns the new file_id or throws.
  // Shared by Chat and Generate modes: Chat tracks chips in chatAttachedFiles,
  // Generate tracks them in generateAttachedChips. Returns early with an error
  // message if the chart hasn't been saved yet (the worker requires chart_id).
  // Tracks a chart id/edit token for charts auto-saved during this session.
  // params.chartId / params.editToken reflect the URL; history.replaceState
  // below updates the URL without a route re-render, so React Router params
  // won't catch the change. We read this ref as an additional source of
  // truth for subsequent uploads in the same session.
  const autosavedEditTokenRef = useRef<string | null>(null);
  const autosavedChartIdRef = useRef<string | null>(null);

  const uploadPdfToFilesApi = useCallback(
    async (
      file: File,
    ): Promise<{ file_id: string; filename: string; size_bytes: number; mime_type: string }> => {
      let chartIdForUpload = params.chartId ?? autosavedChartIdRef.current ?? params.editToken ?? autosavedEditTokenRef.current;
      if (!chartIdForUpload) {
        // Auto-save the chart so chart_files has a valid FK target. Uses
        // the in-memory graph (whatever the user has set up so far, or the
        // default template on a fresh `/` route).
        if (!graphData) {
          throw new Error('No chart data available to save');
        }
        const created = await ChartService.createChart(graphData);
        ChartService.saveEditToken(created.chartId, created.editToken);
        autosavedEditTokenRef.current = created.editToken;
        autosavedChartIdRef.current = created.chartId;
        // Update the URL in place so a page refresh finds the chart. No
        // route re-render (that would lose chip state).
        window.history.replaceState(null, '', `/edit/${created.editToken}`);
        onChartCreated?.(created.editToken, created.chartId);
        chartIdForUpload = created.chartId;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('chart_id', chartIdForUpload);

      const headers = await getAuthHeaders();
      const response = await fetch('/api/upload-file', {
        method: 'POST',
        credentials: 'include',
        headers, // multipart boundary set by the browser
        body: formData,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody?.error ?? `Upload failed (${response.status})`);
      }
      return response.json();
    },
    [getAuthHeaders, params.chartId, params.editToken, graphData, onChartCreated],
  );

  // Generate-mode file handler. Text files continue to be inlined via the
  // existing `files` state (parseText-decoded on pick). PDFs route through
  // the Files API: a chip in `generateAttachedChips` tracks the upload;
  // `generateAttachedFileIds` is the list forwarded to streamMessage as
  // document blocks, matching Chat mode.
  const handleFileUpload = useCallback(
    async (selectedFiles: FileList | File[]) => {
      const list = Array.from(selectedFiles);
      if (list.length === 0) return;

      for (const file of list) {
        const isPdf =
          file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

        if (isPdf) {
          const id = crypto.randomUUID();
          setGenerateAttachedChips((prev) => [
            ...prev,
            {
              id,
              filename: file.name,
              mimeType: file.type || 'application/pdf',
              sizeBytes: file.size,
              status: 'uploading',
              raw: file,
            },
          ]);
          try {
            const data = await uploadPdfToFilesApi(file);
            setGenerateAttachedChips((prev) =>
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
            setGenerateAttachedChips((prev) =>
              prev.map((f) =>
                f.id === id ? { ...f, status: 'error', error: message } : f,
              ),
            );
          }
          continue;
        }

        // Text-like file: keep the legacy inline flow.
        const uploadedFile: UploadedFile = { file, content: '', status: 'reading' };
        setFiles((prev) => [...prev, uploadedFile]);
        try {
          const result = await parseFile(file);
          if (result.success && result.kind === 'text') {
            uploadedFile.content = result.content;
            uploadedFile.status = 'ready';
          } else if (result.kind === 'error') {
            console.error('Error parsing file:', result.error);
            uploadedFile.content = '';
            uploadedFile.status = 'error';
            uploadedFile.errorMessage = result.error;
          }
        } catch (error) {
          console.error('Error reading file:', error);
          uploadedFile.status = 'error';
        }
        setFiles((prev) => prev.map((f) => (f.file === uploadedFile.file ? uploadedFile : f)));
      }
    },
    [uploadPdfToFilesApi],
  );

  // Retry a failed Generate-mode PDF upload in place.
  const handleGenerateFileRetry = useCallback(
    (id: string) => {
      // Snapshot the raw File and flip the chip back to 'uploading' before
      // kicking the async upload. Doing the mutation + read in two steps
      // keeps the state updater pure.
      let file: File | undefined;
      setGenerateAttachedChips((prev) => {
        file = prev.find((f) => f.id === id)?.raw;
        if (!file) return prev;
        return prev.map((f) =>
          f.id === id ? { ...f, status: 'uploading', error: undefined } : f,
        );
      });
      if (!file) return;

      void (async () => {
        try {
          const data = await uploadPdfToFilesApi(file);
          setGenerateAttachedChips((cur) =>
            cur.map((f) =>
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
          setGenerateAttachedChips((cur) =>
            cur.map((f) => (f.id === id ? { ...f, status: 'error', error: message } : f)),
          );
        }
      })();
    },
    [uploadPdfToFilesApi],
  );

  const handleGenerateFileRemove = useCallback((id: string) => {
    setGenerateAttachedChips((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const removeFile = (fileToRemove: File) => {
    setFiles(prev => prev.filter(f => f.file !== fileToRemove));
  };

  // File inputs for the Chat-mode paperclip. Separate ref so we can reset
  // the input value after each pick (browsers ignore re-picking the same
  // file without a clear).
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  // Upsert a chip into the chat attachment tray, preserving its visual
  // position on retries: if an entry with the same id already exists we
  // replace it in place; otherwise we append. Previously we filtered + re-
  // appended which reordered chips on retry.
  type ChatChip = (typeof chatAttachedFiles)[number];
  const upsertChip = useCallback((id: string, next: ChatChip) => {
    setChatAttachedFiles((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx === -1) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  // Upload a single file into the chat attachment tray. Text files are
  // inlined (carries `content`); PDFs are pushed to /api/upload-file and
  // the returned `file_id` is stored for the next message. On error the
  // chip flips to an error state with a Retry affordance.
  const uploadChatFile = useCallback(
    async (file: File, existingId?: string) => {
      const id = existingId ?? crypto.randomUUID();
      const parsed = await parseFile(file);

      if (parsed.kind === 'error') {
        upsertChip(id, {
          id,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          status: 'error',
          error: parsed.error,
          kind: 'text',
          raw: file,
        });
        return;
      }

      if (parsed.kind === 'text') {
        upsertChip(id, {
          id,
          filename: parsed.filename,
          mimeType: file.type || 'text/plain',
          sizeBytes: parsed.sizeBytes,
          status: 'ready',
          kind: 'text',
          content: parsed.content,
          raw: file,
        });
        return;
      }

      // kind === 'upload' — PDF flow via the Anthropic Files API proxy.
      // Chip starts in 'uploading', flips to 'ready' once the worker
      // returns a file_id, or 'error' on failure.
      upsertChip(id, {
        id,
        filename: parsed.filename,
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        status: 'uploading',
        kind: 'upload',
        raw: file,
      });

      try {
        const data = await uploadPdfToFilesApi(file);
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
    [uploadPdfToFilesApi, upsertChip],
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
    const readyTextFiles = files.filter((f) => f.status === 'ready').length;
    const readyPdfFiles = generateAttachedFileIds.length;
    if (readyTextFiles + readyPdfFiles === 0) {
      return;
    }
    // Block on in-flight PDF uploads so the request doesn't race the file_id.
    if (generateAttachedChips.some((f) => f.status === 'uploading')) {
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
      await chatService.streamMessage({
        messages: [generationMessage],
        currentGraphData: graphData,
        mode: 'generate',
        callbacks: {
          onContent: (_chunk: string, fullContent: string) => {
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
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
              cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usage.cache_read_input_tokens || 0,
              web_search_requests: usage.server_tool_use?.web_search_requests || 0,
              cost_usd: runningCostUsd ?? undefined,
            } : undefined
          };

          setMessages(prev => [...prev, assistantMessage]);
          setIsStreaming(false);
          setStreamingContent('');
          setIsThinking(false);
          setFullConversation(finalMessage);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;

          // Cost + usage tallies are tracked server-side; refresh the
          // progress bar now that the tally has landed.
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

          // Handle edit instructions if present (for regular chat mode).
          // Empty array is truthy; length check avoids triggering the
          // graph-update + snapshot path when Claude returned no edits.
          if (editInstructions && editInstructions.length > 0 && onGraphUpdate && graphData) {
            try {
              const updatedGraph = applyEdits(graphData, editInstructions);
              onGraphUpdate(updatedGraph);
            } catch (error) {
              console.error('Error applying graph edits:', error);
            }
          }
        },
        onError: (error: string) => {
          // See chat-site commentary: keyword classifier is the legacy
          // fallback for generic error strings; structured shapes arrive via
          // onCostError below.
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
        },
        onCostUpdate: (runningUsd: number) => {
          setRunningCostUsd(runningUsd);
        },
        onCostError: (error) => {
          handleCostError(error);
          setIsStreaming(false);
          setStreamingContent('');
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        },
      },
      signal: abortControllerRef.current?.signal,
      model: selectedModel,
      webSearchEnabled,
      customSystemPrompt,
      highlightedNodes,
      extendedThinkingEnabled: true,
      attachedFileIds: generateAttachedFileIds,
      idempotencyKey: crypto.randomUUID(), // fresh per send: dedupes browser reload / double-click
      chartId: params.chartId ?? params.editToken,
      loggingMessageId: userMessageId,
      // userAnthropicKey: server-stored BYOK; raw key not held client-side.
    });
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
                  <MessageBubble key={message.id} message={message} />
                ))}
              </>
            ) : currentMode === 'generate' ? (
              <div className="space-y-4">
                {/* Generate-mode BYOK gate. Generation concentrates cost
                    (extended thinking + web search + documents) into a
                    single one-shot request, so we require BYOK up front
                    before showing any input UI. Once the user submits a
                    verified key, hasKey flips and the full panel renders
                    below. */}
                {!hasKey || !verified ? (
                  <ByokPanel
                    mode="generate"
                    onSubmitted={() => {
                      void refreshUsage();
                    }}
                  />
                ) : (
                <>
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

                {/* First-upload privacy notice. Rendered above the file list
                    on the first file pick in either mode; persists across
                    sessions via the localStorage flag. */}
                {showFileUploadNotice &&
                  (files.length > 0 || generateAttachedChips.length > 0) && (
                    <div className="flex items-start gap-2 p-2 rounded-md border border-blue-200 bg-blue-50 text-xs text-blue-900">
                      <div className="flex-1">
                        Files are uploaded to Anthropic and kept until you remove them or delete
                        the chart. Not used to train AI models.
                      </div>
                      <button
                        type="button"
                        onClick={dismissFileUploadNotice}
                        className="ml-2 inline-flex items-center px-2 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700"
                      >
                        Got it
                      </button>
                    </div>
                  )}

                {/* Generate-mode PDF chips (Files API uploads). */}
                {generateAttachedChips.length > 0 && (
                  <AttachedFilesBar
                    files={generateAttachedChips}
                    onRemove={handleGenerateFileRemove}
                    onRetry={handleGenerateFileRetry}
                  />
                )}

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

                {(generateEstimateUsd > 0 || estimatingCost) && (
                  <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 flex items-center gap-2">
                    {estimatingCost && (
                      <span
                        className="w-3 h-3 border-[1.5px] border-gray-400 border-t-transparent rounded-full animate-spin"
                        aria-label="Recalculating estimate"
                      />
                    )}
                    {generateEstimateUsd > 0 ? (
                      <span>
                        Estimated input cost:{' '}
                        <strong>{formatCostUsd(generateEstimateUsd)}</strong>.
                        Output is billed on top as the response streams; hit Stop
                        to abort if it runs long.
                      </span>
                    ) : (
                      <span className="text-gray-500">Estimating…</span>
                    )}
                  </div>
                )}

                {/* Generate button. The BYOK gate is enforced upstream:
                    this render path is reached only when hasKey && verified,
                    so we don't need a fallback branch for the unkeyed case. */}
                <button
                  onClick={startGeneration}
                  disabled={
                    files.filter((f) => f.status === 'ready').length +
                      generateAttachedFileIds.length ===
                      0 ||
                    generateAttachedChips.some((f) => f.status === 'uploading') ||
                    isLoading
                  }
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
                </>
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
                hasTurnstileSession === null ? (
                  /* Probe in flight: reserve vertical space so the composer
                     doesn't shift in when it resolves, but render no content.
                     This avoids flashing the "please verify" banner on reload
                     for anon visitors who already hold a valid cookie. */
                  <div className="h-24" aria-hidden />
                ) : !isAuthenticated && TURNSTILE_SITE_KEY && !hasTurnstileSession ? (
                  /* Turnstile gate: block the entire composer for anonymous
                     visitors until they solve the challenge and we exchange
                     the token for a session cookie. Avoids the old behavior
                     where users could type + send and then see a cryptic 401
                     from the Worker. Once `hasTurnstileSession` flips true
                     the full composer below renders. If the Worker later
                     returns `turnstile_required` (cookie expired or IP
                     changed), `handleCostError` flips us back to this branch. */
                  <div className="space-y-2">
                    <div className="text-sm text-gray-700 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                      Solve the challenge below to verify you're human before sending a message. We do this once per 24 hours (or whenever your IP changes) to prevent abuse of the free tier.
                    </div>
                    <TurnstileWidget
                      siteKey={TURNSTILE_SITE_KEY}
                      onToken={handleTurnstileToken}
                    />
                    {turnstileError && (
                      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                        {turnstileError}
                      </div>
                    )}
                  </div>
                ) : (
                <div className="space-y-2">
                  {/* Selected Nodes Context */}
                  {selectedNodes.length > 0 && (
                    <div className="text-sm text-gray-600 mb-2">
                      {selectedNodes.length === 1 ? '1 node selected' : `${selectedNodes.length} nodes selected`}
                    </div>
                  )}
                  {!isAuthenticated && !TURNSTILE_SITE_KEY && import.meta.env.DEV ? (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      Anonymous quota unavailable (VITE_TURNSTILE_SITE_KEY unset); please sign in.
                    </div>
                  ) : null}
                  {/* First-upload privacy notice. Shown on the first chip
                      attachment in either mode; dismissed for good via the
                      localStorage flag. */}
                  {showFileUploadNotice && chatAttachedFiles.length > 0 && (
                    <div className="flex items-start gap-2 p-2 rounded-md border border-blue-200 bg-blue-50 text-xs text-blue-900">
                      <div className="flex-1">
                        Files are uploaded to Anthropic and kept until you remove them or delete
                        the chart. Not used to train AI models.
                      </div>
                      <button
                        type="button"
                        onClick={dismissFileUploadNotice}
                        className="ml-2 inline-flex items-center px-2 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700"
                      >
                        Got it
                      </button>
                    </div>
                  )}
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
                      // Auto-resize textarea based on content. Skip the
                      // scrollHeight measurement for large values — it forces
                      // a full text layout (~50-100ms for a 500KB paste) on
                      // every keystroke, which was the main culprit of the
                      // "paste huge text → UI freezes" bug. Anything past
                      // ~2000 chars is guaranteed to hit the 128px cap
                      // anyway, so just pin the height directly.
                      const target = e.target as HTMLTextAreaElement;
                      if (target.value.length > 2000) {
                        if (target.style.height !== '128px') {
                          target.style.height = '128px';
                        }
                        return;
                      }
                      target.style.height = 'auto';
                      const newHeight = Math.min(target.scrollHeight, 128);
                      target.style.height = newHeight + 'px';
                    }}
                  />
                  {(composerEstimateUsd > 0 || estimatingCost) && (
                    <div className="text-xs text-gray-500 flex items-center gap-1.5">
                      {estimatingCost && (
                        <span
                          className="w-3 h-3 border-[1.5px] border-gray-400 border-t-transparent rounded-full animate-spin"
                          aria-label="Recalculating estimate"
                        />
                      )}
                      {composerEstimateUsd > 0 ? (
                        <span>
                          Estimated input cost: {formatCostUsd(composerEstimateUsd)}; output
                          shown live during streaming.
                        </span>
                      ) : (
                        <span className="text-gray-400">Estimating…</span>
                      )}
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
                          // Use length check rather than trim() — on a huge
                          // paste, inputValue.trim() would allocate a full
                          // copy of the string on every render. Whitespace-
                          // only input still gets rejected at send-time.
                          disabled={inputValue.length === 0 || isLoading}
                          className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Send message"
                        >
                          <PaperAirplaneIcon className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                )
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