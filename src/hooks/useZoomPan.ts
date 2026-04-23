import { useState, useEffect, useCallback, useRef, RefObject } from 'react';

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const EMBED_PADDING = 32;

interface UseZoomPanOptions {
  containerSize: { width: number; height: number };
  containerRef: RefObject<HTMLDivElement>;
  viewportOffset?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  excludeFromPan?: (target: HTMLElement) => boolean;
}

interface Camera {
  x: number;
  y: number;
  z: number;
}

export function useZoomPan({
  containerSize,
  containerRef,
  viewportOffset = { left: 0, top: 0, right: 0, bottom: 0 },
  excludeFromPan,
}: UseZoomPanOptions) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const [fitToScreenZoom, setFitToScreenZoom] = useState(1);
  const hasInitializedZoom = useRef(false);

  // Use refs for values needed in event handlers to avoid re-attaching listeners
  const cameraRef = useRef(camera);
  const fitToScreenZoomRef = useRef(fitToScreenZoom);
  const containerSizeRef = useRef(containerSize);
  const viewportOffsetRef = useRef(viewportOffset);
  const excludeFromPanRef = useRef(excludeFromPan);

  // Pan state in refs to avoid re-renders during drag
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartCameraRef = useRef<{ x: number; y: number } | null>(null);

  // Touch/pinch state
  const lastTouchDistanceRef = useRef<number | null>(null);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);
  const touchStartTimeRef = useRef<number>(0);

  // For UI - only update when panning starts/stops
  const [isPanning, setIsPanning] = useState(false);

  // Keep refs in sync (update synchronously, not in effects)
  cameraRef.current = camera;
  fitToScreenZoomRef.current = fitToScreenZoom;
  containerSizeRef.current = containerSize;
  viewportOffsetRef.current = viewportOffset;
  excludeFromPanRef.current = excludeFromPan;

  const contentWidth = containerSize.width + EMBED_PADDING;
  const contentHeight = containerSize.height + EMBED_PADDING;

  // Helper to get viewport dimensions
  const getAvailableViewport = useCallback(() => {
    const offset = viewportOffsetRef.current;
    const viewportWidth = window.innerWidth - offset.left - offset.right;
    const viewportHeight = window.innerHeight - offset.top - offset.bottom;
    return { width: viewportWidth, height: viewportHeight };
  }, []);

  // Calculate fit-to-screen zoom level
  const calculateFitToScreenZoom = useCallback(() => {
    const size = containerSizeRef.current;
    if (!size.width || !size.height) return 1;

    const cWidth = size.width + EMBED_PADDING;
    const cHeight = size.height + EMBED_PADDING;
    const { width: availableWidth, height: availableHeight } = getAvailableViewport();
    const scaleX = availableWidth / cWidth;
    const scaleY = availableHeight / cHeight;
    return Math.max(MIN_SCALE, Math.min(scaleX, scaleY));
  }, [getAvailableViewport]);

  // Update fit-to-screen zoom when container size or window changes
  useEffect(() => {
    if (!containerSize.width || !containerSize.height) return;

    const updateFitZoom = () => {
      const newFitZoom = calculateFitToScreenZoom();
      setFitToScreenZoom(newFitZoom);
      fitToScreenZoomRef.current = newFitZoom;

      setCamera((prev) => {
        if (prev.z < newFitZoom) {
          const newCam = { x: 0, y: 0, z: newFitZoom };
          cameraRef.current = newCam;
          return newCam;
        }
        return prev;
      });
    };

    updateFitZoom();

    let resizeTimeout: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateFitZoom, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [containerSize.width, containerSize.height, calculateFitToScreenZoom]);

  // Initialize camera to fit-to-screen on first load
  useEffect(() => {
    if (hasInitializedZoom.current || !containerSize.width || !containerSize.height) return;

    const fitZoom = calculateFitToScreenZoom();
    setFitToScreenZoom(fitZoom);
    fitToScreenZoomRef.current = fitZoom;
    const newCam = { x: 0, y: 0, z: fitZoom };
    setCamera(newCam);
    cameraRef.current = newCam;
    hasInitializedZoom.current = true;
  }, [containerSize.width, containerSize.height, calculateFitToScreenZoom]);

  // Calculate screen position based on camera state
  const getTransformPosition = useCallback(() => {
    const { width: availableWidth, height: availableHeight } = getAvailableViewport();
    const offset = viewportOffsetRef.current;
    const cWidth = containerSizeRef.current.width + EMBED_PADDING;
    const cHeight = containerSizeRef.current.height + EMBED_PADDING;
    const cam = cameraRef.current;

    const scaledWidth = cWidth * cam.z;
    const scaledHeight = cHeight * cam.z;

    const baseOffsetX = offset.left + (availableWidth - scaledWidth) / 2;
    const baseOffsetY = offset.top + (availableHeight - scaledHeight) / 2;

    return {
      x: baseOffsetX + cam.x * cam.z,
      y: baseOffsetY + cam.y * cam.z,
      scale: cam.z,
    };
  }, [getAvailableViewport]);

  // Stable event handlers - attached once
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      const isZoomGesture = e.ctrlKey || e.metaKey;
      const isHorizontalScroll = e.shiftKey;

      const offset = viewportOffsetRef.current;
      const { width: availableWidth, height: availableHeight } = getAvailableViewport();
      const cWidth = containerSizeRef.current.width + EMBED_PADDING;
      const cHeight = containerSizeRef.current.height + EMBED_PADDING;
      const fitZoom = fitToScreenZoomRef.current;

      if (isZoomGesture) {
        e.preventDefault();
        e.stopPropagation();

        const zoomStep = 0.08;
        const delta = -e.deltaY > 0 ? 1 : -1;
        const prev = cameraRef.current;

        const newZoom = Math.max(fitZoom, Math.min(MAX_SCALE, prev.z + delta * zoomStep * prev.z));

        let newCam: Camera;
        if (newZoom <= fitZoom * 1.01) {
          newCam = { x: 0, y: 0, z: fitZoom };
        } else {
          const mouseX = e.clientX;
          const mouseY = e.clientY;

          const scaledWidth = cWidth * prev.z;
          const scaledHeight = cHeight * prev.z;
          const baseOffsetX = offset.left + (availableWidth - scaledWidth) / 2;
          const baseOffsetY = offset.top + (availableHeight - scaledHeight) / 2;
          const offsetX = baseOffsetX + prev.x * prev.z;
          const offsetY = baseOffsetY + prev.y * prev.z;

          const localX = (mouseX - offsetX) / prev.z;
          const localY = (mouseY - offsetY) / prev.z;

          const newScaledWidth = cWidth * newZoom;
          const newScaledHeight = cHeight * newZoom;
          const newBaseOffsetX = offset.left + (availableWidth - newScaledWidth) / 2;
          const newBaseOffsetY = offset.top + (availableHeight - newScaledHeight) / 2;

          const targetOffsetX = mouseX - localX * newZoom;
          const targetOffsetY = mouseY - localY * newZoom;

          const newPanX = (targetOffsetX - newBaseOffsetX) / newZoom;
          const newPanY = (targetOffsetY - newBaseOffsetY) / newZoom;

          const maxPanX = Math.max(0, (cWidth * newZoom - availableWidth) / (2 * newZoom) + 50);
          const maxPanY = Math.max(0, (cHeight * newZoom - availableHeight) / (2 * newZoom) + 50);

          newCam = {
            x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
            y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
            z: newZoom,
          };
        }

        cameraRef.current = newCam;
        setCamera(newCam);
      } else {
        // Regular scroll = Pan
        const prev = cameraRef.current;
        if (prev.z <= fitZoom * 1.01) return;

        e.preventDefault();

        const scrollSpeed = 1;
        const deltaX = isHorizontalScroll ? e.deltaY : e.deltaX;
        const deltaY = isHorizontalScroll ? 0 : e.deltaY;

        const newPanX = prev.x - (deltaX * scrollSpeed) / prev.z;
        const newPanY = prev.y - (deltaY * scrollSpeed) / prev.z;

        const maxPanX = Math.max(0, (cWidth * prev.z - availableWidth) / (2 * prev.z) + 50);
        const maxPanY = Math.max(0, (cHeight * prev.z - availableHeight) / (2 * prev.z) + 50);

        const newCam = {
          ...prev,
          x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
          y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
        };

        cameraRef.current = newCam;
        setCamera(newCam);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'BUTTON' || target.closest('button')) return;

      const excludeFn = excludeFromPanRef.current;
      if (excludeFn && excludeFn(target)) return;

      const prev = cameraRef.current;
      const fitZoom = fitToScreenZoomRef.current;

      if (prev.z > fitZoom * 1.01) {
        e.preventDefault();
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        panStartCameraRef.current = { x: prev.x, y: prev.y };
        setIsPanning(true);
        if (containerRef.current) {
          containerRef.current.style.cursor = 'grabbing';
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current || !panStartRef.current || !panStartCameraRef.current) return;

      const deltaX = e.clientX - panStartRef.current.x;
      const deltaY = e.clientY - panStartRef.current.y;

      const { width: availableWidth, height: availableHeight } = getAvailableViewport();
      const cWidth = containerSizeRef.current.width + EMBED_PADDING;
      const cHeight = containerSizeRef.current.height + EMBED_PADDING;
      const prev = cameraRef.current;

      const newPanX = panStartCameraRef.current.x + deltaX / prev.z;
      const newPanY = panStartCameraRef.current.y + deltaY / prev.z;

      const maxPanX = Math.max(0, (cWidth * prev.z - availableWidth) / (2 * prev.z) + 50);
      const maxPanY = Math.max(0, (cHeight * prev.z - availableHeight) / (2 * prev.z) + 50);

      const newCam = {
        ...prev,
        x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
        y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
      };

      cameraRef.current = newCam;
      setCamera(newCam);
    };

    const handleMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        panStartRef.current = null;
        panStartCameraRef.current = null;
        setIsPanning(false);
        if (containerRef.current) {
          containerRef.current.style.cursor = '';
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        const fitZoom = fitToScreenZoomRef.current;
        const newCam = { x: 0, y: 0, z: fitZoom };
        cameraRef.current = newCam;
        setCamera(newCam);
      }
    };

    // Helper to get distance between two touch points
    const getTouchDistance = (touches: TouchList): number => {
      if (touches.length < 2) return 0;
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    // Helper to get center point between two touches
    const getTouchCenter = (touches: TouchList): { x: number; y: number } => {
      if (touches.length < 2) {
        return { x: touches[0].clientX, y: touches[0].clientY };
      }
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    };

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'BUTTON' || target.closest('button')) return;

      const excludeFn = excludeFromPanRef.current;
      if (excludeFn && excludeFn(target)) return;

      touchStartTimeRef.current = Date.now();

      if (e.touches.length === 2) {
        // Pinch gesture starting
        e.preventDefault();
        lastTouchDistanceRef.current = getTouchDistance(e.touches);
        lastTouchCenterRef.current = getTouchCenter(e.touches);
      } else if (e.touches.length === 1) {
        // Single finger - potential pan
        const prev = cameraRef.current;
        const fitZoom = fitToScreenZoomRef.current;

        if (prev.z > fitZoom * 1.01) {
          // Only start panning if zoomed in
          isPanningRef.current = true;
          panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          panStartCameraRef.current = { x: prev.x, y: prev.y };
          setIsPanning(true);
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const offset = viewportOffsetRef.current;
      const { width: availableWidth, height: availableHeight } = getAvailableViewport();
      const cWidth = containerSizeRef.current.width + EMBED_PADDING;
      const cHeight = containerSizeRef.current.height + EMBED_PADDING;
      const fitZoom = fitToScreenZoomRef.current;

      if (e.touches.length === 2) {
        // Pinch to zoom
        e.preventDefault();

        const currentDistance = getTouchDistance(e.touches);
        const currentCenter = getTouchCenter(e.touches);

        if (lastTouchDistanceRef.current !== null && lastTouchCenterRef.current !== null) {
          const prev = cameraRef.current;
          const scaleFactor = currentDistance / lastTouchDistanceRef.current;
          const newZoom = Math.max(fitZoom, Math.min(MAX_SCALE, prev.z * scaleFactor));

          let newCam: Camera;
          if (newZoom <= fitZoom * 1.01) {
            newCam = { x: 0, y: 0, z: fitZoom };
          } else {
            // Zoom toward the center point between fingers
            const scaledWidth = cWidth * prev.z;
            const scaledHeight = cHeight * prev.z;
            const baseOffsetX = offset.left + (availableWidth - scaledWidth) / 2;
            const baseOffsetY = offset.top + (availableHeight - scaledHeight) / 2;
            const offsetX = baseOffsetX + prev.x * prev.z;
            const offsetY = baseOffsetY + prev.y * prev.z;

            const localX = (currentCenter.x - offsetX) / prev.z;
            const localY = (currentCenter.y - offsetY) / prev.z;

            const newScaledWidth = cWidth * newZoom;
            const newScaledHeight = cHeight * newZoom;
            const newBaseOffsetX = offset.left + (availableWidth - newScaledWidth) / 2;
            const newBaseOffsetY = offset.top + (availableHeight - newScaledHeight) / 2;

            const targetOffsetX = currentCenter.x - localX * newZoom;
            const targetOffsetY = currentCenter.y - localY * newZoom;

            // Also handle pan from finger movement during pinch
            const panDeltaX = (currentCenter.x - lastTouchCenterRef.current.x) / newZoom;
            const panDeltaY = (currentCenter.y - lastTouchCenterRef.current.y) / newZoom;

            const newPanX = (targetOffsetX - newBaseOffsetX) / newZoom + panDeltaX;
            const newPanY = (targetOffsetY - newBaseOffsetY) / newZoom + panDeltaY;

            const maxPanX = Math.max(0, (cWidth * newZoom - availableWidth) / (2 * newZoom) + 50);
            const maxPanY = Math.max(0, (cHeight * newZoom - availableHeight) / (2 * newZoom) + 50);

            newCam = {
              x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
              y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
              z: newZoom,
            };
          }

          cameraRef.current = newCam;
          setCamera(newCam);
        }

        lastTouchDistanceRef.current = currentDistance;
        lastTouchCenterRef.current = currentCenter;
      } else if (
        e.touches.length === 1 &&
        isPanningRef.current &&
        panStartRef.current &&
        panStartCameraRef.current
      ) {
        // Single finger pan
        e.preventDefault();

        const deltaX = e.touches[0].clientX - panStartRef.current.x;
        const deltaY = e.touches[0].clientY - panStartRef.current.y;

        const prev = cameraRef.current;

        const newPanX = panStartCameraRef.current.x + deltaX / prev.z;
        const newPanY = panStartCameraRef.current.y + deltaY / prev.z;

        const maxPanX = Math.max(0, (cWidth * prev.z - availableWidth) / (2 * prev.z) + 50);
        const maxPanY = Math.max(0, (cHeight * prev.z - availableHeight) / (2 * prev.z) + 50);

        const newCam = {
          ...prev,
          x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
          y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
        };

        cameraRef.current = newCam;
        setCamera(newCam);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        lastTouchDistanceRef.current = null;
        lastTouchCenterRef.current = null;
      }

      if (e.touches.length === 0) {
        if (isPanningRef.current) {
          isPanningRef.current = false;
          panStartRef.current = null;
          panStartCameraRef.current = null;
          setIsPanning(false);
        }
      } else if (e.touches.length === 1) {
        // Transitioned from 2 fingers to 1 - start single finger pan from here
        const prev = cameraRef.current;
        const fitZoom = fitToScreenZoomRef.current;

        if (prev.z > fitZoom * 1.01) {
          isPanningRef.current = true;
          panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          panStartCameraRef.current = { x: prev.x, y: prev.y };
          setIsPanning(true);
        }
      }
    };

    document.addEventListener('wheel', handleWheel, { passive: false });
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('touchstart', handleTouchStart, { passive: false });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      document.removeEventListener('wheel', handleWheel);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [getAvailableViewport, containerRef]);

  // Zoom control functions for buttons
  const zoomIn = useCallback(() => {
    const { width: availableWidth, height: availableHeight } = getAvailableViewport();
    const offset = viewportOffsetRef.current;
    const cWidth = containerSizeRef.current.width + EMBED_PADDING;
    const cHeight = containerSizeRef.current.height + EMBED_PADDING;
    const viewportCenterX = offset.left + availableWidth / 2;
    const viewportCenterY = offset.top + availableHeight / 2;

    const prev = cameraRef.current;
    const newZoom = Math.min(MAX_SCALE, prev.z * 1.25);

    const scaledWidth = cWidth * prev.z;
    const scaledHeight = cHeight * prev.z;
    const baseOffsetX = offset.left + (availableWidth - scaledWidth) / 2;
    const baseOffsetY = offset.top + (availableHeight - scaledHeight) / 2;
    const offsetX = baseOffsetX + prev.x * prev.z;
    const offsetY = baseOffsetY + prev.y * prev.z;

    const localX = (viewportCenterX - offsetX) / prev.z;
    const localY = (viewportCenterY - offsetY) / prev.z;

    const newScaledWidth = cWidth * newZoom;
    const newScaledHeight = cHeight * newZoom;
    const newBaseOffsetX = offset.left + (availableWidth - newScaledWidth) / 2;
    const newBaseOffsetY = offset.top + (availableHeight - newScaledHeight) / 2;

    const targetOffsetX = viewportCenterX - localX * newZoom;
    const targetOffsetY = viewportCenterY - localY * newZoom;

    const newPanX = (targetOffsetX - newBaseOffsetX) / newZoom;
    const newPanY = (targetOffsetY - newBaseOffsetY) / newZoom;

    const maxPanX = Math.max(0, (cWidth * newZoom - availableWidth) / (2 * newZoom) + 50);
    const maxPanY = Math.max(0, (cHeight * newZoom - availableHeight) / (2 * newZoom) + 50);

    const newCam = {
      x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
      z: newZoom,
    };

    cameraRef.current = newCam;
    setCamera(newCam);
  }, [getAvailableViewport]);

  const zoomOut = useCallback(() => {
    const { width: availableWidth, height: availableHeight } = getAvailableViewport();
    const offset = viewportOffsetRef.current;
    const cWidth = containerSizeRef.current.width + EMBED_PADDING;
    const cHeight = containerSizeRef.current.height + EMBED_PADDING;
    const fitZoom = fitToScreenZoomRef.current;
    const viewportCenterX = offset.left + availableWidth / 2;
    const viewportCenterY = offset.top + availableHeight / 2;

    const prev = cameraRef.current;
    const newZoom = Math.max(fitZoom, prev.z / 1.25);

    if (newZoom <= fitZoom * 1.01) {
      const newCam = { x: 0, y: 0, z: fitZoom };
      cameraRef.current = newCam;
      setCamera(newCam);
      return;
    }

    const scaledWidth = cWidth * prev.z;
    const scaledHeight = cHeight * prev.z;
    const baseOffsetX = offset.left + (availableWidth - scaledWidth) / 2;
    const baseOffsetY = offset.top + (availableHeight - scaledHeight) / 2;
    const offsetX = baseOffsetX + prev.x * prev.z;
    const offsetY = baseOffsetY + prev.y * prev.z;

    const localX = (viewportCenterX - offsetX) / prev.z;
    const localY = (viewportCenterY - offsetY) / prev.z;

    const newScaledWidth = cWidth * newZoom;
    const newScaledHeight = cHeight * newZoom;
    const newBaseOffsetX = offset.left + (availableWidth - newScaledWidth) / 2;
    const newBaseOffsetY = offset.top + (availableHeight - newScaledHeight) / 2;

    const targetOffsetX = viewportCenterX - localX * newZoom;
    const targetOffsetY = viewportCenterY - localY * newZoom;

    const newPanX = (targetOffsetX - newBaseOffsetX) / newZoom;
    const newPanY = (targetOffsetY - newBaseOffsetY) / newZoom;

    const maxPanX = Math.max(0, (cWidth * newZoom - availableWidth) / (2 * newZoom) + 50);
    const maxPanY = Math.max(0, (cHeight * newZoom - availableHeight) / (2 * newZoom) + 50);

    const newCam = {
      x: Math.max(-maxPanX, Math.min(maxPanX, newPanX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, newPanY)),
      z: newZoom,
    };

    cameraRef.current = newCam;
    setCamera(newCam);
  }, [getAvailableViewport]);

  const zoomToFit = useCallback(() => {
    const fitZoom = fitToScreenZoomRef.current;
    const newCam = { x: 0, y: 0, z: fitZoom };
    cameraRef.current = newCam;
    setCamera(newCam);
  }, []);

  const isZoomedIn = camera.z > fitToScreenZoom * 1.01;

  return {
    camera,
    setCamera,
    fitToScreenZoom,
    isPanning,
    isZoomedIn,
    getTransformPosition,
    zoomIn,
    zoomOut,
    zoomToFit,
    contentWidth,
    contentHeight,
  };
}
