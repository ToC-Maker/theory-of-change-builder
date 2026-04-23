import React, { useCallback, useState, useRef, useEffect, useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import { useParams, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { chatService, ChatMessage, type CostError } from '../services/chatService';
import { ChartService } from '../services/chartService';
import { applyEdits, prepareStreamingDisplay } from '../utils/graphEdits';
import { loggingService } from '../services/loggingService';
import { useApiKey } from '../contexts/ApiKeyContext';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { parseGeneratedGraph, hasGeneratedGraph } from '../utils/parseGeneratedGraph';
import { MDXEditorComponent } from './MDXEditor';
import { parseFile, getFileTypeDescription } from '../utils/fileParser';
import { addByokSpend, useChartByokSpendUsd } from '../utils/byokSpend';
import { ByokPanel, DonateCta } from './ByokPanel';
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
  StopIcon,
  SparklesIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline';

export type AIMode = 'chat' | 'generate';

interface UploadedFile {
  file: File;
  content: string;
  status: 'reading' | 'ready' | 'error';
  errorMessage?: string;
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
  // Flips true when the CF iframe has actually fired its `load` event, i.e.
  // the challenge UI is drawn and ready for the user. Stays false through
  // the full loading window: script-download → render() → iframe creation
  // → iframe paint. A 5s timeout fallback hides the placeholder regardless
  // in case the load event never fires (offline iframe, adblock quirks).
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (!siteKey) return;

    let cancelled = false;
    setRendered(false);
    let mutationObserver: MutationObserver | null = null;
    let loadListener: ((ev: Event) => void) | null = null;
    let loadTarget: HTMLIFrameElement | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const markRendered = () => {
      if (!cancelled) setRendered(true);
    };

    const attachLoadListener = (iframe: HTMLIFrameElement) => {
      loadTarget = iframe;
      loadListener = () => markRendered();
      iframe.addEventListener('load', loadListener);
    };

    const waitForIframe = () => {
      if (!containerRef.current) return false;
      const iframe = containerRef.current.querySelector('iframe');
      if (iframe) {
        attachLoadListener(iframe);
        return true;
      }
      return false;
    };

    const renderWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
      if (!widgetIdRef.current) return;
      // render() returns synchronously once the DOM node is queued, but the
      // iframe isn't always present in this tick and its content needs more
      // time to paint. Wait for the iframe's load event so the placeholder
      // covers the full visual gap.
      if (!waitForIframe() && containerRef.current) {
        mutationObserver = new MutationObserver(() => {
          if (waitForIframe()) {
            mutationObserver?.disconnect();
            mutationObserver = null;
          }
        });
        mutationObserver.observe(containerRef.current, {
          childList: true,
          subtree: true,
        });
      }
      // Safety: if load never fires (adblock, offline iframe shell), hide
      // the placeholder after 5s so the user sees whatever state the widget
      // is actually in.
      fallbackTimer = setTimeout(markRendered, 5_000);
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
      mutationObserver?.disconnect();
      mutationObserver = null;
      if (loadTarget && loadListener) {
        loadTarget.removeEventListener('load', loadListener);
      }
      loadTarget = null;
      loadListener = null;
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
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
  // The placeholder sits on top of the widget container via absolute
  // positioning and matches Turnstile's default widget size (300×65) so the
  // UI doesn't jump when the iframe paints. `rendered` flips true once
  // `render()` returns — strictly that's before the iframe is fully drawn,
  // but CF fills the iframe fast enough that the 50-100ms gap isn't
  // perceptible; the far slower window is the script-download phase before
  // render() has even run.
  return (
    <div className="relative inline-block min-h-[65px] min-w-[300px]">
      <div ref={containerRef} className="cf-turnstile" />
      {!rendered && (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-gray-50 text-sm text-gray-600"
          role="status"
          aria-live="polite"
        >
          <span
            className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"
            aria-hidden
          />
          <span>Loading challenge…</span>
        </div>
      )}
    </div>
  );
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
  const { hasKey, keyLast4, verified, keyVersion } = useApiKey();
  const { isAuthenticated, getIdTokenClaims } = useAuth0();
  const [currentMode, setCurrentMode] = useState<AIMode>('chat');
  const [selectedModel, setSelectedModel] = useState<keyof typeof MODELS>('claude-opus-4-7');

  // Get route parameters to create unique storage key
  const params = useParams<{ filename?: string; chartId?: string; editToken?: string }>();
  const location = useLocation();

  // BYOK spend displayed in the sidebar pill. Derived from localStorage via a
  // custom event subscription, so it updates live as streams credit spend.
  const chartByokSpendUsd = useChartByokSpendUsd(
    params.chartId ?? params.editToken ?? null,
  );

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
  // Live thinking text from Anthropic's extended-thinking blocks. Rendered
  // as a collapsible summary alongside the streamed reply so users can see
  // the model's reasoning rather than just a "Thinking…" spinner.
  const [streamingThinking, setStreamingThinking] = useState('');
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  // Extended thinking is always enabled on Opus 4.7; the server defaults to
  // adaptive thinking when extendedThinkingEnabled is omitted/true.

  // Usage / progress bar state populated from /api/usage. `tier` is one of
  // 'anon' | 'free' | 'byok' (see worker/_shared/tiers.ts); null until the
  // first fetch returns.
  const [usage, setUsage] = useState<{
    used_usd: number;
    limit_usd: number;
    tier: string;
  } | null>(null);

  // Running cost for the in-flight assistant turn (updated via onCostUpdate).
  const [runningCostUsd, setRunningCostUsd] = useState<number | null>(null);
  // Ref-mirror so onComplete can read the latest cost — the closure captured
  // at handleSend time would otherwise see a stale value.
  const runningCostUsdRef = useRef<number | null>(null);
  // Running tally of BYOK spend (in µUSD) already credited to the
  // chart/key buckets for the current turn. Each onCostUpdate computes a
  // delta against this ref so aborted streams still capture the portion
  // that was actually billed. Reset to 0 at the start of each handleSend.
  const turnLastAppliedMicroRef = useRef<number>(0);


  // Pre-send cost estimates (input-only lower bound from count_tokens).
  // Separate slots so the Chat composer estimate and the Generate panel
  // estimate can update independently; both are debounced to avoid
  // hammering /api/count-tokens-estimate on every keystroke.
  const [composerEstimateUsd, setComposerEstimateUsd] = useState<number>(0);
  // Last upstream message from /api/count-tokens-estimate when it fails.
  // Rendered inline so shape issues (file_id unresolvable, etc.) surface
  // to the user instead of silently falling back to a char-based estimate.
  const [composerEstimateError, setComposerEstimateError] = useState<string | null>(null);
  const [generateEstimateUsd, setGenerateEstimateUsd] = useState<number>(0);

  // Derived cap-gate flags, computed from the cached usage snapshot +
  // latest composer estimate. Declared AFTER composerEstimateUsd since
  // wouldExceedCap reads it — moving these earlier would TDZ-error.
  //
  //   capAlreadyReached: the user's prior cumulative usage is already at
  //     or over the free-tier cap. Nothing they can send will succeed;
  //     only BYOK unlocks new turns.
  //
  //   wouldExceedCap: prior usage is under the cap but the projected cost
  //     of the in-flight draft would push it over. Sending this specific
  //     message would fail the server's reservation; we block client-side
  //     to avoid the round-trip (and the confusing Turnstile-before-cap
  //     ordering on the server).
  //
  // BYOK tier skips both — they're self-funded.
  const capped = usage != null && usage.tier !== 'byok';
  const capAlreadyReached = capped && usage.used_usd >= usage.limit_usd;
  const wouldExceedCap =
    capped &&
    !capAlreadyReached &&
    composerEstimateUsd > 0 &&
    usage.used_usd + composerEstimateUsd > usage.limit_usd;
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

  // BYOK panel state for 402/kill recovery.
  //
  // Note there's no 'cap_reached' here: server 429 `lifetime_cap_reached`
  // is handled by calling refreshUsage(), which flips the derived
  // `capAlreadyReached` flag and shows the composer-side banner. A
  // separate mode would double-render the panel. Voluntary key entry
  // now lives in the profile-dropdown modal, not inline.
  const [byokPanelMode, setByokPanelMode] = useState<
    'request_cut_off' | 'global_budget' | null
  >(null);

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
    // Re-fetch on mount and whenever the user adds/removes their BYOK key
    // (keyVersion bumps in ApiKeyContext). Without the keyVersion trigger,
    // the sidebar still shows the free-tier progress bar after a key is
    // added until the next stream completes.
    void refreshUsage();
  }, [refreshUsage, keyVersion]);

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
        // Server rejected the preflight reservation — our local usage
        // snapshot was stale. Refresh so `capAlreadyReached` flips and
        // the composer-side cap banner + ByokPanel + DonateCta appear.
        // No separate mode state: that would double-render the panel.
        setCostErrorBanner(null);
        void refreshUsage();
        return;
      case 'global_budget_exhausted':
        setByokPanelMode('global_budget');
        setCostErrorBanner(null);
        return;
      case 'request_cost_ceiling_exceeded':
        // Mid-stream kill: the message already ran part-way, the reconcile
        // path is writing the actual cost to the DB right now. Surface the
        // cut-off-specific ByokPanel header and refresh usage so the cap
        // bar reflects reality — otherwise it stays at the pre-stream
        // snapshot until manual reload.
        setByokPanelMode('request_cut_off');
        setCostErrorBanner(null);
        void refreshUsage();
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
      default: {
        // database_unavailable / estimation_unavailable /
        // authentication_service_unavailable / invalid_token all fall
        // through to a generic service banner. When the server included
        // an upstream_message (e.g. Anthropic's count_tokens 429 reason,
        // Neon timeout detail, Auth0 JWKS error), surface it so the user
        // has something specific to try or report rather than just
        // "something broke."
        const data = error.data as { upstream_status?: number; upstream_message?: string } | undefined;
        const upstreamMessage = typeof data?.upstream_message === 'string' ? data.upstream_message : null;
        const upstreamStatus = typeof data?.upstream_status === 'number' ? data.upstream_status : null;
        const detail = upstreamMessage
          ? `${COST_ERROR_COPY.service_unavailable} (${error.type}${upstreamStatus ? ` ${upstreamStatus}` : ''}: ${upstreamMessage})`
          : `${COST_ERROR_COPY.service_unavailable} (${error.type})`;
        setCostErrorBanner({ kind: 'service_unavailable', message: detail });
      }
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
        // Actor identity may have changed at the same time (IP flip or
        // cookie renewal), which would mean a different row in
        // user_api_usage. Refresh so the UI's usage bar + wouldExceedCap
        // gate reflect the current identity, not the stale one.
        void refreshUsage();
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
      // File uploads count as draft content even without any typed text —
      // a PDF alone can be 100k+ tokens and the composer should show that
      // BEFORE the user starts typing. Previously this early-return hid
      // the estimate until the user typed a character.
      const hasUploadedFiles = chatAttachedFiles.some(
        (f) => f.kind === 'upload' && f.status === 'ready' && f.fileId,
      );
      if (draftChars === 0 && messages.length === 0 && !hasUploadedFiles) {
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

      // Anthropic-Files-API uploads (PDFs): send as `document` content blocks
      // so count_tokens counts the PDF text. Without this the estimate
      // silently ignores the attached PDFs' token cost — easy to hit a
      // 429 at send-time from a "safe-looking" composer number.
      const uploadFiles = chatAttachedFiles.filter(
        (f) => f.kind === 'upload' && f.status === 'ready' && f.fileId,
      );
      const uploadPageCount = uploadFiles.reduce(
        (sum, f) => sum + (f.kind === 'upload' ? f.pageCount : 0),
        0,
      );
      const userContent: unknown = uploadFiles.length > 0
        ? [
            ...uploadFiles.map((f) => ({
              type: 'document' as const,
              source: { type: 'file' as const, file_id: f.fileId! },
            })),
            { type: 'text' as const, text: draftBody },
          ]
        : draftBody;

      const baseSystemPrompt = customSystemPromptRef.current?.trim() || systemPromptContent;
      const systemPrompt = `${baseSystemPrompt}\n\n${chatModePromptContent}`;
      const historyForEstimate = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const hasDraftContent = draftBody.length > 0 || uploadFiles.length > 0;
      const messagesForEstimate = hasDraftContent
        ? [...historyForEstimate, { role: 'user' as const, content: userContent }]
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
          if (!response.ok) {
            // Surface upstream detail so shape issues (e.g. file_id
            // unresolvable in count_tokens, beta header mismatch) are
            // diagnosable from the composer instead of silently falling
            // back to the local char estimate.
            let upstreamMessage: string | null = null;
            try {
              const body = await response.json() as { upstream_message?: string };
              if (typeof body.upstream_message === 'string') upstreamMessage = body.upstream_message;
            } catch { /* non-JSON body */ }
            setComposerEstimateError(upstreamMessage);
            throw new Error(`status ${response.status}`);
          }
          setComposerEstimateError(null);
          const data = (await response.json()) as {
            input_tokens?: number;
            estimated_cost_usd?: number;
            cached_file_tokens?: number;
          };
          const totalTokens = data.input_tokens ?? 0;
          const inputRate = MODEL_INPUT_RATES_USD_PER_MTOK[selectedModel] ?? 5;
          // Server returns input_tokens already including the precise
          // cached token counts for any attached files (from
          // chart_files.input_tokens, counted at upload time). We just need
          // to split the total into draft-side vs history-side for the
          // warm-cache 1.25× / 0.1× multipliers. Char-to-token ratio is
          // ~4:1 for text; for PDF tokens we trust the server's
          // cached_file_tokens (which is a count_tokens call from upload
          // time, not a heuristic).
          const CHAR_PER_TOKEN = 4;
          const draftTextTokensEst = Math.ceil(draftBody.length / CHAR_PER_TOKEN);
          const pdfTokensEst = data.cached_file_tokens ?? 0;
          const draftTokensEst = draftTextTokensEst + pdfTokensEst;
          const historyCharSum =
            systemPrompt.length +
            messages.reduce(
              (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
              0,
            );
          const historyTokensEst = Math.ceil(historyCharSum / CHAR_PER_TOKEN);
          const denom = draftTokensEst + historyTokensEst;
          const draftOnlyTokens =
            totalTokens > 0 && denom > 0
              ? Math.round(totalTokens * (draftTokensEst / denom))
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
          if (!response.ok) {
            // Surface upstream detail so shape issues (e.g. file_id
            // unresolvable in count_tokens, beta header mismatch) are
            // diagnosable from the composer instead of silently falling
            // back to the local char estimate.
            let upstreamMessage: string | null = null;
            try {
              const body = await response.json() as { upstream_message?: string };
              if (typeof body.upstream_message === 'string') upstreamMessage = body.upstream_message;
            } catch { /* non-JSON body */ }
            setComposerEstimateError(upstreamMessage);
            throw new Error(`status ${response.status}`);
          }
          setComposerEstimateError(null);
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
      setStreamingContent(''); setStreamingThinking('');
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

    // Block client-side when we already know the send will fail the
    // server's reservation. Avoids the round-trip, and more importantly
    // avoids the Turnstile-checks-first race where the user sees a
    // Turnstile re-challenge instead of the BYOK path they actually need.
    // UI already renders a warning + BYOK panel in this state; the send
    // button is also disabled, this is a defense-in-depth guard.
    if (capAlreadyReached || wouldExceedCap) return;

    // Persist the chart NOW, before we log the user message. Without this,
    // a first send on the `/` root URL has no chart_id → loggingService's
    // session can't init → logUserMessage silently drops the message, and
    // the worker's X-Logging-Message-Id is never sent, so the reconcile
    // can't populate logging_messages.cost_micro_usd either. Idempotent
    // when the chart already exists.
    await ensureChartExists();

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
    setStreamingContent(''); setStreamingThinking('');
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

    // Snapshot BYOK + chart identifiers at stream start so onCostUpdate can
    // credit partial spend to the right bucket even if state changes mid-stream
    // (e.g. user navigates away). Use delta accumulation so aborted streams
    // still record the portion that was billed.
    const streamChartId = params.chartId ?? params.editToken ?? null;
    const streamKeyLast4 = keyLast4;
    const streamUsesByok = hasKey;
    turnLastAppliedMicroRef.current = 0;

    try {
      await chatService.streamMessage({
        messages: [...messages, userMessage],
        currentGraphData: graphData,
        mode: 'chat',
        callbacks: {
          onSearchStart: () => {
            setIsSearching(true);
          },
          onSearchComplete: () => {
            setIsSearching(false);
          },
          onContent: (_chunk: string, fullContent: string) => {
            // Clear thinking state when content starts streaming
            if (isThinking) {
              setIsThinking(false);
            }
            setStreamingContent(fullContent);
            // Mirror into the ref so onCostError can preserve the partial
            // text when the stream is killed mid-turn. Without this the
            // ref's `content` stays at '' (only ever assigned at stream
            // start) and the kill-recovery path falls back to the
            // "cut off before writing a visible response" placeholder —
            // even when text deltas did arrive.
            if (streamingMessageRef.current) {
              streamingMessageRef.current.content = fullContent;
            }
          },
          onThinking: (_chunk: string, fullThinking: string) => {
            setStreamingThinking(fullThinking);
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
          setStreamingContent(''); setStreamingThinking('');
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
          setStreamingContent(''); setStreamingThinking('');
          setIsSearching(false);
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        },
        onCostUpdate: (runningUsd: number) => {
          // Delta-credit the per-chart and per-key BYOK buckets during the
          // stream so partial costs (aborted, errored, or killed streams)
          // still record whatever the user was billed up to that point.
          if (streamUsesByok) {
            const newMicro = Math.round(runningUsd * 1_000_000);
            const deltaMicro = newMicro - turnLastAppliedMicroRef.current;
            if (deltaMicro > 0) {
              addByokSpend(streamChartId, streamKeyLast4, deltaMicro / 1_000_000);
              turnLastAppliedMicroRef.current = newMicro;
            }
          }
          runningCostUsdRef.current = runningUsd;
          setRunningCostUsd(runningUsd);
        },
        onCostError: (error) => {
          // Preserve whatever partial content streamed before the kill so the
          // user can still read it. Without this the entire assistant turn
          // would vanish from the chat window on a mid-stream cap hit. Even
          // when no visible text arrived (model was still thinking), keep a
          // placeholder so the conversation history shows the turn happened.
          const partial = streamingMessageRef.current;
          if (partial) {
            const hasText = partial.content.length > 0;
            setMessages((prev) => [
              ...prev,
              hasText
                ? partial
                : {
                    ...partial,
                    content: '_(Assistant was cut off before writing a visible response.)_',
                  },
            ]);
          }
          handleCostError(error);
          setIsStreaming(false);
          setStreamingContent(''); setStreamingThinking('');
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
      setStreamingContent(''); setStreamingThinking('');
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

  /**
   * Ensure the chat has a persisted chart before doing anything that needs a
   * chart_id (file uploads, logging, per-chart BYOK spend, etc.). For the
   * `/` root route this lazily POSTs `/api/charts` on demand; for the
   * `/edit/<token>` and `/chart/<id>` routes the chart already exists and
   * we just return its id. Idempotent — safe to call multiple times.
   *
   * Side effects on first creation: updates the URL to
   * `/edit/<editToken>` (replaceState, no route re-render) and fires
   * `onChartCreated`, which in App.tsx triggers `initializeLogging` — so
   * the logging session is up before the first saveMessage lands.
   */
  const ensureChartExists = useCallback(async (): Promise<{
    chartId: string;
    editToken: string;
  } | null> => {
    const existingChartId = params.chartId ?? autosavedChartIdRef.current;
    const existingEditToken = params.editToken ?? autosavedEditTokenRef.current;
    if (existingChartId && existingEditToken) {
      return { chartId: existingChartId, editToken: existingEditToken };
    }
    if (!graphData) return null;
    try {
      const created = await ChartService.createChart(graphData);
      ChartService.saveEditToken(created.chartId, created.editToken);
      autosavedEditTokenRef.current = created.editToken;
      autosavedChartIdRef.current = created.chartId;
      window.history.replaceState(null, '', `/edit/${created.editToken}`);
      onChartCreated?.(created.editToken, created.chartId);
      return { chartId: created.chartId, editToken: created.editToken };
    } catch (e) {
      console.error('[ChatInterface] ensureChartExists failed:', e);
      return null;
    }
  }, [params.chartId, params.editToken, graphData, onChartCreated]);

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
    setStreamingContent(''); setStreamingThinking('');
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

    // See chat-path comment above; Generate is always BYOK (hasKey required
    // to render the panel) but still snapshot for parity and to survive the
    // unlikely case of a key swap mid-stream.
    const streamChartId = params.chartId ?? params.editToken ?? null;
    const streamKeyLast4 = keyLast4;
    const streamUsesByok = hasKey;
    turnLastAppliedMicroRef.current = 0;

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
            // Mirror into the ref so onCostError can preserve the partial
            // text when the stream is killed mid-turn. Without this the
            // ref's `content` stays at '' (only ever assigned at stream
            // start) and the kill-recovery path falls back to the
            // "cut off before writing a visible response" placeholder —
            // even when text deltas did arrive.
            if (streamingMessageRef.current) {
              streamingMessageRef.current.content = fullContent;
            }
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
          setStreamingContent(''); setStreamingThinking('');
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
          setStreamingContent(''); setStreamingThinking('');
          setIsThinking(false);
          setRunningCostUsd(null);
          streamingMessageRef.current = null;
        },
        onCostUpdate: (runningUsd: number) => {
          // Delta-credit the per-chart and per-key BYOK buckets during the
          // stream so partial costs (aborted, errored, or killed streams)
          // still record whatever the user was billed up to that point.
          if (streamUsesByok) {
            const newMicro = Math.round(runningUsd * 1_000_000);
            const deltaMicro = newMicro - turnLastAppliedMicroRef.current;
            if (deltaMicro > 0) {
              addByokSpend(streamChartId, streamKeyLast4, deltaMicro / 1_000_000);
              turnLastAppliedMicroRef.current = newMicro;
            }
          }
          runningCostUsdRef.current = runningUsd;
          setRunningCostUsd(runningUsd);
        },
        onCostError: (error) => {
          // Preserve the partial Generate turn (text/thinking streamed
          // before the kill) so it's still visible in the chat. Even with
          // no visible text (cut off mid-thinking), keep a placeholder.
          const partial = streamingMessageRef.current;
          if (partial) {
            const hasText = partial.content.length > 0;
            setMessages((prev) => [
              ...prev,
              hasText
                ? partial
                : {
                    ...partial,
                    content: '_(Assistant was cut off before writing a visible response.)_',
                  },
            ]);
          }
          handleCostError(error);
          setIsStreaming(false);
          setStreamingContent(''); setStreamingThinking('');
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
      setStreamingContent(''); setStreamingThinking('');
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
                {currentMode === 'chat' && messages.length > 0 && (
                  <button
                    onClick={() => {
                      // Destructive: wipes the in-memory chat + attached files +
                      // any uploaded file chips from the server. Confirm first so
                      // a mis-click can't silently delete a long conversation.
                      if (window.confirm(
                        'Clear the entire chat? This removes all messages and any files attached in Chat. Your chart and Generate state are unaffected.',
                      )) {
                        clearChat();
                      }
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 p-1 rounded"
                    title="Clear chat"
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
            </div>

            {/* Usage / quota indicator. BYOK users see a pill instead of a
                progress bar (no shared pool is consumed). Key management
                (change/remove) lives in the profile dropdown's "Anthropic
                API key" modal. The per-chart spend figure is a best-effort
                client-side tally (localStorage); Anthropic's dashboard is
                the source of truth for billing. */}
            {usage && (
              <div className="mt-2">
                {usage.tier === 'byok' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-gray-700">
                    <span aria-hidden>🔑</span>
                    <span>
                      BYOK{keyLast4 ? ` · ...${keyLast4}` : ''}
                      {chartByokSpendUsd > 0 && (
                        <> &middot; {formatCostUsd(chartByokSpendUsd)} this chart</>
                      )}
                    </span>
                  </span>
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
            className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3"
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
                  <div className="space-y-3">
                    {/* Generate-specific cost heads-up — separate card so
                        the BYOK panel stays context-free and reusable. */}
                    <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      Generate runs a deep analysis of your documents. A single run
                      typically costs a few dollars — more for large documents or
                      heavy web searching. The running cost is shown as the answer
                      is written, so you can stop it at any time if it starts to
                      add up.
                    </div>
                    <ByokPanel
                      onSubmitted={() => {
                        void refreshUsage();
                      }}
                    />
                  </div>
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
            ) : null}

            {/* Chat mode streaming indicators */}
            {currentMode === 'chat' && (
              <>
                {/* In-flight assistant turn. Ordering is deliberate:
                      1. Streaming text bubble (main response)
                      2. Thinking summary (collapsible) — the model's
                         reasoning, rendered muted below the answer so
                         users can expand when curious without it
                         dominating the conversation view
                      3. Searching / Thinking status chips BELOW the
                         bubble — they represent "still working on it,"
                         which is more legible after the partial text
                         than crowding above it.
                    prepareStreamingDisplay hides any in-progress
                    [EDIT_INSTRUCTIONS]...[/EDIT_INSTRUCTIONS] block whose
                    closing tag hasn't arrived yet and returns
                    generatingEdits=true for the dedicated indicator. */}
                {isStreaming && (streamingContent || streamingThinking) && (() => {
                  const { display, generatingEdits } = streamingContent
                    ? prepareStreamingDisplay(streamingContent)
                    : { display: '', generatingEdits: false };
                  const hasAnything = display || generatingEdits || streamingThinking;
                  if (!hasAnything) return null;
                  return (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] p-2 rounded-lg text-sm bg-gray-100 text-gray-800 rounded-bl-sm">
                        {display && (
                          <div className="text-left prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-200 prose-pre:text-gray-800">
                            <ReactMarkdown>{display}</ReactMarkdown>
                          </div>
                        )}
                        {generatingEdits && (
                          <div className={`flex items-center gap-2 text-xs text-amber-800 ${display ? 'mt-2' : ''}`}>
                            <PencilSquareIcon className="w-4 h-4 animate-pulse text-amber-600" aria-hidden />
                            <span>Generating edits to the graph…</span>
                          </div>
                        )}
                        {streamingThinking && (
                          <details
                            className={`text-xs text-gray-500 ${display || generatingEdits ? 'mt-2 pt-2 border-t border-gray-200' : ''}`}
                            open={thinkingExpanded}
                            onToggle={(e) => setThinkingExpanded((e.target as HTMLDetailsElement).open)}
                          >
                            <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-800 inline-flex items-center gap-1">
                              <SparklesIcon className="w-3.5 h-3.5 text-purple-500" aria-hidden />
                              <span>{thinkingExpanded ? 'Hide thinking' : 'Show thinking'}</span>
                            </summary>
                            <div className="mt-1 whitespace-pre-wrap italic text-gray-600 leading-relaxed">
                              {streamingThinking}
                            </div>
                          </details>
                        )}
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
                  );
                })()}

                {/* Status chips BELOW the streaming bubble — tells the user
                    "still working on it" next to the partial text, not
                    above it where they'd scroll past to find it. */}
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

                {/* Cost-error banner for non-cap errors that don't merit
                    the full BYOK panel (body-too-large, chart-deleted,
                    service-unavailable, etc.). Cap/quota errors go
                    straight to the inline ByokPanel below via
                    handleCostError. */}
                {costErrorBanner && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] p-3 rounded-lg text-sm bg-amber-50 border border-amber-200 text-amber-900">
                      {costErrorBanner.message}
                    </div>
                  </div>
                )}

                {/* mid-stream-kill (request_cut_off) and global-budget
                    banners now render in the composer area (below) so they
                    sit next to the input rather than scrolling away in the
                    message history. See the composer-side render. */}

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
                  {/* Blocking cap warning. Two distinct cases:
                        - capAlreadyReached: prior cumulative usage already at
                          or over the cap; no sends possible without BYOK.
                        - wouldExceedCap: under cap but this draft's estimate
                          would push over. Message-specific framing so users
                          understand "this one is too big" vs "you're out."
                      Composer and send button stay visible but disabled; the
                      inline BYOK panel is the unblock path. */}
                  {/* Four cap/quota paths, all shown above the input so
                      the user can read them next to the action. Priority
                      from "most recent event" down:
                        - request_cut_off: mid-stream kill just fired.
                        - global_budget: Anthropic Console cap hit.
                        - capAlreadyReached: prior cumulative at/over cap.
                        - wouldExceedCap: draft's estimate would push over.
                      DonateCta only on paths where donations are a valid
                      alternative (capAlreadyReached, global_budget). */}
                  {byokPanelMode === 'request_cut_off' ? (
                    <div className="space-y-2">
                      <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                        Message cut off — your last message used the rest of the free
                        quota. Add your Anthropic API key to keep going.
                      </div>
                      <ByokPanel
                        onSubmitted={() => {
                          setByokPanelMode(null);
                          setCostErrorBanner(null);
                          void refreshUsage();
                        }}
                      />
                    </div>
                  ) : byokPanelMode === 'global_budget' ? (
                    <div className="space-y-2">
                      <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                        We&apos;ve hit our shared monthly spend cap. Everyone on the free
                        tier is paused until next month&apos;s reset.
                      </div>
                      <ByokPanel
                        onSubmitted={() => {
                          setByokPanelMode(null);
                          setCostErrorBanner(null);
                          void refreshUsage();
                        }}
                      />
                      <DonateCta />
                    </div>
                  ) : capAlreadyReached ? (
                    <div className="space-y-2">
                      <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                        You&apos;ve used the free quota of {formatCostUsd(usage!.limit_usd)}.
                        Add your Anthropic API key to keep going.
                      </div>
                      <ByokPanel
                        onSubmitted={() => {
                          setCostErrorBanner(null);
                          void refreshUsage();
                        }}
                      />
                      <DonateCta />
                    </div>
                  ) : wouldExceedCap ? (
                    <div className="space-y-2">
                      <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                        This message (estimated{' '}
                        <strong>{formatCostUsd(composerEstimateUsd)}</strong> input) would
                        take you over the free quota of{' '}
                        <strong>{formatCostUsd(usage!.limit_usd)}</strong> —{' '}
                        {formatCostUsd(Math.max(0, usage!.limit_usd - usage!.used_usd))}{' '}
                        left. Add your Anthropic API key to send it, or shorten it below
                        the remaining budget.
                      </div>
                      <ByokPanel
                        onSubmitted={() => {
                          setCostErrorBanner(null);
                          void refreshUsage();
                        }}
                      />
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
                  {composerEstimateError && (
                    <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      Estimation failed: {composerEstimateError}. Fell back to a
                      rough local estimate; the actual reservation may differ.
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
                          // capAlreadyReached / wouldExceedCap disable here
                          // as a visual cue; handleSendMessage also early-
                          // returns on both.
                          disabled={
                            inputValue.length === 0
                            || isLoading
                            || capAlreadyReached
                            || wouldExceedCap
                            // Block while any attached file is still uploading;
                            // send would early-return server-side, but a
                            // greyed button is clearer than a silent no-op.
                            || chatAttachedFiles.some((f) => f.status === 'uploading')
                          }
                          className="p-2 bg-blue-500 text-white rounded-lg enabled:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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