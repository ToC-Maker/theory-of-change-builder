import { useState, useEffect, useCallback } from 'react';
import { Tooltip } from 'react-tooltip';

export function GraphTutorial() {
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
    localStorage.setItem('graph-tutorial-seen', 'true');

    // Clean up hover state
    if (targetNode) {
      const mouseLeaveEvent = new MouseEvent('mouseleave', { bubbles: true });
      targetNode.dispatchEvent(mouseLeaveEvent);
    }
  }, [targetNode]);

  const handleGlobalClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      if (currentStep === 0) {
        // Check if clicked on the target node. After PR 3, single-click
        // both highlights connections AND opens the anchored NodeEditor,
        // so this is the only step we need before edges.
        if (targetNode && (target === targetNode || targetNode.contains(target))) {
          setCurrentStep(1);
        }
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
      }
    },
    [currentStep, targetNode, handleClose],
  );

  useEffect(() => {
    // Check if user has seen the tutorial before
    const hasSeenTutorial = localStorage.getItem('graph-tutorial-seen');
    if (!hasSeenTutorial) {
      // Show tutorial after a delay to let the graph render
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

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
        className="!max-w-[100px] !text-[8px] !px-1.5 !py-0.5 sm:!max-w-[140px] sm:!text-xs sm:!px-3 sm:!py-1.5 md:!max-w-[160px] md:!text-sm md:!px-3 md:!py-2"
        style={{ zIndex: 9999 }}
      >
        <div className="text-center">{tutorialSteps[currentStep].text}</div>
      </Tooltip>
    </>
  );
}
