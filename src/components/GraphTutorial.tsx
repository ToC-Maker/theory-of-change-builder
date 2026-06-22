import { useState, useEffect, useCallback } from 'react';
import { Tooltip } from 'react-tooltip';
import { XMarkIcon } from '@heroicons/react/24/outline';

// Custom-event name fired by HelpPanel's "Replay the view-mode walkthrough"
// button. Lifting tutorial state into a shared context would require
// threading a prop chain through TopBar+MobileMenu+HelpPanel and the
// editor/viewer root containers (HelpPanel sits in TopBar, GraphTutorial
// sits next to the canvas — disjoint subtrees), so we use a window-scoped
// CustomEvent to bridge them with zero plumbing. Tests can fire the same
// event to drive the tutorial open.
export const GRAPH_TUTORIAL_REPLAY_EVENT = 'graph-tutorial-replay';

export function GraphTutorial() {
  // Default closed. Previously this auto-opened 1.5s after first render
  // when localStorage('graph-tutorial-seen') was absent, which surprised
  // users (PR #34 reviewer feedback: "some kind of tutorial pops up at
  // some point, I'm not sure what is triggering it") and offered no
  // visible dismiss affordance — the only way to clear it was to
  // complete both steps (click a random node, then click a random edge).
  // The HelpPanel's "Replay the view-mode walkthrough" button is the
  // sole entry point; first-time users discover the tutorial via Help
  // rather than being hijacked by it.
  const [isVisible, setIsVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const [targetNode, setTargetNode] = useState<HTMLElement | null>(null);

  const tutorialSteps = [
    { text: 'Click a node to see its connections and edit it' },
    { text: 'Click to see connection details' },
  ];

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setCurrentStep(0);

    // Clean up hover state
    if (targetNode) {
      const mouseLeaveEvent = new MouseEvent('mouseleave', { bubbles: true });
      targetNode.dispatchEvent(mouseLeaveEvent);
    }
  }, [targetNode]);

  const handleGlobalClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Clicks on the tutorial tooltip itself (incl. the × close button)
      // are handled by react-tooltip + the explicit onClick on the
      // button. Don't treat them as outside-click dismissals.
      if (target.closest('[data-graph-tutorial-tooltip]')) {
        return;
      }

      if (currentStep === 0) {
        // Check if clicked on the target node. After PR 3, single-click
        // both highlights connections AND opens the anchored NodeEditor,
        // so this is the only step we need before edges.
        if (targetNode && (target === targetNode || targetNode.contains(target))) {
          setCurrentStep(1);
          return;
        }
        // Click outside the highlighted node → dismiss (no localStorage
        // gate; reopening is via HelpPanel → Replay).
        handleClose();
      } else if (currentStep === 1) {
        // Check if clicked on an SVG path (edge).
        const svg = document.querySelector('svg');
        if (svg) {
          // Check if the click was on a path element. Walk up parents
          // until we reach the SVG root; DOM types for HTMLElement vs
          // SVGSVGElement are disjoint in TS, so compare via Node.
          let element: (HTMLElement | SVGElement) | null = target;
          while (element && (element as globalThis.Node) !== (svg as globalThis.Node)) {
            if (element.tagName === 'path') {
              handleClose();
              return;
            }
            element = element.parentElement;
          }
        }
        // Click that wasn't on any SVG path → dismiss.
        handleClose();
      }
    },
    [currentStep, targetNode, handleClose],
  );

  // Listen for the cross-subtree "open tutorial" custom event fired by
  // HelpPanel. Memoise the handler dep so the listener stays stable
  // across renders of the same instance.
  useEffect(() => {
    const handleReplay = () => {
      setCurrentStep(0);
      setIsVisible(true);
    };
    window.addEventListener(GRAPH_TUTORIAL_REPLAY_EVENT, handleReplay);
    return () => window.removeEventListener(GRAPH_TUTORIAL_REPLAY_EVENT, handleReplay);
  }, []);

  // Dismiss on Escape while visible.
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, handleClose]);

  const updateTooltipPosition = useCallback(() => {
    if (currentStep === 0) {
      // Step 1: Find a random node
      const nodes = document.querySelectorAll('[id^="node-"]');
      if (nodes.length === 0) return;

      const targetIndex = Math.floor(Math.random() * nodes.length);
      const node = nodes[targetIndex] as HTMLElement;
      const rect = node.getBoundingClientRect();

      setTargetNode(node);
      setTooltipPosition({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    } else if (currentStep === 1) {
      // Step 2: Find an edge/connection
      // Find all SVG elements and look for the one with connection paths
      const allSvgs = Array.from(document.querySelectorAll('svg'));
      console.log('Total SVGs found:', allSvgs.length);

      // Find the SVG with the most paths (that's the connections SVG).
      // Use reduce instead of forEach + mutable accumulator so TS keeps a
      // non-`never` type for `svg` after the narrowing guard below.
      const svg = allSvgs.reduce<SVGSVGElement | null>((best, svgElement, index) => {
        const pathCount = svgElement.querySelectorAll('path[d]').length;
        const bestCount = best ? best.querySelectorAll('path[d]').length : 0;
        console.log(`SVG ${index}: ${pathCount} paths`);
        return pathCount > bestCount ? svgElement : best;
      }, null);

      if (!svg) {
        console.log('No SVG with paths found');
        return;
      }

      const paths = svg.querySelectorAll('path[d]');
      console.log('Selected SVG has', paths.length, 'paths');

      if (paths.length === 0) return;

      // Find a visible connection path
      // Based on the HTML structure, we want paths with stroke-width around 3px
      let targetPath: SVGPathElement | null = null;
      const visiblePaths: SVGPathElement[] = [];

      for (let i = 0; i < paths.length; i++) {
        const path = paths[i] as SVGPathElement;

        // Skip marker paths
        if (path.closest('marker')) continue;

        const style = window.getComputedStyle(path);
        const stroke = style.stroke;
        const strokeWidth = parseFloat(style.strokeWidth);

        console.log(`Path ${i}: stroke=${stroke}, strokeWidth=${strokeWidth}`);

        // Look for visible connection lines (stroke-width around 3px, not transparent)
        if (stroke && stroke !== 'transparent' && strokeWidth >= 2 && strokeWidth <= 4) {
          visiblePaths.push(path);
          console.log(`Found visible path ${visiblePaths.length}`);
        }
      }

      // Pick a random visible path
      if (visiblePaths.length > 0) {
        const randomIndex = Math.floor(Math.random() * visiblePaths.length);
        targetPath = visiblePaths[randomIndex];
        console.log(`Selected random path ${randomIndex + 1} of ${visiblePaths.length}`);
      }

      if (!targetPath) {
        console.log('No target path found');
        return;
      }

      // Get the actual midpoint of the path curve
      const pathLength = targetPath.getTotalLength();
      const midPoint = targetPath.getPointAtLength(pathLength / 2);

      console.log('Path midpoint (SVG coords):', midPoint.x, midPoint.y);

      // Convert SVG coordinates to screen coordinates using getScreenCTM
      const svgPoint = svg.createSVGPoint();
      svgPoint.x = midPoint.x;
      svgPoint.y = midPoint.y;
      const screenCTM = svg.getScreenCTM();

      if (screenCTM) {
        const screenPoint = svgPoint.matrixTransform(screenCTM);
        console.log('Screen point:', screenPoint.x, screenPoint.y);
        setTooltipPosition({
          x: screenPoint.x,
          y: screenPoint.y,
        });
      }
    }
  }, [currentStep, targetNode]);

  useEffect(() => {
    if (isVisible) {
      updateTooltipPosition();
      // Add global click listener
      document.addEventListener('click', handleGlobalClick, true);

      // Update on scroll/resize so the anchor stays glued across pan.
      window.addEventListener('scroll', updateTooltipPosition, true);
      window.addEventListener('resize', updateTooltipPosition);

      return () => {
        document.removeEventListener('click', handleGlobalClick, true);
        window.removeEventListener('scroll', updateTooltipPosition, true);
        window.removeEventListener('resize', updateTooltipPosition);
      };
    }
  }, [currentStep, isVisible, targetNode, handleGlobalClick, updateTooltipPosition]);

  if (!isVisible || !tooltipPosition) return null;

  return (
    <>
      {/* Invisible anchor element for the tooltip */}
      <div
        data-tooltip-id="graph-tutorial-tooltip"
        className="fixed w-1 h-1 pointer-events-none"
        style={{
          left: `${tooltipPosition.x}px`,
          top: `${tooltipPosition.y}px`,
          zIndex: 61,
        }}
      />

      {/* Tooltip */}
      <Tooltip
        id="graph-tutorial-tooltip"
        place="top"
        isOpen={isVisible}
        clickable
        className="!max-w-[140px] !text-[8px] !px-1.5 !py-0.5 sm:!max-w-[180px] sm:!text-xs sm:!px-3 sm:!py-1.5 md:!max-w-[200px] md:!text-sm md:!px-3 md:!py-2"
        style={{ zIndex: 9999 }}
      >
        <div data-graph-tutorial-tooltip className="flex items-start gap-1.5 sm:gap-2">
          <span className="flex-1 text-center">{tutorialSteps[currentStep].text}</span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close tutorial"
            className="shrink-0 -mr-0.5 -mt-0.5 p-0.5 rounded text-white/80 hover:text-white hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 transition-colors"
          >
            <XMarkIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          </button>
        </div>
      </Tooltip>
    </>
  );
}
