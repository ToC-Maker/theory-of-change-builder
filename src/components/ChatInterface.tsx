import React, { useCallback, useMemo, useState, useRef, useEffect, useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { Tooltip } from 'react-tooltip';
import {
  chatService,
  ChatMessage,
  type CostError,
  type StreamPhase,
  setReconcilePillBump,
} from '../services/chatService';
import type { AssistantBlock } from '../../shared/chat-blocks';
import { MODEL_CAPABILITIES, type EffortLevel } from '../../shared/pricing';
import { ChartService } from '../services/chartService';
import { buildOutgoingMessages } from '../services/outgoingMessages';
import { applyEdits, prepareStreamingDisplay } from '../utils/graphEdits';
import { loggingService } from '../services/loggingService';
import { useApiKey } from '../contexts/useApiKey';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { parseGeneratedGraph, hasGeneratedGraph } from '../utils/parseGeneratedGraph';
import { parseFile } from '../utils/fileParser';
import { addByokSpend, setChartSpendIfHigher, useChartByokSpendUsd } from '../utils/byokSpend';
import { TOP_BAR_HEIGHT_PX } from '../hooks/useViewportOffset';
import { getFreshIdToken } from '../utils/auth';
import { AttachedFilesBar, type AttachedFile } from './AttachedFilesBar';
import {
  type ComposerBlocker,
  type EstimateFailure,
  type RenderedBlocker,
  bannerCarriesEstimateStatus,
  costErrorToBlocker,
  estimateUnavailableNote,
  selectBlocker,
  shouldBlockSend,
  preserveCapClassOnly,
} from './chat/composerBlocker';
import { ComposerBlockerBanner } from './chat/ComposerBlockerBanner';
import { useAuthSessionDegraded } from '../hooks/useAuthSessionDegraded';
import { useClampedPopoverX } from './chat/useClampedPopoverX';
import { ConfirmModal } from './ConfirmModal';
import type { ToCData } from '../types';
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
  MagnifyingGlassIcon,
  ChevronDownIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  DocumentPlusIcon,
  ArrowUpTrayIcon,
  ChatBubbleLeftRightIcon,
  DocumentTextIcon,
  StopIcon,
  SparklesIcon,
  PencilSquareIcon,
  InformationCircleIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';

/**
 * Load chat history from localStorage, moving any corrupt blob aside to a
 * timestamped backup key before returning [].
 *
 * Without the backup-aside, a corrupt parse + the user typing one new message
 * would have the save effect overwrite the unparseable blob with a single-
 * message array — silently destroying any history we might have recovered
 * forensically (or by hand-editing localStorage). Moving the bad blob to
 * `${storageKey}_corrupt_${ts}` preserves it without blocking normal use.
 */
function loadChatHistoryWithBackup(storageKey: string): ChatMessage[] {
  let savedMessages: string | null;
  try {
    savedMessages = localStorage.getItem(storageKey);
  } catch (e) {
    console.error('[ChatHistory] localStorage.getItem failed:', e);
    return [];
  }
  if (!savedMessages) return [];
  try {
    type StoredMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };
    const parsed = JSON.parse(savedMessages) as StoredMessage[];
    return parsed.map((msg) => ({
      ...msg,
      timestamp: new Date(msg.timestamp),
    }));
  } catch (e) {
    const backupKey = `${storageKey}_corrupt_${Date.now()}`;
    console.warn(
      `[ChatHistory] parse failed for ${storageKey}; preserving raw blob at ${backupKey}:`,
      e,
    );
    try {
      localStorage.setItem(backupKey, savedMessages);
    } catch (backupErr) {
      // Quota / private browsing — best-effort backup failed. Log but
      // continue: forensic value of a corrupt blob in a near-full
      // localStorage is essentially zero, and the more important thing is
      // to clear the original key so the next save lands cleanly.
      // Without the unconditional removeItem below, a quota-failed backup
      // would leave the corrupt blob at storageKey and the save-effect
      // overwrite hazard would return on the next user message.
      console.warn('[ChatHistory] backup-on-corrupt write failed:', backupErr);
    }
    try {
      localStorage.removeItem(storageKey);
    } catch (removeErr) {
      // removeItem failing is bizarre (it's allowed even when quota-full)
      // but quota engines have edge cases. Log; the next save will overwrite.
      console.warn('[ChatHistory] removeItem after corrupt parse failed:', removeErr);
    }
    return [];
  }
}

// Drop legacy customSystemPrompt entry from localStorage (the settings UI
// that wrote it has been removed; we always use the bundled
// systemPromptContent now). Module scope so this runs once per page load
// rather than per ChatInterface mount/route change.
try {
  if (localStorage.getItem('customSystemPrompt') !== null) {
    localStorage.removeItem('customSystemPrompt');
  }
} catch {
  // localStorage unavailable (private browsing / SSR): nothing to clean up.
}

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
  graphData?: ToCData | null;
  onGraphUpdate?: (newGraphData: ToCData) => void;
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

type ModelKey = keyof typeof MODELS;

/**
 * Display labels for the effort dropdown. Order is fixed via
 * `MODEL_CAPABILITIES[model].effort_levels`; this map only owns the copy.
 */
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/**
 * Generic dropdown shell shared by `ModelDropdown` and `EffortDropdown`.
 * Both pickers shipped near-identical click-outside detection + open-state
 * scaffolding (~50 lines duplicated); the only differences were the option
 * set, the rendered label, and a couple of width/title constants.
 *
 * Kept self-contained (open state lives inside) so a Chat-composer instance
 * and a Generate-composer instance don't share click-outside refs and
 * accidentally close each other when both are visible.
 */
function Picker<T extends string>({
  options,
  selected,
  onSelect,
  renderLabel,
  buttonWidthClass,
  menuWidthClass,
  title,
  className = '',
}: {
  options: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  renderLabel: (value: T) => React.ReactNode;
  /** Tailwind width class for the trigger button (e.g. `w-[140px]`). */
  buttonWidthClass: string;
  /** Tailwind width class for the dropdown menu (e.g. `w-[200px]`). */
  menuWidthClass: string;
  /** Native `title` attribute on the trigger; tooltips the picker's purpose. */
  title: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Measured horizontal clamp: the menu opens inside the chat panel's
  // overflow-hidden content wrapper, so a static `left-0` anchor clips at
  // the panel edge when the trigger sits close to it (e.g. the Effort
  // picker inside the composer-options popover). See useClampedPopoverX.
  const menuClamp = useClampedPopoverX(open);
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);
  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${buttonWidthClass} text-xs border border-gray-300 rounded-lg px-2.5 py-2 bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 flex items-center justify-between`}
        title={title}
      >
        <span className="font-medium">{renderLabel(selected)}</span>
        <ChevronDownIcon
          className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          ref={menuClamp.ref}
          style={menuClamp.style}
          className={`absolute bottom-full mb-1 ${menuWidthClass} bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50`}
        >
          {options.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onSelect(value);
                setOpen(false);
              }}
              className={`w-full text-left px-2.5 py-2 text-xs hover:bg-gray-50 transition-colors ${
                selected === value ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
              }`}
            >
              {renderLabel(value)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MODEL_KEYS = Object.keys(MODELS) as readonly ModelKey[];

function ModelDropdown({
  selected,
  onSelect,
  className = '',
}: {
  selected: ModelKey;
  onSelect: (model: ModelKey) => void;
  className?: string;
}) {
  return (
    <Picker<ModelKey>
      options={MODEL_KEYS}
      selected={selected}
      onSelect={onSelect}
      renderLabel={(key) => MODELS[key]}
      buttonWidthClass="w-[140px]"
      menuWidthClass="w-[200px]"
      title="Select AI Model"
      className={className}
    />
  );
}

/**
 * Effort-level picker. Hidden when the model doesn't accept an effort knob;
 * the available level set comes from `MODEL_CAPABILITIES[model].effort_levels`
 * so a model that doesn't accept e.g. `xhigh` can't have it offered.
 */
function EffortDropdown({
  model,
  selected,
  onSelect,
  className = '',
}: {
  model: ModelKey;
  selected: EffortLevel;
  onSelect: (effort: EffortLevel) => void;
  className?: string;
}) {
  const caps = MODEL_CAPABILITIES[model];
  if (!caps.supports_output_config_effort) return null;
  return (
    <Picker<EffortLevel>
      options={caps.effort_levels}
      selected={selected}
      onSelect={onSelect}
      renderLabel={(level) => EFFORT_LABELS[level]}
      buttonWidthClass="w-[110px]"
      menuWidthClass="w-[160px]"
      title="Effort: trades response thoroughness against token usage"
      className={className}
    />
  );
}

// Cloudflare Turnstile site key for anonymous rate-limit enforcement.
// Public (surfaced in the bundle by Vite). Unset in dev = widget skipped,
// mirroring the server-side behavior (U9 skips verification when its
// secret is absent).
const TURNSTILE_SITE_KEY: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

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
 * Memoized single-message renderer. React.memo'd because otherwise every
 * keystroke in the composer re-parses every historical assistant message's
 * markdown (ReactMarkdown is not cheap on a long conversation). Assistant
 * messages render flush with the scrollable container; user messages
 * stay as a right-aligned blue bubble. Both sides use remark-gfm so
 * tables/strikethrough/task lists work in either direction. message.content
 * is pre-cleaned in onComplete — no per-render cleaning here.
 */
const MessageBubble = React.memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const proseClass =
    'text-left prose prose-sm max-w-none ' +
    'prose-table:block prose-table:overflow-x-auto ' +
    'prose-pre:overflow-x-auto';

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-lg rounded-br-sm bg-blue-500 text-white text-sm">
          <div
            className={
              `${proseClass} prose-invert ` +
              // prose-invert picks light-gray colors tuned for dark-slate
              // backgrounds; on blue-500 they read muted. Pin each prose
              // element to white explicitly so markdown text matches the
              // surrounding "text-white" bubble.
              'prose-headings:text-white prose-p:text-white prose-strong:text-white ' +
              'prose-em:text-white prose-li:text-white prose-code:text-white ' +
              'prose-a:text-white prose-a:underline marker:text-white'
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
          <div className="text-xs mt-1 opacity-70 text-blue-100">
            <div>
              {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            {message.usage &&
              typeof message.usage.cost_usd === 'number' &&
              message.usage.cost_usd > 0 && (
                <div className="mt-1">{formatCostUsd(message.usage.cost_usd)}</div>
              )}
          </div>
        </div>
      </div>
    );
  }

  // Persisted thinking blocks (from prior streams that completed or were
  // killed mid-flight). Concatenated with double newlines because Anthropic
  // sometimes emits multiple thinking blocks per turn (one per major chain-
  // of-thought chunk). Empty when the turn had no thinking blocks (legacy
  // entries, non-thinking models, or web-search-only turns).
  const persistedThinking =
    message.content_blocks
      ?.filter(
        (b): b is { type: 'thinking'; thinking: string; signature: string } =>
          b.type === 'thinking',
      )
      .map((b) => b.thinking)
      .filter((t) => t.length > 0)
      .join('\n\n') ?? '';

  return (
    <div className="w-full text-sm text-gray-800">
      <div
        className={
          `${proseClass} ` +
          'prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 ' +
          'prose-code:text-gray-800 prose-pre:bg-gray-100 prose-pre:text-gray-800'
        }
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
      {persistedThinking && (
        // Mirrors the streamingThinking disclosure used during live streams
        // (text-xs muted, SparklesIcon, hover affordance) so the visual
        // language is the same: "click to peek at how Claude reasoned about
        // this turn." Stays closed by default — most users won't open it,
        // and the prose flow shouldn't be dominated by reasoning text.
        <details className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-200">
          <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-800 inline-flex items-center gap-1">
            <SparklesIcon className="w-3.5 h-3.5 text-purple-500" aria-hidden />
            <span>Show thinking</span>
          </summary>
          <div className="mt-1 whitespace-pre-wrap italic text-gray-600 leading-relaxed">
            {persistedThinking}
          </div>
        </details>
      )}
      <div className="text-xs mt-1 text-gray-500 opacity-70">
        <div>
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        {message.usage &&
          typeof message.usage.cost_usd === 'number' &&
          message.usage.cost_usd > 0 && (
            <div className="mt-1">{formatCostUsd(message.usage.cost_usd)}</div>
          )}
        {message.was_killed && (
          // Specific copy per kill_reason. aborted = neutral "Stopped" so the
          // bubble visually distinguishes from a complete response; error =
          // upstream/network failure verbatim so the user can diagnose without
          // opening devtools. cap_exceeded falls through to the generic
          // "interrupted" copy — the composer-area panel covers the cap-
          // recovery affordances (Add an Anthropic API key, Donate), so an
          // extra inline directive in the message bubble would just
          // duplicate that.
          <div className="mt-1 inline-flex items-center gap-1 text-amber-700">
            <StopIcon className="w-3 h-3" aria-hidden />
            <span>
              {message.kill_reason === 'aborted'
                ? 'Stopped.'
                : message.kill_reason === 'error'
                  ? `Error: ${message.kill_message ?? 'Connection lost.'}`
                  : 'Response was interrupted.'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

export function ChatInterface({
  isCollapsed,
  onToggle,
  graphData,
  onGraphUpdate,
  highlightedNodes = new Set(),
  onChartCreated,
}: ChatInterfaceProps) {
  const { hasKey, keyLast4, keyVersion } = useApiKey();
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0();
  const [currentMode, setCurrentMode] = useState<AIMode>('chat');
  const [selectedModel, setSelectedModel] = useState<keyof typeof MODELS>('claude-opus-4-7');
  // Per-model `default_effort` is tuned for the quality/cost sweet spot at
  // first contact (deeper reasoning where it pays off, lower latency where
  // it doesn't). Falls back to 'high' for models without an effort dial
  // (haiku-class) so the dropdown always has a valid value.
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(
    () => MODEL_CAPABILITIES['claude-opus-4-7'].default_effort ?? 'high',
  );

  // When the user switches models, clamp effort to a level the new model
  // accepts. Keeping effort across model swaps preserves user intent (a user
  // who picked "low" on Opus probably also wants "low" on Sonnet); we only
  // overwrite when the chosen level isn't valid (e.g. xhigh after switching
  // off Opus 4.7) or the new model doesn't support effort at all.
  useEffect(() => {
    const caps = MODEL_CAPABILITIES[selectedModel];
    if (!caps.supports_output_config_effort) return;
    // `effort_levels` is a `readonly` tuple narrowed via `as const`; widen
    // here so `includes()` accepts the broader `EffortLevel` union we hold
    // in state. Without the cast TS rejects `xhigh` against a Sonnet tuple
    // even though we want exactly that "is the current effort still valid?"
    // answer.
    if ((caps.effort_levels as readonly EffortLevel[]).includes(selectedEffort)) return;
    setSelectedEffort(caps.default_effort ?? 'high');
  }, [selectedModel, selectedEffort]);

  const params = useParams<{ filename?: string; chartId?: string; editToken?: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // BYOK spend displayed in the sidebar pill. Derived from localStorage via a
  // custom event subscription, so it updates live as streams credit spend.
  const chartByokSpendUsd = useChartByokSpendUsd(params.chartId ?? params.editToken ?? null);

  // Create a unique storage key based on the current route
  const getStorageKey = useCallback(() => {
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
  }, [params.chartId, params.editToken, params.filename, location.pathname]);

  // Load chat history from localStorage on mount
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadChatHistoryWithBackup(getStorageKey()),
  );

  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  // Live thinking text from Anthropic's extended-thinking blocks. Rendered
  // as a collapsible summary alongside the streamed reply so users can see
  // the model's reasoning rather than just a "Thinking…" spinner.
  const [streamingThinking, setStreamingThinking] = useState('');
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Fine-grained status: the chip renderer picks one of these, so the
  // composer shows continuous feedback through a web-search-heavy turn
  // (which cycles through many short tool-use blocks) rather than
  // flickering on the narrow `web_search` sub-block only.
  const [streamPhase, setStreamPhase] = useState<StreamPhase | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  // Composer ⚙ popover (PR 1 polish §1.4): houses the web-search toggle
  // and the effort selector. Replaces the inline magnifying-glass
  // button + side-by-side effort dropdown.
  const [showComposerOptions, setShowComposerOptions] = useState(false);
  // Clear-chat confirmation modal (PR 5 red-team L4 closure: replaces
  // window.confirm). Same pattern as FileMenu's delete-chart retrofit.
  const [confirmClearChatOpen, setConfirmClearChatOpen] = useState(false);
  const composerOptionsRef = useRef<HTMLDivElement>(null);
  // Measured horizontal clamp for the ⚙ popover (PR #34 feedback #60).
  // The popover lives inside the panel's overflow-hidden content wrapper,
  // so static side anchors clip at a panel edge: `right-0` clipped off the
  // panel's left, and round 1's `left-0` (4c3f484) clipped at the panel's
  // right. One shared instance is safe: the Chat and Generate composers
  // are mutually exclusive (`currentMode` branches), so only one popover
  // mounts at a time. See useClampedPopoverX for the mechanics.
  const composerOptionsClamp = useClampedPopoverX(showComposerOptions);
  useEffect(() => {
    if (!showComposerOptions) return;
    const onMouseDown = (e: MouseEvent) => {
      if (composerOptionsRef.current && !composerOptionsRef.current.contains(e.target as Node)) {
        setShowComposerOptions(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showComposerOptions]);
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
  // Failure state of the last /api/count-tokens-estimate fetch (fb6 issue
  // 74). Structured (upstream status + message) rather than a prebaked
  // string because two consumers format it differently: the under-textarea
  // note (unblocked flow) and the in-banner quiet line (quota-blocked flow)
  // both run it through estimateUnavailableNote. null = healthy.
  const [composerEstimateFailure, setComposerEstimateFailure] = useState<EstimateFailure | null>(
    null,
  );
  // file_ids that /api/count-tokens-estimate couldn't price (e.g. Anthropic's
  // count_tokens endpoint rejected them, or they're awaiting upload). Surfaced
  // so the user knows the estimate excludes those files and the real billed
  // amount will be higher.
  const [composerUncountedFileIds, setComposerUncountedFileIds] = useState<string[]>([]);
  const [generateEstimateUsd, setGenerateEstimateUsd] = useState<number>(0);

  // Unified composer-blocker slot. Replaces three event-driven banner slots
  // (costErrorBanner, byokPanelMode, globalBudgetUpstreamMessage) with a
  // single discriminated union. The derived `would_exceed_cap` variant
  // (computed from usage + draft estimate) is composed at render time via
  // `selectBlocker` and lives in `renderedBlocker`, NOT this slot — keeping
  // event-driven state separate from derived state lets the cap-class
  // tier-flip filter work correctly when the user adds BYOK.
  //
  // See `src/components/chat/composerBlocker.ts` for the state machine and
  // `plans/composer-banner-unification.md` for the failure modes this closes.
  const [composerBlocker, setComposerBlocker] = useState<ComposerBlocker | null>(null);

  // Generate-confirmation modal flag. True while the modal is open between
  // startGeneration's confirm-check and the user's choice. Two-phase
  // callback flow lives in startGeneration: setting this true returns early;
  // the modal's onConfirm calls startGenerationInternal (the body after the
  // confirm gate). See the <ConfirmModal> render at the bottom of this file
  // (icon + purple variant for the "Replace your Chat?" framing).
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);

  // Loading flag so the composer can show a spinner while the debounced
  // fetch is in flight; avoids displaying a stale number that's about to
  // change, and signals to the user that the field is being updated.
  const [estimatingCost, setEstimatingCost] = useState<boolean>(false);

  // Active estimate: which mode's draft are we sizing right now? Determines
  // whether `selectBlocker` derives `would_exceed_cap` from the Chat draft
  // or the Generate draft. Without this branch, Generate-mode capped users
  // would slip through the would_exceed_cap check (selector reads Chat's
  // estimate, which is 0 in Generate mode → no derived block fires).
  const activeEstimate = currentMode === 'generate' ? generateEstimateUsd : composerEstimateUsd;

  // SessionExpiredBanner state (round-4): the signed-in session can no
  // longer mint tokens, so quota probes and sends answer for the ANON
  // actor. Gated on isAuthenticated to mirror the banner's own render
  // gate; selectBlocker uses it to replace quota-class blockers with the
  // re-login deferral (fb5 issue 73 precedence rule).
  const authSessionDegraded = useAuthSessionDegraded();

  // Render-time blocker: event blocker (composerBlocker) plus derived
  // would_exceed_cap, with cap-class blockers filtered out when tier is
  // byok and quota-class results deferred to the session-expired banner
  // while that state is active. Pure function, called inline at render —
  // cheap.
  const renderedBlocker: RenderedBlocker = selectBlocker({
    eventBlocker: composerBlocker,
    usage,
    composerEstimateUsd: activeEstimate,
    authSessionDegraded: isAuthenticated && authSessionDegraded,
  });

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

  // Files attached in Chat mode (separate from Generate-mode `files`). These
  // can be inline text (content in-memory) or Anthropic Files API uploads
  // (stored as file_id). Only `fileId` is sent to the worker on submit.
  const [chatAttachedFiles, setChatAttachedFiles] = useState<
    Array<
      AttachedFile & {
        // discriminated: text files carry inline content; upload files carry fileId
        kind: 'text' | 'upload';
        content?: string; // text files only
        fileId?: string; // upload files only
        raw?: File; // retained for retry
      }
    >
  >([]);

  // Generate mode state
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [generatedGraphData, setGeneratedGraphData] = useState<ToCData | null>(null);
  // PDFs uploaded for Generate mode via the Files API. Kept as an ordered
  // list of {id, file_id} chips so the chip area can render them with the
  // same AttachedFilesBar as Chat mode. Text/markdown files continue to be
  // inlined via the existing `files` state.
  const [generateAttachedChips, setGenerateAttachedChips] = useState<
    Array<AttachedFile & { kind?: 'upload'; fileId?: string; raw?: File }>
  >([]);
  const generateAttachedFileIds = React.useMemo(
    () =>
      generateAttachedChips
        .filter((f) => f.status === 'ready' && f.fileId)
        .map((f) => f.fileId!) as string[],
    [generateAttachedChips],
  );

  // Get selected nodes info from graphData and highlightedNodes
  const selectedNodes = React.useMemo(() => {
    if (!graphData || !highlightedNodes.size) return [];

    const nodes: Array<{ id: string; title: string; path: string }> = [];

    graphData.sections?.forEach((section, sectionIndex) => {
      section.columns?.forEach((column, columnIndex) => {
        column.nodes?.forEach((node) => {
          if (highlightedNodes.has(node.id)) {
            const sectionTitle = section.title || `Section ${sectionIndex + 1}`;
            const path = `${sectionTitle} → Column ${columnIndex + 1}`;
            nodes.push({
              id: node.id,
              title: node.title || 'Untitled',
              path: path,
            });
          }
        });
      });
    });

    return nodes;
  }, [graphData, highlightedNodes]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingMessageRef = useRef<ChatMessage | null>(null);
  // Mirror of chatService's block accumulator, updated on each
  // content_block_stop via the onContentBlocks callback. Read synchronously
  // by handleStopStreaming so user-aborted partial assistant turns preserve
  // signed thinking + tool blocks (otherwise they only have plain text and
  // the next "continue" turn loses Opus 4.7's reasoning continuity).
  const streamingContentBlocksRef = useRef<AssistantBlock[]>([]);
  // Flips true inside the `onAccepted` callback (server's preflight
  // reservation accepted, SSE about to begin). Read by handleStopStreaming
  // and the per-handler onCostError/onError branches to gate the
  // "stamp a partial assistant turn" logic: if the user clicked Stop or a
  // cost-error landed BEFORE the preflight accepted, nothing actually
  // streamed and there's no user message in chat to pair an assistant
  // bubble with — stamping a phantom would be confusing. Reset to false
  // by handleStopStreaming, resetStreamUiState, and at the head of every
  // new send attempt.
  const acceptedRef = useRef(false);
  // In-flight cancellation handles for the debounced count_tokens estimate
  // effects (one pair per mode). Exposed via refs so handleSendMessage /
  // startGenerationInternal can cancel a pending or in-flight estimate when
  // the user clicks Send — the server's reserveCost preflight is the
  // authoritative gate, so a debounce completing during the preflight
  // window would just thrash banners (e.g. amber would_exceed_cap flickers
  // in between the spinner appearing and the 429 lands → red cap_reached
  // taking over). Each effect re-assigns these on every run; the cleanup
  // closures still capture their own locals so the abort is idempotent
  // when both fire.
  const chatEstimateAbortRef = useRef<AbortController | null>(null);
  const chatEstimateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generateEstimateAbortRef = useRef<AbortController | null>(null);
  const generateEstimateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous guard against double-send for both handleSendMessage and
  // startGeneration. handleSendMessage awaits ensureChartExists() before
  // flipping isStreaming/isLoading, so a second Enter racing in during that
  // ~80ms window passes the React-state guard and fires a duplicate
  // request. startGeneration's window is narrower (one render tick) but
  // also exists because it has no in-handler guard at all. The ref flips
  // synchronously so the second call early-returns immediately. Shared
  // because chat-mode and generate-mode are mutually exclusive UI states,
  // so the two handlers can't run concurrently.
  const sendInFlightRef = useRef(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  // Set to true by ensureChartExists right before it navigates to the new
  // /edit/<token> URL. The route-change effect reads + clears it; when
  // set, it skips the usual "load from localStorage" step so the user's
  // in-flight messages (e.g. the message they just sent that triggered
  // auto-create) aren't wiped mid-flight. ensureChartExists separately
  // migrates the old URL's localStorage key to the new one so a later
  // refresh also finds the history.
  const justAutoCreatedRef = useRef(false);
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

  // Reset all per-stream UI state so the next turn starts clean. Called at
  // the tail of every onComplete / onError / onCostError callback and the
  // catch fallback in handleSendMessage / startGeneration; each caller is
  // responsible for preserving any partial content (via setMessages) BEFORE
  // invoking this, since this clears streamingMessageRef.current.
  const resetStreamUiState = useCallback(() => {
    setIsStreaming(false);
    setStreamingContent('');
    setStreamingThinking('');
    setStreamPhase(null);
    setRunningCostUsd(null);
    streamingMessageRef.current = null;
    // Clear the accepted flag too — the next send attempt re-arms it via
    // its onAccepted callback. Without this, a Stop click on a fresh send
    // would inherit the previous turn's acceptedRef=true and stamp a
    // phantom assistant turn into the wrong place.
    acceptedRef.current = false;
  }, []);

  // Delta-credit the per-chart and per-key BYOK buckets during a stream so
  // partial spend (aborted / errored / killed turns) is still recorded.
  // Skip reasons (logged but not credited): usesByok=false (anon path or
  // key removed mid-stream); delta<=0 (non-monotonic frame, worker
  // re-emitted a lower estimate); chartId/keyLast4 null (bucket
  // misrouting). Mutates lastAppliedMicroRef on credit so the next frame
  // computes its delta against the new baseline.
  const creditByokDelta = useCallback(
    (args: {
      tag: 'chat' | 'gen';
      runningUsd: number;
      usesByok: boolean;
      lastAppliedMicroRef: { current: number };
      chartId: string | null;
      keyLast4: string | null;
    }): boolean => {
      const { tag, runningUsd, usesByok, lastAppliedMicroRef, chartId, keyLast4 } = args;
      if (!usesByok) {
        console.log(
          `[BYOK ${tag}] onCostUpdate runningUsd=$${runningUsd.toFixed(6)}` +
            ` skipped: streamUsesByok=false`,
        );
        return false;
      }
      const newMicro = Math.round(runningUsd * 1_000_000);
      const deltaMicro = newMicro - lastAppliedMicroRef.current;
      console.log(
        `[BYOK ${tag}] onCostUpdate runningUsd=$${runningUsd.toFixed(6)}` +
          ` lastAppliedMicro=${lastAppliedMicroRef.current}` +
          ` newMicro=${newMicro}` +
          ` deltaMicro=${deltaMicro}` +
          ` chartId=${chartId ?? 'null'}` +
          ` keyLast4=${keyLast4 ?? 'null'}` +
          ` willCredit=${deltaMicro > 0}`,
      );
      if (deltaMicro > 0) {
        addByokSpend(chartId, keyLast4, deltaMicro / 1_000_000);
        lastAppliedMicroRef.current = newMicro;
        return true;
      }
      return false;
    },
    [],
  );

  // Reload chat history when route changes
  useEffect(() => {
    try {
      // Auto-create navigation (handleSendMessage → ensureChartExists →
      // navigate /edit/<newToken>): the user's messages are mid-flight and
      // belong to this chart. Skip the load-from-localStorage branch so we
      // don't wipe them; ensureChartExists already migrated the previous
      // storage key to the new one for the refresh case.
      if (justAutoCreatedRef.current) {
        justAutoCreatedRef.current = false;
        return;
      }

      // Reset per-context composer blockers on real chartId/route
      // transitions, but PRESERVE cap-class blockers (cap_reached,
      // request_cut_off) because those represent genuinely global user
      // state — the cap lives in user_api_usage, not per-chart. Clearing
      // them on navigation would briefly mislead the user into thinking
      // they have quota in the new chart; their next send would fail and
      // the banner would re-fire. `preserveCapClassOnly` filters by
      // `isCapClassBlocker` — same logic, both "user changed context"
      // signals. Closes failure mode J for per-context banners
      // (advisory, last_send_exceeded); cap-class persists as before.
      setComposerBlocker(preserveCapClassOnly);

      // At the root path (new ToC), start with an empty in-memory chat but
      // DON'T touch localStorage. Previously this branch did a
      // `removeItem(chatHistory_root)`, which wiped the session of any user
      // who'd been chatting on `/` while a chart was auto-created underneath
      // via replaceState (React Router's `params.editToken` stayed `undefined`
      // until a reload, so the save effect was writing to chatHistory_root).
      // The transient visit to `/` after an Auth0 redirect would then destroy
      // their chat. With replaceState fixed (see ensureChartExists), saves
      // never land in chatHistory_root in the first place — but we still
      // avoid wiping any stray entry: it's harmless to leave around and
      // destructive to delete on a route change alone.
      if (location.pathname === '/') {
        setMessages([]);
        return;
      }

      setMessages(loadChatHistoryWithBackup(getStorageKey()));
    } catch (error) {
      console.error('Failed to load chat history on route change:', error);
      setMessages([]);
    }
  }, [params.chartId, params.editToken, params.filename, location.pathname, getStorageKey]);

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
  }, [messages, getStorageKey]);

  useEffect(() => {
    // Only auto-scroll in chat mode. Generate is a static form (no
    // chronological message list), so scrolling to the bottom on tab
    // switch hides the cost heads-up + upload area above the fold.
    if (currentMode === 'chat') {
      scrollToBottom();
      // Keep focus on input if we're not loading
      if (!isCollapsed && inputRef.current && !isLoading) {
        // Use setTimeout to ensure this happens after all DOM updates
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      }
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

  // Register the BYOK pill-bump callback for post-stream
  // `pollUntilReconciled` + queue drains. The reconcile-cost endpoint
  // returns the server's `cost_settled_micro_usd` on every call; when it
  // exceeds the entry's previously-credited baseline (the figure the
  // tracker last posted), the polling/drain code fires this callback
  // with the strictly-positive delta. We forward to `addByokSpend` so
  // the per-chart + per-key BYOK pill catches up to the worker's
  // post-stream `ctx.waitUntil` IIFE figure (~1-2s of bumped value the
  // pre-fix client never saw).
  //
  // Identifiers come from the bump event (snapshotted at stream start
  // in chatService.ts, stored on the queue entry, replayed on each
  // bump). That means this effect runs once on mount and stays stable
  // across re-renders; we don't need to depend on `params` or the
  // BYOK key state. Cleanup on unmount drops the global registration
  // so a navigation that unmounts ChatInterface doesn't leak a stale
  // closure.
  useEffect(() => {
    setReconcilePillBump((event) => {
      const usd = Number(event.deltaMicroUsd) / 1_000_000;
      console.log(
        `[BYOK reconcile-bump] +${event.deltaMicroUsd} µUSD ($${usd.toFixed(6)})` +
          ` chart=${event.chartId} keyLast4=${event.keyLast4}` +
          ` newSettled=${event.newSettledMicroUsd}`,
      );
      addByokSpend(event.chartId, event.keyLast4, usd);
    });
    return () => {
      setReconcilePillBump(null);
    };
  }, []);

  // Auth header helper shared by /api/usage and file-upload callers. Returns
  // an empty object for anonymous visitors or when silent refresh fails;
  // those requests hit the worker anonymously and rely on the Turnstile
  // token for quota attribution.
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!isAuthenticated) return {};
    const idToken = await getFreshIdToken(getAccessTokenSilently, getIdTokenClaims);
    return idToken ? { Authorization: `Bearer ${idToken}` } : {};
  }, [isAuthenticated, getIdTokenClaims, getAccessTokenSilently]);

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

  // Fetch the chart's authoritative BYOK cost from the server and apply
  // it (max-monotone) to the per-chart pill. Closes the post-stream-poll
  // gap where the client's local total ran behind the DB's cost_settled
  // sum: the polling-window bumps can be missed if the tab was
  // backgrounded, the polling never observed the final IIFE delta, or a
  // different tab handled the bump. Called on chart load and right before
  // each new stream send. Only runs when the user has BYOK (the endpoint
  // is BYOK-scoped; anon callers get 0 and free-tier users don't show the
  // chart pill anyway).
  const syncChartByokCostFromDb = useCallback(
    async (chartId: string | null | undefined): Promise<void> => {
      if (!chartId) return;
      if (!hasKey) return;
      try {
        const headers = await getAuthHeaders();
        const resp = await fetch(`/api/chart-byok-cost?chartId=${encodeURIComponent(chartId)}`, {
          headers,
          credentials: 'include',
        });
        if (!resp.ok) return; // transient: keep local state
        const data = (await resp.json()) as { cost_settled_micro_usd?: string };
        const microStr = data.cost_settled_micro_usd;
        if (!microStr) return;
        const micro = Number(microStr);
        if (!Number.isFinite(micro) || micro <= 0) return;
        setChartSpendIfHigher(chartId, micro / 1_000_000);
      } catch (err) {
        console.warn('[ChatInterface] syncChartByokCostFromDb failed:', err);
      }
    },
    [getAuthHeaders, hasKey],
  );

  // Chart-load sync. Run once the chart route is resolved (and again when
  // the user adds/removes a BYOK key — going from free-tier to BYOK
  // should pull the server's authoritative total). Cross-tab convergence
  // path: a sibling tab's stream-end poll may have already updated the
  // DB beyond what this tab's localStorage has; this brings the pill up
  // to parity. Doesn't block render (fire-and-forget).
  const chartIdForSync = params.chartId ?? params.editToken ?? null;
  useEffect(() => {
    if (!chartIdForSync) return;
    if (!hasKey) return;
    void syncChartByokCostFromDb(chartIdForSync);
  }, [chartIdForSync, hasKey, keyVersion, syncChartByokCostFromDb]);

  // Structured cost-error handler. Two-step dispatch:
  //   1. Turnstile arms touch Turnstile session state, not the blocker slot
  //      (the widget re-renders independently).
  //   2. All other arms go through the pure `costErrorToBlocker` transition;
  //      the returned variant (or undefined for no-op) flows into the
  //      single composerBlocker slot.
  //
  // Chat history is NEVER touched here — 429/402/etc. show an inline banner
  // (rendered via <ComposerBlockerBanner> in the composer area) so BYOK
  // retries can reuse the same messages array.
  const handleCostError = useCallback(
    (error: CostError) => {
      if (error.type === 'turnstile_required') {
        // Cookie expired or IP changed mid-flow. Bring the widget back so
        // the user can re-solve, and clear any stale error copy.
        setHasTurnstileSession(false);
        setTurnstileError(null);
        return;
      }
      if (error.type === 'turnstile_failed') {
        // Siteverify rejected. Keep the widget visible, surface the error.
        setHasTurnstileSession(false);
        setTurnstileError('Challenge failed; please try again.');
        return;
      }

      // All other cost-class errors dispatch through the pure transition.
      // `undefined` return means no-op (preserve existing blocker — used by
      // idempotent_replay so a double-click on a capped state doesn't
      // clobber the sticky banner).
      const next = costErrorToBlocker(error);
      if (next !== undefined) setComposerBlocker(next);

      // Cap-class events refresh usage so the tier-flip filter in
      // selectBlocker activates when BYOK has been added cross-tab. Refresh
      // is fire-and-forget; selectBlocker re-derives on the next render.
      if (error.type === 'lifetime_cap_reached' || error.type === 'request_cost_ceiling_exceeded') {
        void refreshUsage();
      }
    },
    [refreshUsage],
  );

  // Auto-clear `last_send_exceeded` when the user edits anything that would
  // change the next send's projected cost. The variant is past-tense ("your
  // last send would have exceeded") — once they edit the draft, attached
  // files, OR swap to a cheaper model, the rejection is moot and the user
  // is signaling retry intent. The setComposerBlocker callback is
  // idempotent when prev isn't this variant, so firing on every keystroke
  // is a no-op for any other state. Covers both Chat (inputValue,
  // chatAttachedFiles) and Generate (additionalInstructions, files,
  // generateAttachedFileIds) inputs; the server-rejected event could come
  // from either mode. `selectedModel` is included because Opus→Sonnet
  // (~5× cheaper) on the same draft is a legitimate "past rejection is
  // moot" signal that doesn't involve touching the text.
  //
  // Also reset the live estimate(s) to 0 when last_send_exceeded clears so
  // a stale composerEstimateUsd (from the previous draft, before the debounced
  // estimate effect catches up on the new deferredInputValue) doesn't
  // derive a false `would_exceed_cap` banner during the ~600ms debounce
  // window. Trade-off: the cost-display row briefly shows $0 instead of
  // the previous draft's stale figure — honest signal that the estimate
  // is being recomputed.
  useEffect(() => {
    let cleared = false;
    setComposerBlocker((prev) => {
      if (prev?.type === 'last_send_exceeded') {
        cleared = true;
        return null;
      }
      return prev;
    });
    if (cleared) {
      setComposerEstimateUsd(0);
      setGenerateEstimateUsd(0);
    }
  }, [
    inputValue,
    chatAttachedFiles,
    additionalInstructions,
    files,
    generateAttachedFileIds,
    selectedModel,
  ]);

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
  const handleTurnstileToken = useCallback(
    async (token: string | null) => {
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
          // user_api_usage. Refresh so the UI's usage bar + the derived
          // would_exceed_cap blocker reflect the current identity, not
          // the stale one.
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
    },
    [refreshUsage],
  );

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
  useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);

  // Debounced input-cost estimate for the Chat composer. Mirrors the
  // request shape streamMessage assembles so the number reflects actual
  // billing, not just the visible textarea:
  //   - system: baseSystemPrompt + chatModePromptContent
  //   - messages: full history + current draft, with [CURRENT_GRAPH_DATA]
  //     JSON appended to the draft (chatService.ts:546-557)
  //   - cache_control: ephemeral, defaulting to 5m TTL per Anthropic docs
  //
  // Rate-limit hygiene: 600ms debounce + graphData read via ref so graph
  // nudges don't refire the effect. Tier 1 is 100 RPM; a continuously-
  // typing user would otherwise fire ~100 RPM alone between pauses.
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
    chatEstimateAbortRef.current = controller;
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
        // Mirror the Generate guard below: an empty composer must not sit
        // under leftovers from the previous draft. Resetting only the dollar
        // figure stranded the "estimates unavailable" note (and the "N files
        // couldn't be priced" notice) indefinitely — e.g. a network-failed
        // estimate followed by clearing the draft showed $0.00 with a
        // permanent failure note and no request in flight to resolve it.
        setComposerEstimateFailure(null);
        setComposerUncountedFileIds([]);
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
      const userContent: unknown =
        uploadFiles.length > 0
          ? [
              ...uploadFiles.map((f) => ({
                type: 'document' as const,
                source: { type: 'file' as const, file_id: f.fileId! },
              })),
              { type: 'text' as const, text: draftBody },
            ]
          : draftBody;

      const systemPrompt = `${systemPromptContent}\n\n${chatModePromptContent}`;
      // Mirror the outgoing-messages shape that streamMessage actually
      // ships, so the estimate counts signed thinking + tool blocks on
      // prior assistant turns. Using m.content (text only) here was
      // undercounting by however many tokens the persisted thinking
      // blocks added — visible after a cap kill + BYOK + "continue", where
      // the actual send carries the partial assistant turn but the estimate
      // didn't.
      const historyForEstimate = buildOutgoingMessages(messages, {
        attachedFileIds: [],
        lastIndex: -1, // no in-flight user turn appended via this call
      });
      const hasDraftContent = draftBody.length > 0 || uploadFiles.length > 0;
      const messagesForEstimate = hasDraftContent
        ? [...historyForEstimate, { role: 'user' as const, content: userContent }]
        : historyForEstimate;

      // Cache warmth: cached for CACHE_TTL_MILLIS after the last assistant
      // turn (shared constant, default 5m ephemeral TTL from Anthropic).
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      const cacheWarm =
        !!lastAssistant && Date.now() - lastAssistant.timestamp.getTime() < CACHE_TTL_MILLIS;

      setEstimatingCost(true);
      void (async () => {
        // Carried past the throw below so the catch can preserve upstream
        // detail. The old shape set the error state in the !ok branch and
        // then unconditionally overwrote it in the catch — the upstream
        // reason (e.g. 403 "Request not allowed") never reached the UI
        // (fb6 issue 74 clobber).
        let upstreamFailure: EstimateFailure | null = null;
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
            // unresolvable in count_tokens, beta header mismatch) and
            // origin blocks (403 "Request not allowed") are diagnosable
            // from the composer instead of silently falling back to the
            // local char estimate. The worker re-shapes upstream 429s into
            // its own 429 {error:'rate_limited'} WITHOUT upstream_* fields
            // (count-tokens-estimate.ts), so map that back explicitly.
            try {
              const body = (await response.json()) as {
                error?: string;
                upstream_status?: number;
                upstream_message?: string;
              };
              upstreamFailure = {
                upstreamStatus:
                  typeof body.upstream_status === 'number'
                    ? body.upstream_status
                    : body.error === 'rate_limited'
                      ? 429
                      : undefined,
                upstreamMessage:
                  typeof body.upstream_message === 'string' ? body.upstream_message : undefined,
              };
            } catch {
              /* non-JSON body — fall through to the detail-less failure */
            }
            throw new Error(`status ${response.status}`);
          }
          setComposerEstimateFailure(null);
          const data = (await response.json()) as {
            input_tokens?: number;
            estimated_cost_usd?: number;
            cached_file_tokens?: number;
            cached_file_tokens_draft?: number;
            cached_file_tokens_history?: number;
            uncounted_file_ids?: string[];
          };
          setComposerUncountedFileIds(
            Array.isArray(data.uncounted_file_ids) ? data.uncounted_file_ids : [],
          );
          const totalTokens = data.input_tokens ?? 0;
          const inputRate = MODEL_INPUT_RATES_USD_PER_MTOK[selectedModel] ?? 5;
          // Server returns input_tokens already including the precise
          // cached token counts for any attached files (from
          // chart_files.input_tokens, counted at upload time). We just need
          // to split the total into draft-side vs history-side for the
          // warm-cache 1.25× / 0.1× multipliers. Char-to-token ratio is
          // ~4:1 for text; for PDF tokens we trust the server's per-bucket
          // split (draft = last message, history = earlier messages) from
          // count-tokens-estimate.ts.
          const CHAR_PER_TOKEN = 4;
          const draftTextTokensEst = Math.ceil(draftBody.length / CHAR_PER_TOKEN);
          const draftPdfTokens = data.cached_file_tokens_draft ?? 0;
          const historyPdfTokens = data.cached_file_tokens_history ?? 0;
          const draftTokensEst = draftTextTokensEst + draftPdfTokens;
          const historyCharSum =
            systemPrompt.length +
            messages.reduce(
              (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
              0,
            );
          const historyTokensEst = Math.ceil(historyCharSum / CHAR_PER_TOKEN) + historyPdfTokens;
          const denom = draftTokensEst + historyTokensEst;
          const draftOnlyTokens =
            totalTokens > 0 && denom > 0 ? Math.round(totalTokens * (draftTokensEst / denom)) : 0;
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
          // !response.ok lands here with upstreamFailure populated; network-
          // level failures (CORS, offline, DNS) land here with it still null
          // → detail-less failure ({}). Either way the UI shows a degraded-
          // estimate note instead of presenting the local char fallback as
          // if it were precise.
          setComposerEstimateFailure(upstreamFailure ?? {});
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
    chatEstimateTimeoutRef.current = timeout;
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
    generateEstimateAbortRef.current = controller;
    const timeout = setTimeout(() => {
      const readyTextFiles = files.filter((f) => f.status === 'ready');
      if (
        readyTextFiles.length === 0 &&
        generateAttachedFileIds.length === 0 &&
        !additionalInstructions.trim()
      ) {
        setGenerateEstimateUsd(0);
        // Clear any stale failure from a previous draft so the empty
        // composer doesn't sit under a leftover "estimates unavailable"
        // note.
        setComposerEstimateFailure(null);
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

      const systemPromptForEstimate = `${systemPromptContent}\n\n${generateModePromptContent}`;

      // Anthropic-Files-API uploads (PDFs): send as `document` content blocks
      // so count_tokens counts the PDF text. Without this the estimate
      // silently ignored attached PDFs — files-only Generate showed $0
      // instead of the real (often $0.50+) cost of analysing the upload.
      const userContent: unknown =
        generateAttachedFileIds.length > 0
          ? [
              ...generateAttachedFileIds.map((fid) => ({
                type: 'document' as const,
                source: { type: 'file' as const, file_id: fid },
              })),
              { type: 'text' as const, text: assembled },
            ]
          : assembled;

      setEstimatingCost(true);
      void (async () => {
        // Same clobber-fix shape as the Chat estimate effect above: carry
        // upstream detail past the throw so the catch preserves it.
        let upstreamFailure: EstimateFailure | null = null;
        try {
          const response = await fetch('/api/count-tokens-estimate', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: selectedModel,
              system: [{ type: 'text', text: systemPromptForEstimate }],
              messages: [{ role: 'user', content: userContent }],
            }),
          });
          if (!response.ok) {
            // Surface upstream detail so shape issues and origin blocks are
            // diagnosable from the composer instead of silently falling
            // back to the local char estimate. Worker re-shapes upstream
            // 429s into {error:'rate_limited'} without upstream_* fields.
            try {
              const body = (await response.json()) as {
                error?: string;
                upstream_status?: number;
                upstream_message?: string;
              };
              upstreamFailure = {
                upstreamStatus:
                  typeof body.upstream_status === 'number'
                    ? body.upstream_status
                    : body.error === 'rate_limited'
                      ? 429
                      : undefined,
                upstreamMessage:
                  typeof body.upstream_message === 'string' ? body.upstream_message : undefined,
              };
            } catch {
              /* non-JSON body — fall through to the detail-less failure */
            }
            throw new Error(`status ${response.status}`);
          }
          setComposerEstimateFailure(null);
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
          // !response.ok lands here with upstreamFailure populated; network-
          // level failures land here with it still null → detail-less
          // failure ({}). Either way the UI shows a degraded-estimate note
          // rather than presenting the char-based fallback as precise.
          setComposerEstimateFailure(upstreamFailure ?? {});
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
    generateEstimateTimeoutRef.current = timeout;
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [files, additionalInstructions, generateAttachedFileIds, selectedModel]);

  // Cancel any pending/in-flight count_tokens estimate. Called from the
  // send handlers on click so the debounced fetch (or its pending
  // setTimeout) can't fire mid-preflight and update composerEstimateUsd /
  // generateEstimateUsd, which would trigger a momentary would_exceed_cap
  // amber banner just before the server's 429 (cap_reached, red) lands —
  // banner thrash for the user.
  const cancelChatEstimate = useCallback(() => {
    if (chatEstimateTimeoutRef.current !== null) {
      clearTimeout(chatEstimateTimeoutRef.current);
      chatEstimateTimeoutRef.current = null;
    }
    chatEstimateAbortRef.current?.abort();
    setEstimatingCost(false);
  }, []);
  const cancelGenerateEstimate = useCallback(() => {
    if (generateEstimateTimeoutRef.current !== null) {
      clearTimeout(generateEstimateTimeoutRef.current);
      generateEstimateTimeoutRef.current = null;
    }
    generateEstimateAbortRef.current?.abort();
    setEstimatingCost(false);
  }, []);

  const handleStopStreaming = () => {
    // Don't gate the whole handler on abortControllerRef.current being
    // truthy. The Stop button is rendered whenever isStreaming is true,
    // but the ref can be null at the moment the user clicks if a stream
    // just finished naturally and React hasn't committed setIsStreaming
    // (false) yet, or for the (theoretical) sub-millisecond gap between
    // setIsStreaming(true) and ref assignment in handleSendMessage.
    // Previously the entire body short-circuited in those windows, so
    // the click visibly did nothing — the user reported needing two
    // clicks to actually stop. Now the abort call is the only thing
    // gated; the state cleanup runs unconditionally, so the button
    // always responds the first time it's pressed.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setIsLoading(false);
    setStreamingContent('');
    setStreamingThinking('');
    setStreamPhase(null);

    // Finalize a partial assistant turn when the user clicked Stop during
    // an accepted stream. Two signals to preserve: visible text
    // (streamingContent) AND structured blocks (streamingContentBlocksRef,
    // captured per content_block_stop via onContentBlocks). Stamp a
    // placeholder even when Stop landed during thinking/tool use with no
    // committed block yet — the user needs visible feedback that their
    // action took effect.
    //
    // Gate on acceptedRef so a Stop click during the preflight window
    // (server hasn't accepted yet → no user message in chat, no streaming
    // started) doesn't stamp a phantom assistant bubble. The deferred-add
    // pattern intentionally suppresses chat-history mutations until the
    // server says OK; Stop must mirror that contract.
    if (acceptedRef.current) {
      const partialBlocks = streamingContentBlocksRef.current;
      const hasBlocks = partialBlocks.length > 0;
      const hasText = streamingContent.length > 0;
      if (streamingMessageRef.current) {
        const finalMessage: ChatMessage = {
          ...streamingMessageRef.current,
          content: hasText
            ? streamingContent
            : '_(Assistant was stopped before writing a visible response.)_',
          was_killed: true,
          kill_reason: 'aborted',
          content_blocks: hasBlocks ? partialBlocks : undefined,
        };
        setMessages((prev) => [...prev, finalMessage]);
      }
    }
    streamingMessageRef.current = null;
    streamingContentBlocksRef.current = [];
    acceptedRef.current = false;
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading || isStreaming) return;
    // Synchronous double-send guard. Two rapid Enters (or click + Enter)
    // both pass the React-state guard above because setIsStreaming/
    // setIsLoading don't fire until after `await ensureChartExists()`
    // below. The ref flips before any await, so the second call returns
    // here. Reset in the `finally` block at the end of this handler.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    // Reject sends while any chip is still uploading. The server would accept
    // the request but the files wouldn't be attached; better to fail loud
    // client-side.
    if (chatAttachedFiles.some((f) => f.status === 'uploading')) {
      sendInFlightRef.current = false;
      return;
    }

    // Defense-in-depth gate: if the user typed under-cap then immediately
    // hit Send before the debounced estimate updated, the would_exceed_cap
    // banner won't have rendered yet — but the server's reserveCost
    // preflight is the authoritative gate and will reject (429
    // lifetime_cap_reached). We rely on that path for the actual
    // enforcement; this branch only short-circuits cases where the banner
    // IS already visible, sparing the round-trip + Turnstile-race window.
    if (shouldBlockSend(renderedBlocker)) {
      sendInFlightRef.current = false;
      return;
    }

    // Cancel any pending/in-flight debounced count_tokens estimate.
    // Without this, an estimate completing mid-preflight would flip
    // composerEstimateUsd, derive would_exceed_cap, and flash an amber
    // banner just before the server's 429 (cap_reached, red) lands —
    // banner thrash. Server preflight is authoritative; the debounced
    // estimate is moot once Send is in flight.
    cancelChatEstimate();

    // Spinner ON (S1: `isLoading && !isStreaming` is the preflight signal,
    // shown via spinner icon on the Send button). Set sync, BEFORE the
    // ensureChartExists await, so a slow chart-create round-trip still
    // surfaces the spinner immediately.
    setIsLoading(true);
    // Narrow send-start clear: cap-class blockers stay sticky (the cap gate
    // above blocks the send anyway, so the banner MUST remain visible);
    // advisory blockers clear so they don't linger across the next attempt.
    // (Stays sync per Q5: clearing stale advisory banners on a fresh send
    // attempt is the correct UX regardless of preflight outcome.)
    setComposerBlocker(preserveCapClassOnly);

    // Persist the chart NOW, before the streamMessage call. Without this,
    // a first send on the `/` root URL has no chart_id → loggingService's
    // session can't init → logUserMessage silently drops the message, and
    // the worker's X-Logging-Message-Id is never sent, so the reconcile
    // can't populate logging_messages.cost_micro_usd either. Idempotent
    // when the chart already exists. Capture the canonical chartId here
    // so the stream headers downstream use the 12-char id and not the
    // 36-char editToken (VARCHAR(12) overflow at the worker otherwise).
    const resolvedChart = await ensureChartExists();
    // Q1: explicit null-check. ensureChartExists returns null on the
    // "couldn't load your chart" path (it already set an advisory
    // composer blocker in that branch). Bail cleanly — without the
    // check, we'd proceed with undefined chartId, optimistically commit
    // the user message later, then either silently desync or surface
    // a generic worker error.
    if (!resolvedChart) {
      sendInFlightRef.current = false;
      setIsLoading(false);
      return;
    }
    const resolvedChartId = resolvedChart.chartId;

    // Pre-send pill sync. Pull the chart's authoritative BYOK cost from
    // the server before kicking off the next stream. Catches any pill
    // drift that survived the previous turn's post-stream poll (closed
    // tab, missed bump, cross-tab stream). Fire-and-forget — we don't
    // want to block the send on this sync.
    void syncChartByokCostFromDb(resolvedChart.editToken ?? resolvedChartId ?? null);

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
      timestamp: new Date(),
      // Attach file_ids to the message so they persist with chat history
      // (localStorage round-trip) and follow-up turns re-emit document
      // blocks to Anthropic for the full conversation context.
      attachedFileIds: attachedFileIds.length > 0 ? attachedFileIds : undefined,
    };

    // Defensive resets: don't render leftover content from a prior stream
    // if React happens to commit before onAccepted lands.
    setStreamingContent('');
    setStreamingThinking('');
    streamingContentBlocksRef.current = [];

    // Pre-arm the accepted flag (will flip true in onAccepted). Keeps
    // handleStopStreaming's "is there a partial worth stamping" check
    // honest across the preflight window.
    acceptedRef.current = false;

    streamingMessageRef.current = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };

    abortControllerRef.current = new AbortController();

    // Snapshot BYOK + chart identifiers at stream start so onCostUpdate can
    // credit partial spend to the right bucket even if state changes mid-stream
    // (e.g. user navigates away). Use delta accumulation so aborted streams
    // still record the portion that was billed.
    //
    // Prefer resolvedChart over params here. On the first send from `/`,
    // ensureChartExists has just navigate()'d to /edit/<editToken>, but
    // this handler's closure was created on the previous (root-URL) render
    // and so still holds the OLD params with both fields undefined. Reading
    // params here would yield streamChartId=null, addByokSpend(null,...)
    // would skip the per-chart bucket write, and turn 1's cost (the biggest
    // cache_write of the conversation) would silently disappear from the
    // "$X this chart" pill. resolvedChart.editToken is fresh from the
    // ensureChartExists return value and matches the key the
    // useChartByokSpendUsd reader uses (which sees the new params on the
    // next render).
    const streamChartId = resolvedChart?.editToken ?? params.chartId ?? params.editToken ?? null;
    const streamKeyLast4 = keyLast4;
    const streamUsesByok = hasKey;
    turnLastAppliedMicroRef.current = 0;

    try {
      await chatService.streamMessage({
        messages: [...messages, userMessage],
        currentGraphData: graphData,
        mode: 'chat',
        callbacks: {
          // Deferred-add commit point. Fires after the server's reserveCost
          // preflight accepts the request and BEFORE SSE delivery begins.
          // Everything that's destructive to the composer / chat history
          // happens here so a preflight rejection (429/413/etc.) leaves
          // the UI untouched: draft preserved, chips preserved, no orphan
          // user message in chat. Per-handler closure flag (acceptedRef)
          // lets handleStopStreaming + onCostError/onError gate their
          // stamping logic on whether streaming actually started.
          onAccepted: () => {
            // Commit the user message first so the post-accept renders see
            // the new state. acceptedRef flips LAST so any throw above
            // leaves the gate closed (the outer error handlers fall back
            // to the "no stamping" branch). React state setters don't
            // throw, but logUserMessage is the only externally-callable
            // function here — keep it after the visible commits.
            setMessages((prev) => [...prev, userMessage]);
            setInputValue('');
            // Clear the chip tray now that the files are committed to the
            // assistant turn. Survives a preflight rejection (chips stay
            // attached so the user can retry without re-uploading). Per
            // C6/Q6.
            setChatAttachedFiles([]);
            // Streaming UI takes over the chat scroll area; surface the
            // bouncing-dots placeholder + thinking chip until the first
            // SSE block arrives. Per Q4 these only render after the
            // server accepted.
            setIsStreaming(true);
            setIsNearBottom(true);
            // Extended thinking is always on; seed the phase as 'thinking'
            // until the first content_block_start arrives (which will
            // overwrite it anyway). Covers the post-accept/pre-first-block
            // window.
            setStreamPhase('thinking');
            // Log the user message only after the server accepted — per
            // S2 there's no telemetry value in logging rejected sends
            // (they didn't produce a cost-bearing event).
            loggingService.logUserMessage({
              messageId: userMessageId,
              role: 'user',
              content: userMessage.content,
            });
            acceptedRef.current = true;
          },
          onStreamPhase: (phase) => {
            setStreamPhase(phase);
          },
          onContent: (_chunk: string, fullContent: string) => {
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
          onComplete: (finalMessage, editInstructions, usage, rawMessage, contentBlocks) => {
            const assistantMessage: ChatMessage = {
              id: assistantMessageId,
              role: 'assistant',
              content: finalMessage,
              timestamp: new Date(),
              // undefined for legacy turns predating block capture
              content_blocks: contentBlocks && contentBlocks.length > 0 ? contentBlocks : undefined,
              usage: usage
                ? {
                    input_tokens: usage.input_tokens || 0,
                    output_tokens: usage.output_tokens || 0,
                    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                    web_search_requests: usage.server_tool_use?.web_search_requests || 0,
                    cost_usd: runningCostUsdRef.current ?? undefined,
                  }
                : undefined,
            };

            setMessages((prev) => [...prev, assistantMessage]);
            resetStreamUiState();

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
              tokenUsage: usage
                ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
                : undefined,
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
                  timestamp: new Date(),
                };
                setMessages((prev) => [...prev, errorMessage]);
              }
            } else {
              console.log('No edit instructions, callback, or graph data:', {
                hasEditInstructions: !!editInstructions,
                hasCallback: !!onGraphUpdate,
                hasGraphData: !!graphData,
              });
            }
          },
          onError: (error: string) => {
            // Structured cost errors arrive via onCostError below with
            // typed data; this onError path is for transport-level failures
            // (network blips, parse errors, etc.). Preserve any partial
            // that streamed before the error so the user can read what
            // they got + see the actual failure inline. Without this the
            // partial vanishes and the user has no signal beyond the chat
            // resetting. Mirror the `aborted` and `cap_exceeded` paths:
            // capture content_blocks too so the half-built turn (text +
            // signed thinking + paired tool blocks) round-trips into the
            // next request. `isReplayableAssistantBlock` strips unsigned
            // thinking and orphan tool blocks, and
            // `fixupAssistantBlocksForReplay` handles trailing-shape edge
            // cases — worst case Anthropic 400s on retry, best case the
            // user recovers from a network blip without losing context.
            //
            // acceptedRef gate: if the preflight hadn't accepted yet, no
            // user message was committed to chat — stamping anything here
            // would orphan into the wrong conversation slot. Just reset
            // and let the outer catch surface a banner.
            if (acceptedRef.current) {
              const partial = streamingMessageRef.current;
              const partialBlocks = streamingContentBlocksRef.current;
              const hasBlocks = partialBlocks.length > 0;
              const hasText = !!partial && partial.content.length > 0;
              if (partial && (hasText || hasBlocks)) {
                const stamped: ChatMessage = {
                  ...partial,
                  was_killed: true,
                  kill_reason: 'error',
                  kill_message: error,
                  content: hasText
                    ? partial.content
                    : '_(Assistant errored before writing a visible response.)_',
                  content_blocks: hasBlocks ? partialBlocks : undefined,
                };
                setMessages((prev) => [...prev, stamped]);
              } else {
                // No visible partial — surface the error as a fresh assistant
                // turn so the user still sees what went wrong.
                const errorMessage: ChatMessage = {
                  id: assistantMessageId,
                  role: 'assistant',
                  content: `Error: ${error}`,
                  timestamp: new Date(),
                };
                setMessages((prev) => [...prev, errorMessage]);
              }
            }
            resetStreamUiState();
          },
          onContentBlocks: (blocks) => {
            // Mirror chatService's accumulator so handleStopStreaming can
            // read it synchronously when the user clicks Stop (the service's
            // own AbortError catch fires too late for that path).
            streamingContentBlocksRef.current = blocks;
          },
          onCostUpdate: (runningUsd: number) => {
            creditByokDelta({
              tag: 'chat',
              runningUsd,
              usesByok: streamUsesByok,
              lastAppliedMicroRef: turnLastAppliedMicroRef,
              chartId: streamChartId,
              keyLast4: streamKeyLast4,
            });
            runningCostUsdRef.current = runningUsd;
            setRunningCostUsd(runningUsd);
          },
          onCostError: (error) => {
            // Preserve whatever partial content streamed before the kill so the
            // user can still read it. Without this the entire assistant turn
            // would vanish from the chat window on a mid-stream cap hit. Even
            // when no visible text arrived (model was still thinking), keep a
            // placeholder so the conversation history shows the turn happened.
            //
            // acceptedRef gate: a preflight rejection (429/413/402/etc.) fires
            // BEFORE onAccepted lands, so there's no user message in chat and
            // streamingMessageRef is just a placeholder we set sync. Stamping
            // it as a "cut off" assistant turn would conjure a phantom into
            // the wrong slot. Only stamp on mid-stream kills (request_cost_
            // ceiling_exceeded, etc.), which by definition fire AFTER accept.
            if (acceptedRef.current) {
              const partial = streamingMessageRef.current;
              if (partial) {
                const hasText = partial.content.length > 0;
                // Stamp the partial assistant turn with was_killed=true so the
                // bubble shows an "interrupted" indicator. Capture the partial
                // content_blocks too: when the user follows up with "continue",
                // the next request ships the half-built turn (text + signed
                // thinking + paired tool blocks) so Anthropic resumes from
                // where the kill landed.
                const partialBlocks = error.partialContentBlocks;
                const stamped: ChatMessage = {
                  ...partial,
                  was_killed: true,
                  kill_reason: 'cap_exceeded',
                  content_blocks:
                    partialBlocks && partialBlocks.length > 0 ? partialBlocks : undefined,
                  content: hasText
                    ? partial.content
                    : '_(Assistant was cut off before writing a visible response.)_',
                };
                setMessages((prev) => [...prev, stamped]);
              }
            }
            handleCostError(error);
            resetStreamUiState();
          },
        },
        signal: abortControllerRef.current?.signal,
        model: selectedModel,
        webSearchEnabled,
        highlightedNodes,
        extendedThinkingEnabled: true,
        effort: selectedEffort,
        attachedFileIds,
        idempotencyKey,
        chartId: resolvedChartId,
        // For anon charts the worker's file-ownership gate in
        // anthropic-stream.ts requires the editToken. Owned charts
        // authorize via the JWT; passing the token alongside is harmless.
        editToken: resolvedChart?.editToken,
        loggingMessageId: userMessageId,
        // userAnthropicKey: server-stored BYOK; the raw key is never retained client-side.
        // keyLast4 is passed separately so the post-stream pollUntilReconciled
        // can route bump events to the correct per-key BYOK bucket (the bump
        // guard requires non-null keyLast4 — without it bumps are dropped).
        keyLast4: streamKeyLast4,
      });
    } catch (error) {
      // Transport-level failures (network blip, parse error, etc.).
      // Cost errors were swallowed earlier in chatService.ts:1487 and
      // routed via onCostError, so anything here is a generic transport
      // problem.
      //
      // acceptedRef gate: a pre-preflight throw (DNS, CORS preflight,
      // etc.) fires before onAccepted, so there's no user message in
      // chat — surfacing a "Sorry, there was an error" assistant bubble
      // would orphan into the wrong slot. Reset state and let the user
      // retry; the actual transport error is logged to console for
      // debugging. Post-accept transport errors keep the existing UX
      // (visible apology bubble paired with the user's message).
      console.error('[ChatInterface] handleSendMessage transport error:', error);
      if (acceptedRef.current) {
        const errorMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: 'Sorry, there was an error processing your request.',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
      resetStreamUiState();
    } finally {
      setIsLoading(false);
      sendInFlightRef.current = false;
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
    // Cancel any in-flight stream so it doesn't stamp a leftover assistant
    // message into the cleared chat. chatService.ts:1487 silently swallows
    // AbortError before any client callback fires, but the streaming
    // callbacks ALSO read these refs to decide whether to stamp a partial
    // turn (see the onError/onCostError "stamp if there's partial content"
    // branches); null them so those branches naturally no-op. Also reset
    // acceptedRef so the partial-turn gate stays false if a stream-end
    // callback somehow fires after the abort window.
    abortControllerRef.current?.abort();
    streamingMessageRef.current = null;
    streamingContentBlocksRef.current = [];
    acceptedRef.current = false;

    setMessages([]);
    setChatAttachedFiles([]);
    // Preserve cap-class blockers across clearChat — cap is global to the
    // user (not per-chart), so wiping the banner on Clear Chat would
    // briefly mislead them. Per-context blockers (advisory,
    // last_send_exceeded) clear. Same predicate as the route-change
    // effect — both are "user changed context, but global state stands".
    setComposerBlocker(preserveCapClassOnly);
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
    //
    // For anon charts the worker requires the editToken (header or query
    // param); owned charts use the JWT via getAuthHeaders(). If we only
    // have the editToken (route `/edit/<token>`, no cached chartId yet)
    // skip — we don't have a real chart_id to send anyway.
    const chartIdForCleanup = params.chartId ?? autosavedChartIdRef.current;
    const editTokenForCleanup = params.editToken ?? autosavedEditTokenRef.current;
    if (chartIdForCleanup) {
      void (async () => {
        try {
          const headers = await getAuthHeaders();
          if (editTokenForCleanup) {
            headers['X-Edit-Token'] = editTokenForCleanup;
          }
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

  // Cached chart identity for charts auto-saved this session. ensureChartExists
  // updates the URL via history.replaceState (no route re-render), so React
  // Router params lag the actual chart on subsequent calls; these refs are
  // the synchronous source of truth.
  const autosavedEditTokenRef = useRef<string | null>(null);
  const autosavedChartIdRef = useRef<string | null>(null);

  /**
   * Ensure the chat has a persisted chart before doing anything that needs a
   * chart_id (file uploads, logging, per-chart BYOK spend, etc.). For the
   * `/` root route this lazily POSTs `/api/charts` on demand; for the
   * `/edit/<token>` and `/chart/<id>` routes the chart already exists and
   * we just return its id. Idempotent — safe to call multiple times.
   *
   * Side effects on first creation: navigates to `/edit/<editToken>` (with
   * replace=true so the back button doesn't return to `/`) and fires
   * `onChartCreated`, which in App.tsx triggers `initializeLogging` — so
   * the logging session is up before the first saveMessage lands.
   */
  const ensureChartExists = useCallback(async (): Promise<{
    chartId: string;
    editToken: string;
  } | null> => {
    // 1. Already have both (route param, autosave ref, or previous lookup).
    const existingChartId = params.chartId ?? autosavedChartIdRef.current;
    const existingEditToken = params.editToken ?? autosavedEditTokenRef.current;
    if (existingChartId && existingEditToken) {
      return { chartId: existingChartId, editToken: existingEditToken };
    }
    // 2. Have editToken but no chartId — happens on `/edit/<token>` after a
    //    page reload, since autosavedChartIdRef is memory-only. Resolve via
    //    the API rather than creating a new chart (which would strand the
    //    user's existing one). Also guards against the past bug where
    //    editToken (36 chars) fell through as chart_id (VARCHAR(12)).
    if (existingEditToken && !existingChartId) {
      try {
        const resolved = await ChartService.getChartByEditToken(existingEditToken);
        autosavedChartIdRef.current = resolved.chartId;
        autosavedEditTokenRef.current = existingEditToken;
        return { chartId: resolved.chartId, editToken: existingEditToken };
      } catch (e) {
        // Do NOT fall through to createChart — we already have an editToken
        // pointing at a real chart, creating a new one would strand the
        // user's existing chart under a different URL and they'd lose their
        // work. Surface the error via an advisory blocker (same "try again"
        // shape as service_unavailable) and return null so the caller
        // knows not to proceed.
        console.error('[ChatInterface] getChartByEditToken failed:', e);
        setComposerBlocker({
          type: 'advisory',
          cost_error_type: 'database_unavailable',
          detail:
            "Couldn't load your chart. Check your connection and try again — " +
            "we won't create a duplicate while the existing chart is still around.",
        });
        return null;
      }
    }
    // 3. No chart yet — auto-save.
    if (!graphData) return null;
    try {
      const created = await ChartService.createChart(graphData);
      ChartService.saveEditToken(created.chartId, created.editToken);
      autosavedEditTokenRef.current = created.editToken;
      autosavedChartIdRef.current = created.chartId;
      // Migrate any chat history already persisted under the pre-navigation
      // URL's storage key to the new chart's key. Covers the refresh-after-
      // send case (user sends a message on `/`, we auto-create a chart, the
      // message gets saved under `chatHistory_root` by the save-effect
      // before we navigate — without this migration it'd be stranded
      // there after the URL transitions to `/edit/<token>`).
      const oldKey = getStorageKey();
      const newKey = `chatHistory_edit_${created.editToken}`;
      if (oldKey !== newKey) {
        const existing = localStorage.getItem(oldKey);
        if (existing) {
          localStorage.setItem(newKey, existing);
          localStorage.removeItem(oldKey);
        }
      }
      // Use React Router's navigate instead of window.history.replaceState
      // so useParams()/useLocation() stay in sync with the URL bar. Raw
      // replaceState bypasses the router, leaving params.editToken stale,
      // which caused the save-chat effect to keep writing to
      // chatHistory_root instead of chatHistory_edit_<token> until the
      // next full reload — so first-message sessions lost their history.
      // The flag tells the route-change effect NOT to wipe the in-memory
      // `messages` state during the transition (messages are mid-flight).
      // `state.skipChartReload` tells ToCViewer's load effect not to
      // re-fetch the chart from the server (we just created it, it's
      // already in memory). Without this, the user sees a brief flash of
      // the loading state every time auto-create fires — on first
      // message, on every PDF upload, and after Turnstile if that's the
      // first send.
      justAutoCreatedRef.current = true;
      navigate(`/edit/${created.editToken}`, {
        replace: true,
        state: { skipChartReload: true },
      });
      onChartCreated?.(created.editToken, created.chartId);
      return { chartId: created.chartId, editToken: created.editToken };
    } catch (e) {
      console.error('[ChatInterface] ensureChartExists failed:', e);
      return null;
    }
  }, [params.chartId, params.editToken, graphData, onChartCreated, navigate, getStorageKey]);

  const uploadPdfToFilesApi = useCallback(
    async (
      file: File,
    ): Promise<{ file_id: string; filename: string; size_bytes: number; mime_type: string }> => {
      // Delegate chart resolution to ensureChartExists so the upload path
      // can't accidentally use editToken (36 chars) as chart_id (VARCHAR(12))
      // — the fallback chain in the old inline code did exactly that on
      // page reloads, producing NeonDbError: value too long for type
      // character varying(12).
      const chart = await ensureChartExists();
      if (!chart) {
        throw new Error('No chart data available to save');
      }
      const chartIdForUpload = chart.chartId;

      const formData = new FormData();
      formData.append('file', file);
      formData.append('chart_id', chartIdForUpload);

      const headers = await getAuthHeaders();
      // Anon charts (user_id NULL on the server) require the edit token to
      // authorize an upload; without it the Worker returns 403 "forbidden"
      // before ever talking to Anthropic, so page-limit errors get masked.
      if (chart.editToken) {
        headers['X-Edit-Token'] = chart.editToken;
      }
      const response = await fetch('/api/upload-file', {
        method: 'POST',
        credentials: 'include',
        headers, // multipart boundary set by the browser
        body: formData,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        // Prefer the server's human-readable `upstream_message` over the
        // machine error code (e.g. "pdf_too_many_pages") — the code is
        // useful for branching logic but awful as a user-facing error.
        const friendly =
          typeof errorBody?.upstream_message === 'string' && errorBody.upstream_message.length > 0
            ? errorBody.upstream_message
            : typeof errorBody?.error === 'string'
              ? errorBody.error
              : `Upload failed (${response.status})`;
        throw new Error(friendly);
      }
      return response.json();
    },
    [getAuthHeaders, ensureChartExists],
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
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

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
              prev.map((f) => (f.id === id ? { ...f, status: 'error', error: message } : f)),
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
        return prev.map((f) => (f.id === id ? { ...f, status: 'uploading', error: undefined } : f));
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

  const handleGenerateFileRemove = useCallback(
    (id: string) => {
      // Same orphan-cleanup posture as handleChatFileRemove: if the
      // removed chip was an already-uploaded PDF, fire the DELETE so the
      // Anthropic file + chart_files row don't linger.
      const removed = generateAttachedChips.find((f) => f.id === id);
      setGenerateAttachedChips((prev) => prev.filter((f) => f.id !== id));
      if (removed?.kind === 'upload' && removed.fileId) {
        const editTokenForCleanup = params.editToken ?? autosavedEditTokenRef.current;
        void (async () => {
          try {
            const headers = await getAuthHeaders();
            if (editTokenForCleanup) {
              headers['X-Edit-Token'] = editTokenForCleanup;
            }
            await fetch(`/api/files/${encodeURIComponent(removed.fileId!)}`, {
              method: 'DELETE',
              headers,
            });
          } catch (err) {
            console.warn('[ChatInterface] delete-file cleanup failed:', err);
          }
        })();
      }
    },
    [generateAttachedChips, getAuthHeaders, params.editToken],
  );

  const removeFile = (fileToRemove: File) => {
    setFiles((prev) => prev.filter((f) => f.file !== fileToRemove));
  };

  // Stable ID prefix for synthesised AttachedFile chips representing
  // text files in the Generate-mode `files[]` state (which lacks ids).
  // The prefix is matched in handleGenerateUnifiedRemove to dispatch back
  // to `removeFile` for text files versus `handleGenerateFileRemove` for
  // the (id-bearing) PDF chips. Index-based id is fine because removal
  // mutates the source array and the chips are re-derived from scratch.
  const GENERATE_TEXT_CHIP_PREFIX = 'gen-text-';

  // Unified view of all Generate-mode attachments (PDF chips + text-file
  // entries) for AttachedFilesBar. Lets the Generate composer mirror the
  // Chat composer's single-tray pattern. Text-file chips synthesise a
  // status — `reading` maps to `uploading`, `ready` carries the size,
  // `error` keeps the original errorMessage — so the existing chip UI
  // renders them with no special-cases needed.
  const generateUnifiedChips = useMemo<AttachedFile[]>(() => {
    const textChips: AttachedFile[] = files.map((entry, idx) => ({
      id: `${GENERATE_TEXT_CHIP_PREFIX}${idx}`,
      filename: entry.file.name,
      mimeType: entry.file.type || 'text/plain',
      sizeBytes: entry.file.size,
      status:
        entry.status === 'ready' ? 'ready' : entry.status === 'reading' ? 'uploading' : 'error',
      error: entry.status === 'error' ? (entry.errorMessage ?? 'Failed to read file') : undefined,
    }));
    return [...generateAttachedChips, ...textChips];
  }, [generateAttachedChips, files]);

  // Remove handler routed by chip kind. Text-file chips synthesise ids
  // with the GENERATE_TEXT_CHIP_PREFIX and remove from `files[]`; all
  // others dispatch to handleGenerateFileRemove (PDF chip cleanup).
  const handleGenerateUnifiedRemove = useCallback(
    (id: string) => {
      if (id.startsWith(GENERATE_TEXT_CHIP_PREFIX)) {
        const idx = Number(id.slice(GENERATE_TEXT_CHIP_PREFIX.length));
        if (Number.isFinite(idx)) {
          const target = files[idx];
          if (target) removeFile(target.file);
        }
        return;
      }
      handleGenerateFileRemove(id);
    },
    [files, handleGenerateFileRemove],
  );

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
          prev.map((f) => (f.id === id ? { ...f, status: 'error', error: message } : f)),
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

  const handleChatFileRemove = useCallback(
    (id: string) => {
      // Snapshot the chip before we filter it out so we can tell if it
      // needs a server-side cleanup (uploaded PDF → chart_files row +
      // Anthropic Files API entry) or is purely local (text file we
      // never uploaded, or a still-uploading placeholder with no
      // file_id yet).
      const removed = chatAttachedFiles.find((f) => f.id === id);
      setChatAttachedFiles((prev) => prev.filter((f) => f.id !== id));
      if (removed?.kind === 'upload' && removed.fileId) {
        const editTokenForCleanup = params.editToken ?? autosavedEditTokenRef.current;
        void (async () => {
          try {
            const headers = await getAuthHeaders();
            if (editTokenForCleanup) {
              headers['X-Edit-Token'] = editTokenForCleanup;
            }
            await fetch(`/api/files/${encodeURIComponent(removed.fileId!)}`, {
              method: 'DELETE',
              headers,
            });
          } catch (err) {
            // Fire-and-forget — the sweep/clear-chat paths catch orphans
            // if this DELETE misses. Logging only for visibility.
            console.warn('[ChatInterface] delete-file cleanup failed:', err);
          }
        })();
      }
    },
    [chatAttachedFiles, getAuthHeaders, params.editToken],
  );

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

      const confirmMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '🎯 **Graph Loaded!** The Theory of Change has been loaded into your workspace.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, confirmMessage]);
    }
  };

  const startGeneration = async () => {
    // Synchronous double-send guard, same as handleSendMessage. See
    // sendInFlightRef declaration for rationale.
    if (sendInFlightRef.current) return;

    const readyTextFiles = files.filter((f) => f.status === 'ready').length;
    const readyPdfFiles = generateAttachedFileIds.length;
    const hasPrompt = additionalInstructions.trim().length > 0;
    // Allow prompt-only generation. Documents are optional; a non-empty
    // prompt is enough to kick off a Generate run.
    if (readyTextFiles + readyPdfFiles === 0 && !hasPrompt) {
      return;
    }
    // Block on in-flight PDF uploads so the request doesn't race the file_id.
    if (generateAttachedChips.some((f) => f.status === 'uploading')) {
      return;
    }

    // Cap gate — same predicate as the Chat path. Generate had zero
    // cap protection before this; a capped user clicking Generate would
    // wipe their Chat history (setMessages([generationMessage]) below)
    // before the server rejected, with no banner to explain why.
    // Placed AFTER the three early-exits but BEFORE any state mutation
    // (including the confirm dialog).
    if (shouldBlockSend(renderedBlocker)) {
      return;
    }

    // Destructive-action confirmation. startGenerationInternal will replace
    // `messages` with the generation prompt, wiping any in-progress chat.
    // Open the modal if there's something to lose; the modal's onConfirm
    // closes it + calls startGenerationInternal. Pre-confirm: NO state
    // mutations (no sendInFlightRef.current=true, no setIsLoading) — per
    // FM-Crit-1, mutations must hoist above the dialog so cancel leaves
    // the UI in a clean state (no stuck "thinking..." after cancel).
    if (messages.length > 0) {
      // Note: cancelGenerateEstimate is intentionally NOT called here.
      // The user is still looking at the Generate panel with the modal
      // open over it; if they cancel, the live estimate (which may
      // continue updating during the dialog) reflects the actual cost
      // of what they'd be sending. cancelGenerateEstimate runs inside
      // startGenerationInternal — only on confirmed proceed.
      setShowGenerateConfirm(true);
      return;
    }

    await startGenerationInternal();
  };

  // The body of startGeneration after the confirm gate. Extracted so the
  // modal's onConfirm callback can call it directly without re-running the
  // early-exit checks (which would race state changes that occurred while
  // the modal was open). Two-phase callback pattern; see the
  // "Replace your Chat?" <ConfirmModal> below for the modal that re-enters
  // here.
  const startGenerationInternal = async () => {
    sendInFlightRef.current = true;
    // Cancel any pending/in-flight debounced count_tokens estimate (same
    // banner-thrash mitigation as handleSendMessage). Server preflight
    // is authoritative; the estimate is moot once Generate is in flight.
    cancelGenerateEstimate();
    // Spinner ON (S1: shown via spinner icon on the Generate button while
    // isLoading && !isStreaming). Set sync, BEFORE the streamMessage call,
    // so a slow preflight surfaces the spinner immediately.
    setIsLoading(true);
    // Defensive resets: hide leftover content if React commits before
    // onAccepted lands. Streaming visibility (isStreaming) and mode swap
    // (setCurrentMode('chat')) are deferred into onAccepted per C5/Q4 so
    // a preflight rejection doesn't wipe the user's current Chat history.
    setStreamingContent('');
    setStreamingThinking('');
    streamingContentBlocksRef.current = [];
    // Pre-arm the accepted flag (set true in onAccepted). Gates
    // handleStopStreaming's stamping logic across the preflight window.
    acceptedRef.current = false;

    // Combine all file contents
    const documentContent = files
      .filter((f) => f.status === 'ready')
      .map((f) => `=== ${f.file.name} ===\n${f.content}`)
      .join('\n\n');

    // Create the specialized conversation prompt
    const conversationPrompt = `${generateModePromptContent}

## Document Content:
${documentContent}

${
  additionalInstructions.trim()
    ? `## Additional Instructions:
${additionalInstructions.trim()}

`
    : ''
}Based on this information, generate a comprehensive Theory of Change development conversation following the gold standard process. The conversation should demonstrate evidence-based thinking, counterfactual discipline, and result in a complete, implementable JSON graph structure.

IMPORTANT: Generate this as a realistic conversation between Strategy Co-Pilot and Organization Representative, with back-and-forth exchanges that show the thinking process.`;

    const userMessageId = crypto.randomUUID();
    const generationAssistantId = crypto.randomUUID();

    const generationMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: conversationPrompt,
      timestamp: new Date(),
    };

    // Mode swap (setCurrentMode) + destructive setMessages([generationMessage])
    // both deferred into onAccepted below. Without this, a capped user who
    // hit Generate would lose their Chat history before the server's 429
    // landed.

    streamingMessageRef.current = {
      id: generationAssistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };

    // Create a new abort controller for this request
    abortControllerRef.current = new AbortController();

    // See chat-path comment above; snapshot the BYOK state at submit time
    // to survive a key swap mid-stream and bind the BYOK pill update to
    // the right key. For free/anon users hasKey is false here and the
    // server enforces the $5 lifetime cap via reserveCost + kill switch.
    //
    // Generate doesn't go through ensureChartExists (PDFs were uploaded
    // earlier in the flow, which auto-created the chart and populated the
    // autosaved* refs). But on the very first send from `/`, params can
    // still be the pre-navigation snapshot in this closure — same race
    // as the chat path. Prefer autosavedEditTokenRef which is set
    // synchronously by the upload's chart-create step, falling back to
    // params for the path where the user landed on /edit/<token> directly.
    const streamChartId =
      autosavedEditTokenRef.current ?? params.chartId ?? params.editToken ?? null;
    const streamKeyLast4 = keyLast4;
    const streamUsesByok = hasKey;
    turnLastAppliedMicroRef.current = 0;

    // Pre-send pill sync; see chat-mode call site for full rationale.
    void syncChartByokCostFromDb(streamChartId);

    try {
      await chatService.streamMessage({
        messages: [generationMessage],
        currentGraphData: graphData,
        mode: 'generate',
        callbacks: {
          // Deferred-add commit point for Generate. Per C5/C6 we hold off
          // on the destructive setMessages([generationMessage]) + the
          // setCurrentMode('chat') flip until the server's preflight
          // reservation accepts the request. A capped user who hit
          // Generate would lose their Chat history pre-reservation
          // without this gate.
          onAccepted: () => {
            // Switch to chat mode now that the generation is going to
            // happen — JSX gating for streaming UI, banner placement,
            // and the post-rejection banner area all key off currentMode.
            setCurrentMode('chat');
            setMessages([generationMessage]);
            // Streaming UI takes over; the thinking placeholder chips
            // and the bouncing-dots bubble both wait on isStreaming.
            setIsStreaming(true);
            // Extended thinking is always on; seed the phase.
            setStreamPhase('thinking');
            // acceptedRef flips LAST so any throw above leaves the gate
            // closed and outer error handlers skip stamping.
            acceptedRef.current = true;
          },
          onStreamPhase: (phase) => {
            setStreamPhase(phase);
          },
          onContent: (_chunk: string, fullContent: string) => {
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
          onComplete: (finalMessage, editInstructions, usage) => {
            const assistantMessage: ChatMessage = {
              id: generationAssistantId,
              role: 'assistant',
              content: finalMessage,
              timestamp: new Date(),
              usage: usage
                ? {
                    input_tokens: usage.input_tokens || 0,
                    output_tokens: usage.output_tokens || 0,
                    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                    web_search_requests: usage.server_tool_use?.web_search_requests || 0,
                    cost_usd: runningCostUsdRef.current ?? undefined,
                  }
                : undefined,
            };

            setMessages((prev) => [...prev, assistantMessage]);
            resetStreamUiState();

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
                  content:
                    '✅ **Graph Generated Successfully!** A complete Theory of Change has been created. Click the button below to load it into your workspace.',
                  timestamp: new Date(),
                };
                setMessages((prev) => [...prev, successMessage]);
              } else {
                // Add an error message if parsing failed
                const errorMessage: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content:
                    '⚠️ **Graph Parse Error**: The AI generated a complete Theory of Change conversation, but there was an issue parsing the JSON structure. Please check the generated JSON manually.',
                  timestamp: new Date(),
                };
                setMessages((prev) => [...prev, errorMessage]);
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
            // Transport-level failures. Cost errors were swallowed in
            // chatService.ts:1487 and routed via onCostError. Mirror the
            // Chat-site error path: preserve partial content_blocks so
            // signed thinking + paired tool blocks round-trip into the
            // next request after a transient failure.
            //
            // acceptedRef gate: a preflight rejection (server's reserveCost
            // 429/413/etc.) fires BEFORE onAccepted, so no destructive
            // setMessages has happened — preserving the user's existing
            // Chat history. Surface the banner via handleCostError (which
            // chatService routes separately) and just reset.
            if (acceptedRef.current) {
              const partial = streamingMessageRef.current;
              const partialBlocks = streamingContentBlocksRef.current;
              const hasBlocks = partialBlocks.length > 0;
              const hasText = !!partial && partial.content.length > 0;
              if (partial && (hasText || hasBlocks)) {
                const stamped: ChatMessage = {
                  ...partial,
                  was_killed: true,
                  kill_reason: 'error',
                  kill_message: error,
                  content: hasText
                    ? partial.content
                    : '_(Assistant errored before writing a visible response.)_',
                  content_blocks: hasBlocks ? partialBlocks : undefined,
                };
                setMessages((prev) => [...prev, stamped]);
              } else {
                const errorMessage: ChatMessage = {
                  id: generationAssistantId,
                  role: 'assistant',
                  content: `Error: ${error}`,
                  timestamp: new Date(),
                };
                setMessages((prev) => [...prev, errorMessage]);
              }
            }
            resetStreamUiState();
          },
          onContentBlocks: (blocks) => {
            // Mirror chatService's accumulator so handleStopStreaming can
            // read it synchronously when the user clicks Stop (the service's
            // own AbortError catch fires too late for that path).
            streamingContentBlocksRef.current = blocks;
          },
          onCostUpdate: (runningUsd: number) => {
            creditByokDelta({
              tag: 'gen',
              runningUsd,
              usesByok: streamUsesByok,
              lastAppliedMicroRef: turnLastAppliedMicroRef,
              chartId: streamChartId,
              keyLast4: streamKeyLast4,
            });
            runningCostUsdRef.current = runningUsd;
            setRunningCostUsd(runningUsd);
          },
          onCostError: (error) => {
            // Preserve the partial Generate turn (text/thinking streamed
            // before the kill) so it's still visible in the chat. Even with
            // no visible text (cut off mid-thinking), keep a placeholder.
            //
            // acceptedRef gate: preserves the existing Chat history when
            // the preflight rejects (no destructive setMessages happened
            // yet — onAccepted is gated on response.ok).
            if (acceptedRef.current) {
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
            }
            handleCostError(error);
            resetStreamUiState();
          },
        },
        signal: abortControllerRef.current?.signal,
        model: selectedModel,
        webSearchEnabled,
        highlightedNodes,
        extendedThinkingEnabled: true,
        effort: selectedEffort,
        attachedFileIds: generateAttachedFileIds,
        idempotencyKey: crypto.randomUUID(), // fresh per send: dedupes browser reload / double-click
        // Generate mode always has a chart by this point (attached files
        // routed through uploadPdfToFilesApi, which calls ensureChartExists).
        // Fall back to route params for defense in depth but never leak
        // editToken through as chart_id.
        chartId: params.chartId ?? autosavedChartIdRef.current ?? undefined,
        // For anon charts the worker's file-ownership gate in
        // anthropic-stream.ts requires the editToken. Owned charts
        // authorize via the JWT; passing the token alongside is harmless.
        editToken: params.editToken ?? autosavedEditTokenRef.current ?? undefined,
        loggingMessageId: userMessageId,
        // userAnthropicKey: server-stored BYOK; raw key not held client-side.
        // keyLast4 routes post-stream bump events to the per-key BYOK bucket;
        // see chat-mode call site above for the full rationale.
        keyLast4: streamKeyLast4,
      });
    } catch (error) {
      // Transport-level failures (see Chat-site commentary in
      // handleSendMessage). Cost errors are routed via onCostError.
      // acceptedRef gate: pre-preflight throws (DNS, CORS) preserve the
      // user's current Chat history; post-accept transport errors surface
      // the apology bubble paired with the (already-committed) generation
      // user turn.
      console.error('[ChatInterface] startGeneration transport error:', error);
      if (acceptedRef.current) {
        const errorMessage: ChatMessage = {
          id: generationAssistantId,
          role: 'assistant',
          content: 'Sorry, there was an error processing your request.',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
      resetStreamUiState();
    } finally {
      setIsLoading(false);
      sendInFlightRef.current = false;
    }
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {!isCollapsed && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-30 md:hidden" onClick={onToggle} />
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
          // The drawer starts at the TopBar row's bottom edge and
          // tucks 1px under the bar's border-b (bar is z-50, drawer
          // z-40, so the border paints on top — no white seam).
          // TOP_BAR_HEIGHT_PX is row + border, hence the -1.
          top: `${TOP_BAR_HEIGHT_PX - 1}px`,
          bottom: 0,
          height: `calc(100vh - ${TOP_BAR_HEIGHT_PX - 1}px)`,
        }}
      >
        {/* Drawer Header. Title sits left; Clear (chat mode with history
            only) and the collapse chevron sit right — only the chevron
            toggles (clicking the title text does NOT). When collapsed the
            title and Clear are hidden and the chevron is centered as the
            sole control. No bottom padding: the chat header below brings
            its own p-3 (round-2 feedback 42 — the old layout stacked
            p-2 + p-3 + an orphaned mb-3 spacer row into a 32px dead gap).
            Spacing contract (round-4 feedback 71): one 12px box gap at
            every step — drawer top → title row (pt-3 here), title row →
            tab strip (the chat header's p-3), tab strip → usage line
            (space-y-3 there), usage line → border (p-3 again). The title
            glyphs start at 12px (px-2 here + pl-1 on the span) so they
            sit on the same left line as the tab strip / usage bar (p-3),
            and the chevron svg's right edge mirrors it (px-2 + p-1
            button). Keep px-2 symmetric: the collapsed rail centers the
            chevron in it. */}
        <div className="flex-shrink-0 px-2 pt-3">
          <div
            className={`h-8 flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}
          >
            {!isCollapsed && (
              <span className="text-sm font-medium text-gray-700 pl-1 select-none">
                AI Assistant
              </span>
            )}
            <div className="flex items-center gap-1">
              {!isCollapsed && currentMode === 'chat' && messages.length > 0 && (
                <button
                  onClick={() => {
                    // Destructive: wipes the in-memory chat + attached files +
                    // any uploaded file chips from the server. Confirm first so
                    // a mis-click can't silently delete a long conversation.
                    setConfirmClearChatOpen(true);
                  }}
                  className="text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 px-1.5 py-1 rounded-md transition-colors"
                  title="Clear chat"
                >
                  Clear
                </button>
              )}
              <button
                onClick={onToggle}
                className="p-1 rounded-md text-gray-500 hover:text-gray-800 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 transition-colors"
                title={isCollapsed ? 'Expand AI Assistant' : 'Collapse AI Assistant'}
                aria-label={isCollapsed ? 'Expand AI Assistant' : 'Collapse AI Assistant'}
                aria-expanded={!isCollapsed}
              >
                <ChevronLeftIcon
                  className={`w-4 h-4 transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Chat Content. `min-h-0` lets the inner `flex-1 overflow-y-auto`
            content area actually scroll — without it, flex-1's default
            min-height of `auto` lets the content's intrinsic size win and
            the scroll container grows past the viewport instead of
            clipping + scrolling. */}
        <div
          className={`flex-1 min-h-0 overflow-hidden transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}
        >
          <div className="h-full flex flex-col min-h-0">
            {/* Chat Header. (The Clear-chat affordance lives in the drawer
                title row above — its old wrapper row here was an orphaned
                spacer that inflated the title→tabs gap, round-2 feedback
                42.) */}
            <div className="p-3 border-b border-gray-200">
              {/* Mode Switcher and Model Selector. space-y-3 keeps the
                  tab strip → usage line gap on the same 12px rhythm as
                  the rest of the header (round-4 feedback 71). */}
              <div className="space-y-3">
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
                the source of truth for billing. (Spacing comes from the
                parent's space-y-3 — don't add a competing margin here.) */}
                {usage && (
                  <div>
                    {usage.tier === 'byok' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-gray-700">
                        <span aria-hidden>🔑</span>
                        <span>
                          BYOK{keyLast4 ? ` · ...${keyLast4}` : ''}
                          {chartByokSpendUsd > 0 && (
                            <> &middot; {formatCostUsd(chartByokSpendUsd)} this chart</>
                          )}
                        </span>
                        <button
                          type="button"
                          data-tooltip-id="byok-cost-info"
                          aria-label="About this cost estimate"
                          className="inline-flex items-center text-gray-400 hover:text-gray-600 focus:text-gray-600 focus:outline-none"
                        >
                          <InformationCircleIcon className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ) : (
                      <div>
                        {/* Clamp the displayed used to the limit so the
                            kill-switch + preflight buffer (effective cap
                            = limit * 1.05) never surfaces a literal
                            contradiction like "$5.10 of $5.00 used". */}
                        {(() => {
                          const displayedUsed = Math.min(usage.used_usd, usage.limit_usd);
                          return (
                            <>
                              <div
                                className="w-full h-1 bg-gray-200 rounded overflow-hidden"
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={usage.limit_usd}
                                aria-valuenow={displayedUsed}
                                aria-label={`AI budget usage: ${formatCostUsd(displayedUsed)} of ${formatCostUsd(usage.limit_usd)}`}
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
                                  Used {formatCostUsd(displayedUsed)} of{' '}
                                  {formatCostUsd(usage.limit_usd)}
                                </span>
                                {hasKey && (
                                  <span className="inline-flex items-center gap-0.5 text-gray-600">
                                    <span aria-hidden>🔑</span>
                                    <span>Key ready</span>
                                  </span>
                                )}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Content Area */}
            <div
              ref={chatContainerRef}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3"
              onScroll={handleScroll}
            >
              {currentMode === 'chat' ? (
                <>
                  {messages.length === 0 ? (
                    <div className="text-center text-gray-500 text-sm py-8">
                      <div className="mb-2">
                        <ChatBubbleLeftRightIcon className="w-8 h-8 mx-auto text-gray-400" />
                      </div>
                      <p className="font-medium text-gray-700">Build your ToC step-by-step.</p>
                      <p className="mt-2 text-xs">
                        Ask questions and the assistant edits the flowchart with you as the
                        conversation unfolds. Best when you want fine-grained control or are still
                        thinking it through.
                      </p>
                      <p className="mt-2 text-xs">
                        Already have a Theory of Change? You can edit it directly on the canvas.
                      </p>
                      <p className="mt-2 text-xs">
                        Want a complete draft from your existing documents in one shot? Switch to
                        the <strong>Generate</strong> tab.
                      </p>
                    </div>
                  ) : null}

                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                </>
              ) : currentMode === 'generate' ? (
                // Empty-state intro. Mirrors Chat mode's empty-state shape
                // (centered text, py-8). The prior visual scaffolding —
                // amber advisory panel, icon, dashed drop-zone, inline
                // textarea + model/effort/Turnstile card stack — was
                // replaced by a chat-style composer pinned at the bottom
                // (see Input Area below); only the intro copy lives here.
                // The "moves to chat" + "costs a few dollars" lines are
                // the must-haves per the brief.
                <div className="text-center text-gray-500 text-sm py-8">
                  <div className="mb-2">
                    <DocumentTextIcon className="w-8 h-8 mx-auto text-gray-400" />
                  </div>
                  <p className="font-medium text-gray-700">Generate a full draft in one pass.</p>
                  <p className="mt-2 text-xs">
                    Describe what you want and attach any supporting documents. Generate runs a deep
                    analysis and writes your Theory of Change directly on the canvas.
                  </p>
                  <p className="mt-2 text-xs">
                    Once you submit, this view switches to chat — you can follow the cost ticking
                    live there and stop anytime.
                  </p>
                  <p className="mt-2 text-xs">
                    A run typically costs a few dollars, more for large documents or heavy web
                    searching.
                  </p>
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
                  {isStreaming &&
                    (streamingContent || streamingThinking) &&
                    (() => {
                      const { display, generatingEdits } = streamingContent
                        ? prepareStreamingDisplay(streamingContent)
                        : { display: '', generatingEdits: false };
                      const hasAnything = display || generatingEdits || streamingThinking;
                      if (!hasAnything) return null;
                      return (
                        <div
                          className="w-full text-sm text-gray-800"
                          // Only the streaming bubble announces; historical
                          // messages remain silent so screen readers aren't
                          // flooded on scrollback. aria-atomic=false so deltas
                          // are announced incrementally rather than the whole
                          // bubble repeating on every chunk.
                          role="log"
                          aria-live="polite"
                          aria-atomic="false"
                        >
                          <div>
                            {display && (
                              <div className="text-left prose prose-sm max-w-none prose-table:block prose-table:overflow-x-auto prose-pre:overflow-x-auto prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-100 prose-pre:text-gray-800">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{display}</ReactMarkdown>
                              </div>
                            )}
                            {generatingEdits && (
                              <div
                                className={`flex items-center gap-2 text-xs text-amber-800 ${display ? 'mt-2' : ''}`}
                              >
                                <PencilSquareIcon
                                  className="w-4 h-4 animate-pulse text-amber-600"
                                  aria-hidden
                                />
                                <span>Generating edits to the graph…</span>
                              </div>
                            )}
                            {streamingThinking && (
                              <details
                                className={`text-xs text-gray-500 ${display || generatingEdits ? 'mt-2 pt-2 border-t border-gray-200' : ''}`}
                                open={thinkingExpanded}
                                onToggle={(e) =>
                                  setThinkingExpanded((e.target as HTMLDetailsElement).open)
                                }
                              >
                                <summary className="cursor-pointer select-none text-gray-600 hover:text-gray-800 inline-flex items-center gap-1">
                                  <SparklesIcon
                                    className="w-3.5 h-3.5 text-purple-500"
                                    aria-hidden
                                  />
                                  <span>
                                    {thinkingExpanded ? 'Hide thinking' : 'Show thinking'}
                                  </span>
                                </summary>
                                <div className="mt-1 whitespace-pre-wrap italic text-gray-600 leading-relaxed">
                                  {streamingThinking}
                                </div>
                              </details>
                            )}
                            <div className="text-xs mt-1 text-gray-500">
                              <div className="flex items-center gap-1.5">
                                {/* Loud "live" indicator (solid dot + ping
                                    ring) so the user can distinguish an
                                    active stream from a silent stall. */}
                                <span className="relative inline-flex h-2.5 w-2.5" aria-hidden>
                                  <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping"></span>
                                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500"></span>
                                </span>
                                <span>Streaming…</span>
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

                  {/* Phase chip rendered after the streaming bubble so the
                    "still working" hint sits next to the partial text. Phase
                    invariant lives in chatService: sticky `using_tools`
                    upgrades to `searching` on first server_tool_use=web_search
                    in a burst; resets on the next text/thinking burst.
                    `writing` deliberately renders no chip — the bubble itself
                    already signals typing. */}
                  {streamPhase === 'using_tools' && (
                    <div className="flex justify-start">
                      <div className="bg-amber-50 text-amber-800 rounded-lg rounded-bl-sm p-2 text-sm border border-amber-200">
                        <div className="flex items-center gap-2">
                          <SparklesIcon className="w-4 h-4 animate-pulse text-amber-600" />
                          <span className="text-amber-700">Using tools…</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {streamPhase === 'searching' && (
                    <div className="flex justify-start">
                      <div className="bg-blue-50 text-blue-800 rounded-lg rounded-bl-sm p-2 text-sm border border-blue-200">
                        <div className="flex items-center gap-2">
                          <MagnifyingGlassIcon className="w-4 h-4 animate-spin text-blue-600" />
                          <span className="text-blue-700">Searching the web…</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {streamPhase === 'thinking' && (
                    <div className="flex justify-start">
                      <div className="bg-purple-50 text-purple-800 rounded-lg rounded-bl-sm p-2 text-sm border border-purple-200">
                        <div className="flex items-center gap-2">
                          <SparklesIcon className="w-4 h-4 animate-pulse text-purple-600" />
                          <span className="text-purple-700">Thinking about your request…</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* All cap/cost banners (including advisory) consolidated
                    into <ComposerBlockerBanner> in the composer area below.
                    Trade-off documented in the PR: advisory banners lose
                    temporal pairing with the failed user message (they used
                    to render here inline with chat history); consistent
                    placement with the cap variants is the win. */}

                  {/* Bouncing-dots placeholder for the post-accept window
                      before the first streamPhase signal arrives. Gated on
                      isStreaming (not isLoading) so it stays hidden during
                      the preflight reservation window — per Q4 the only
                      preflight signal is the Send button's spinner icon
                      swap, no other UI changes. */}
                  {isStreaming && !streamPhase && (
                    <div className="flex justify-start">
                      <div className="bg-gray-100 text-gray-800 rounded-lg rounded-bl-sm p-2 text-sm">
                        <div className="flex items-center gap-1">
                          <div className="flex space-x-1">
                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                            <div
                              className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                              style={{ animationDelay: '0.1s' }}
                            ></div>
                            <div
                              className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                              style={{ animationDelay: '0.2s' }}
                            ></div>
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

            {/* Input Area. Now serves both Chat and Generate modes; Generate's
                composer mirrors Chat's exactly except for the textarea state
                binding (additionalInstructions vs inputValue) and the submit
                handler (startGeneration vs handleSendMessage). Files attached
                in Generate mode route through the existing dual-state system
                (text files into `files`, PDFs into `generateAttachedChips`),
                surfaced together via AttachedFilesBar. */}
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
                      Solve the challenge below to verify you're human before sending a message.
                    </div>
                    <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onToken={handleTurnstileToken} />
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
                        {selectedNodes.length === 1
                          ? '1 node selected'
                          : `${selectedNodes.length} nodes selected`}
                      </div>
                    )}
                    {!isAuthenticated && !TURNSTILE_SITE_KEY && import.meta.env.DEV ? (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                        Anonymous quota unavailable (VITE_TURNSTILE_SITE_KEY unset); please sign in.
                      </div>
                    ) : null}
                    {/* Cap/cost/advisory banner. All variants unified into
                      a single React.memo'd component reading from
                      renderedBlocker (see src/components/chat/composerBlocker.ts).
                      Variants: cap_reached, request_cut_off, global_budget,
                      would_exceed_cap, session_expired_quota, advisory.
                      Quota variants also carry the estimate status (fb6
                      issue 74) — see estimateFailure prop. */}
                    <ComposerBlockerBanner
                      blocker={renderedBlocker}
                      usage={usage}
                      hasKey={hasKey}
                      composerEstimateUsd={activeEstimate}
                      estimateFailure={composerEstimateFailure}
                      isAuthenticated={isAuthenticated}
                    />
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
                    {/* Under-textarea estimate cluster. Suppressed while a
                      quota blocker is rendered (fb6 issue 74): the banner
                      carries the estimate status for those variants, and
                      this cluster clips below the fold once the blocker
                      stack is up (reproduced at 1366x662 — the composer
                      column doesn't scroll). Its "output shown live during
                      streaming" promise is also incoherent while sending
                      is paused. */}
                    {!bannerCarriesEstimateStatus(renderedBlocker) && (
                      <>
                        <div className="text-xs text-gray-500 flex items-center gap-1.5">
                          {estimatingCost && (
                            <span
                              className="w-3 h-3 border-[1.5px] border-gray-400 border-t-transparent rounded-full animate-spin"
                              aria-label="Recalculating estimate"
                            />
                          )}
                          <span>
                            Estimated input cost: {formatCostUsd(composerEstimateUsd)}; output shown
                            live during streaming.
                          </span>
                        </div>
                        {composerEstimateFailure && (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                            {estimateUnavailableNote(composerEstimateFailure)} Fell back to a rough
                            local estimate; the actual reservation may differ.
                          </div>
                        )}
                      </>
                    )}
                    {composerUncountedFileIds.length > 0 && (
                      <div
                        className="text-xs text-amber-800"
                        title={`File IDs: ${composerUncountedFileIds.join(', ')}`}
                      >
                        {composerUncountedFileIds.length} file
                        {composerUncountedFileIds.length === 1 ? '' : 's'} couldn't be priced;
                        estimate excludes them.
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      {/* PR 1 polish: bottom composer redesigned to
                        [+ Attach] [Model ▾] [⚙] [Send]. Web search +
                        effort moved into the ⚙ popover (plan §1.4 +
                        traceability table #4). */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => chatFileInputRef.current?.click()}
                          className="p-2 rounded-lg transition-colors text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                          title="Attach a file"
                          aria-label="Attach a file"
                        >
                          <PaperClipIcon className="w-5 h-5" />
                        </button>
                        <ModelDropdown selected={selectedModel} onSelect={setSelectedModel} />
                        <div className="relative" ref={composerOptionsRef}>
                          <button
                            onClick={() => setShowComposerOptions((s) => !s)}
                            className="p-2 rounded-lg transition-colors text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            title="Composer options"
                            aria-label="Composer options"
                            aria-haspopup="menu"
                            aria-expanded={showComposerOptions}
                          >
                            <Cog6ToothIcon className="w-5 h-5" />
                          </button>
                          {showComposerOptions && (
                            // Horizontal position is measured + clamped
                            // (useClampedPopoverX), NOT a static side
                            // anchor: the popover sits inside the panel's
                            // overflow-hidden wrapper, so `left-0` clipped
                            // at the panel's right edge and `right-0` at
                            // its left (PR #34 feedback #60). Each row is
                            // a single line: label left, control right.
                            <div
                              role="menu"
                              ref={composerOptionsClamp.ref}
                              style={composerOptionsClamp.style}
                              className="absolute bottom-full mb-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 p-3 z-50 space-y-3"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium text-gray-700">Web search</div>
                                <button
                                  type="button"
                                  onClick={() => setWebSearchEnabled((v) => !v)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    webSearchEnabled ? 'bg-blue-600' : 'bg-gray-300'
                                  }`}
                                  aria-pressed={webSearchEnabled}
                                  aria-label="Toggle web search"
                                >
                                  <span
                                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                                      webSearchEnabled ? 'translate-x-4' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium text-gray-700">
                                  Effort level
                                </div>
                                <EffortDropdown
                                  model={selectedModel}
                                  selected={selectedEffort}
                                  onSelect={setSelectedEffort}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isStreaming ? (
                          <button
                            onClick={handleStopStreaming}
                            className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                            title="Stop generation"
                          >
                            <StopIcon className="w-5 h-5" />
                          </button>
                        ) : isLoading ? (
                          // Preflight window (server's reserveCost reservation
                          // in flight). Per Q4 / user direction the ONLY
                          // visual signal is the spinner icon swap on the
                          // Send button position; no other UI changes,
                          // including no click affordance. Disabled — the
                          // preflight is fast (~100-300ms typically) and
                          // exposing a "stop" semantic on a non-streaming
                          // request adds complexity without a clear user
                          // need (no spend has been committed yet anyway).
                          <button
                            type="button"
                            disabled
                            className="p-2 bg-blue-500 text-white rounded-lg opacity-60 cursor-not-allowed"
                            title="Sending…"
                          >
                            <div
                              className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"
                              aria-label="Waiting for server"
                            />
                          </button>
                        ) : (
                          <button
                            onClick={handleSendMessage}
                            // Use length check rather than trim() — on a huge
                            // paste, inputValue.trim() would allocate a full
                            // copy of the string on every render. Whitespace-
                            // only input still gets rejected at send-time.
                            // shouldBlockSend disables on cap_reached /
                            // request_cut_off / global_budget / would_exceed_cap
                            // (plus advisory='unknown' defensive over-block);
                            // handleSendMessage also early-returns via the
                            // same predicate.
                            disabled={
                              inputValue.length === 0 ||
                              shouldBlockSend(renderedBlocker) ||
                              // Block while any attached file is still uploading
                              // or has failed: send would either early-return
                              // server-side or silently drop the errored chip,
                              // neither of which matches user intent.
                              chatAttachedFiles.some(
                                (f) => f.status === 'uploading' || f.status === 'error',
                              )
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
              ) : currentMode === 'generate' ? (
                hasTurnstileSession === null ? (
                  /* Probe in flight — same posture as Chat to avoid a
                     flash of the Turnstile gate for returning anon users
                     with a still-valid cookie. */
                  <div className="h-24" aria-hidden />
                ) : !isAuthenticated && TURNSTILE_SITE_KEY && !hasTurnstileSession ? (
                  /* Anon Turnstile gate. Same shape and prompt as the
                     Chat branch — solving here also unlocks Chat (the
                     `tocb_anon` cookie is shared across modes). */
                  <div className="space-y-2">
                    <div className="text-sm text-gray-700 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                      Solve the challenge below to verify you&apos;re human before generating.
                    </div>
                    <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onToken={handleTurnstileToken} />
                    {turnstileError && (
                      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                        {turnstileError}
                      </div>
                    )}
                  </div>
                ) : (
                  /* Generate composer. Mirrors the Chat composer JSX
                     exactly — same banner, same AttachedFilesBar, same
                     textarea + estimate line + bottom bar — and differs
                     only in: state binding (additionalInstructions vs
                     inputValue), file handlers (handleFileUpload routes
                     PDFs to the Files API + text into `files[]`), the
                     placeholder, and submit handler (startGeneration). */
                  <div className="space-y-2">
                    {!isAuthenticated && !TURNSTILE_SITE_KEY && import.meta.env.DEV ? (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                        Anonymous quota unavailable (VITE_TURNSTILE_SITE_KEY unset); please sign in.
                      </div>
                    ) : null}
                    <ComposerBlockerBanner
                      blocker={renderedBlocker}
                      usage={usage}
                      hasKey={hasKey}
                      composerEstimateUsd={activeEstimate}
                      estimateFailure={composerEstimateFailure}
                      isAuthenticated={isAuthenticated}
                    />
                    {/* Unified attachment tray. Shows both Files-API PDFs
                        (`generateAttachedChips`) and inlined text files
                        (`files[]`, synthesised into chip shape via
                        `generateUnifiedChips`). Drop-target stays mounted
                        so files dropped on the composer area land here. */}
                    <AttachedFilesBar
                      files={generateUnifiedChips}
                      onRemove={handleGenerateUnifiedRemove}
                      onRetry={handleGenerateFileRetry}
                      onDropFiles={handleFileUpload}
                    />
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".txt,.md,.markdown,.pdf,.csv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rtf"
                      onChange={(e) => {
                        if (e.target.files) handleFileUpload(e.target.files);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                    <textarea
                      value={additionalInstructions}
                      onChange={(e) => setAdditionalInstructions(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void startGeneration();
                        }
                      }}
                      placeholder="Describe what you want, or just attach documents…"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none overflow-y-auto"
                      disabled={isLoading || isStreaming}
                      rows={1}
                      style={{ minHeight: '2.5rem', maxHeight: '8rem' }}
                      onInput={(e) => {
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
                    {/* Under-textarea estimate cluster — same suppression
                      rule as the Chat composer (fb6 issue 74): the banner
                      carries the estimate status while a quota blocker is
                      rendered. */}
                    {!bannerCarriesEstimateStatus(renderedBlocker) && (
                      <>
                        <div className="text-xs text-gray-500 flex items-center gap-1.5">
                          {estimatingCost && (
                            <span
                              className="w-3 h-3 border-[1.5px] border-gray-400 border-t-transparent rounded-full animate-spin"
                              aria-label="Recalculating estimate"
                            />
                          )}
                          <span>
                            Estimated input cost: {formatCostUsd(generateEstimateUsd)}; output shown
                            live during streaming.
                          </span>
                        </div>
                        {composerEstimateFailure && (
                          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                            {estimateUnavailableNote(composerEstimateFailure)} Fell back to a rough
                            local estimate; the actual reservation may differ.
                          </div>
                        )}
                      </>
                    )}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isLoading || isStreaming}
                          className="p-2 rounded-lg transition-colors text-gray-500 enabled:hover:text-gray-700 enabled:hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Attach a file"
                          aria-label="Attach a file"
                        >
                          <PaperClipIcon className="w-5 h-5" />
                        </button>
                        <ModelDropdown selected={selectedModel} onSelect={setSelectedModel} />
                        <div className="relative" ref={composerOptionsRef}>
                          <button
                            onClick={() => setShowComposerOptions((s) => !s)}
                            className="p-2 rounded-lg transition-colors text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            title="Composer options"
                            aria-label="Composer options"
                            aria-haspopup="menu"
                            aria-expanded={showComposerOptions}
                          >
                            <Cog6ToothIcon className="w-5 h-5" />
                          </button>
                          {showComposerOptions && (
                            // Measured + clamped horizontal position — see
                            // the Chat-composer popover above (feedback #60).
                            <div
                              role="menu"
                              ref={composerOptionsClamp.ref}
                              style={composerOptionsClamp.style}
                              className="absolute bottom-full mb-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 p-3 z-50 space-y-3"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium text-gray-700">Web search</div>
                                <button
                                  type="button"
                                  onClick={() => setWebSearchEnabled((v) => !v)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    webSearchEnabled ? 'bg-blue-600' : 'bg-gray-300'
                                  }`}
                                  aria-pressed={webSearchEnabled}
                                  aria-label="Toggle web search"
                                >
                                  <span
                                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                                      webSearchEnabled ? 'translate-x-4' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-xs font-medium text-gray-700">
                                  Effort level
                                </div>
                                <EffortDropdown
                                  model={selectedModel}
                                  selected={selectedEffort}
                                  onSelect={setSelectedEffort}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isStreaming ? (
                          <button
                            onClick={handleStopStreaming}
                            className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                            title="Stop generation"
                          >
                            <StopIcon className="w-5 h-5" />
                          </button>
                        ) : isLoading ? (
                          <button
                            type="button"
                            disabled
                            className="p-2 bg-blue-500 text-white rounded-lg opacity-60 cursor-not-allowed"
                            title="Generating…"
                          >
                            <div
                              className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"
                              aria-label="Waiting for server"
                            />
                          </button>
                        ) : (
                          <button
                            onClick={() => void startGeneration()}
                            disabled={
                              (files.filter((f) => f.status === 'ready').length +
                                generateAttachedFileIds.length ===
                                0 &&
                                additionalInstructions.trim().length === 0) ||
                              generateAttachedChips.some(
                                (f) => f.status === 'uploading' || f.status === 'error',
                              ) ||
                              shouldBlockSend(renderedBlocker)
                            }
                            className="p-2 bg-blue-500 text-white rounded-lg enabled:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            title="Generate Theory of Change"
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
      </div>

      {/* BYOK cost info tooltip — keep short. Just discloses that this
          is an estimate and Anthropic's console is the source of truth. */}
      <Tooltip
        id="byok-cost-info"
        place="bottom"
        className="!max-w-[240px] !text-xs !leading-snug"
        style={{ zIndex: 9999 }}
      >
        Estimate from streaming events. Anthropic&apos;s console is the source of truth and may show
        more.
      </Tooltip>

      {/* Generate destroys current Chat history — surface that explicitly
          before mutating state. The two-phase flow lives in startGeneration
          (open modal & early-return on first click; modal's onConfirm calls
          startGenerationInternal). Cancel leaves UI clean (no mutations
          had happened pre-confirm). Uses the shared ConfirmModal primitive
          with the purple variant + DocumentPlusIcon for Generate-flow
          framing. */}
      <ConfirmModal
        open={showGenerateConfirm}
        title="Replace your Chat?"
        body={
          <p>
            Generating a new Theory of Change will replace your current Chat (
            {messages.length === 1 ? '1 message' : `${messages.length} messages`}) with a fresh
            generation conversation. Your existing chart isn&apos;t affected.
          </p>
        }
        confirmLabel="Generate"
        confirmVariant="purple"
        icon={
          <div className="p-3 bg-purple-100 rounded-full">
            <DocumentPlusIcon className="w-8 h-8 text-purple-600" />
          </div>
        }
        onConfirm={() => {
          setShowGenerateConfirm(false);
          void startGenerationInternal();
        }}
        onCancel={() => {
          setShowGenerateConfirm(false);
        }}
      />

      {/* Clear-chat confirmation (PR 5 red-team L4 closure). Distinct from
          the "Replace your Chat?" modal above: this is user-initiated
          deletion of the entire chat (including uploaded files), not the
          implicit Generate-overwrites-history confirmation. Uses the shared
          ConfirmModal primitive for consistency with FileMenu's
          delete-chart and GeneralAccessSelector. */}
      <ConfirmModal
        open={confirmClearChatOpen}
        title="Clear chat?"
        body="Clear the entire chat? This removes all messages and any files attached in Chat. Your chart and Generate state are unaffected."
        confirmLabel="Clear chat"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmClearChatOpen(false);
          clearChat();
        }}
        onCancel={() => setConfirmClearChatOpen(false)}
      />
    </>
  );
}
