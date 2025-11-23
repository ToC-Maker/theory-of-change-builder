import { useState, useEffect, useCallback } from 'react'
import { Tooltip } from 'react-tooltip'

export function GraphTutorial() {
  const [isVisible, setIsVisible] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null)
  const [targetNode, setTargetNode] = useState<HTMLElement | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  const tutorialSteps = [
    { text: "Click to see connections" },
    { text: "Click the details button" },
    { text: "Click to see connection details" }
  ]

  const handleClose = useCallback(() => {
    setIsVisible(false)
    localStorage.setItem('graph-tutorial-seen', 'true')

    // Clean up hover state
    if (targetNode) {
      const mouseLeaveEvent = new MouseEvent('mouseleave', { bubbles: true })
      targetNode.dispatchEvent(mouseLeaveEvent)
    }
  }, [targetNode])

  const handleGlobalClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement

    if (currentStep === 0) {
      // Check if clicked on the target node
      if (targetNode && (target === targetNode || targetNode.contains(target))) {
        // Don't prevent default - let the node selection happen
        setCurrentStep(1)
      }
    } else if (currentStep === 1) {
      // Check if clicked on the info button
      if (targetNode) {
        const infoButton = targetNode.querySelector('button')
        if (infoButton && (target === infoButton || infoButton.contains(target))) {
          // Don't prevent default - let the info popup show
          // Wait a moment for the modal to open
          setTimeout(() => {
            setIsModalOpen(true)
          }, 100)

          // Wait for the popup to close before moving to step 2
          let modalWasOpen = false
          const checkForPopupClose = setInterval(() => {
            // Check if NodePopup backdrop is visible
            // The backdrop has z-index 200 and bg-opacity-40
            const backdrop = document.querySelector('[class*="backdrop-blur"]')
            const hasBackdrop = backdrop && window.getComputedStyle(backdrop).display !== 'none'

            console.log('Checking for popup close, backdrop found:', !!hasBackdrop, 'modalWasOpen:', modalWasOpen)

            if (hasBackdrop) {
              modalWasOpen = true
            }

            // Only advance when modal was open and is now closed
            if (modalWasOpen && !hasBackdrop) {
              clearInterval(checkForPopupClose)
              setIsModalOpen(false)
              setCurrentStep(2)
            }
          }, 300)

          // Timeout after 30 seconds to prevent infinite waiting
          setTimeout(() => {
            clearInterval(checkForPopupClose)
            if (currentStep === 1) {
              setIsModalOpen(false)
              setCurrentStep(2)
            }
          }, 30000)
        }
      }
    } else if (currentStep === 2) {
      // Check if clicked on an SVG path (edge)
      const svg = document.querySelector('svg')
      if (svg) {
        // Check if the click was on a path element
        let element: HTMLElement | null = target
        while (element && element !== svg) {
          if (element.tagName === 'path') {
            // Don't prevent default - let the edge popup show
            handleClose()
            return
          }
          element = element.parentElement
        }
      }
    }
  }, [currentStep, targetNode, handleClose])

  useEffect(() => {
    // Check if user has seen the tutorial before
    const hasSeenTutorial = localStorage.getItem('graph-tutorial-seen')
    if (!hasSeenTutorial) {
      // Show tutorial after a delay to let the graph render
      const timer = setTimeout(() => {
        setIsVisible(true)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (isVisible) {
      updateTooltipPosition()
      // Add global click listener
      document.addEventListener('click', handleGlobalClick, true)

      // Add position tracking for step 1 (when tooltip is on the info button)
      let positionUpdateInterval: NodeJS.Timeout | null = null
      if (currentStep === 1) {
        positionUpdateInterval = setInterval(() => {
          updateTooltipPosition()
        }, 100) // Update position every 100ms
      }

      // Also update on scroll/resize
      window.addEventListener('scroll', updateTooltipPosition, true)
      window.addEventListener('resize', updateTooltipPosition)

      return () => {
        document.removeEventListener('click', handleGlobalClick, true)
        window.removeEventListener('scroll', updateTooltipPosition, true)
        window.removeEventListener('resize', updateTooltipPosition)
        if (positionUpdateInterval) {
          clearInterval(positionUpdateInterval)
        }
      }
    }
  }, [currentStep, isVisible, targetNode, handleGlobalClick])

  const updateTooltipPosition = () => {
    if (currentStep === 0) {
      // Step 1: Find a random node
      const nodes = document.querySelectorAll('[id^="node-"]')
      if (nodes.length === 0) return

      const targetIndex = Math.floor(Math.random() * nodes.length)
      const node = nodes[targetIndex] as HTMLElement
      const rect = node.getBoundingClientRect()

      setTargetNode(node)
      setTooltipPosition({
        x: rect.left + rect.width / 2,
        y: rect.top
      })
    } else if (currentStep === 1) {
      // Step 2: Point to the info button
      if (!targetNode) return

      // Simulate hover to show the info button
      const mouseEnterEvent = new MouseEvent('mouseenter', { bubbles: true })
      targetNode.dispatchEvent(mouseEnterEvent)

      // Find and position directly on the info button
      const infoButton = targetNode.querySelector('button')
      if (infoButton) {
        const rect = infoButton.getBoundingClientRect()
        setTooltipPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        })
      } else {
        // Fallback to top-right of node
        const rect = targetNode.getBoundingClientRect()
        setTooltipPosition({
          x: rect.right - 20,
          y: rect.top + 20
        })
      }
    } else if (currentStep === 2) {
      // Step 3: Find an edge/connection
      // Find all SVG elements and look for the one with connection paths
      const allSvgs = document.querySelectorAll('svg')
      console.log('Total SVGs found:', allSvgs.length)

      let svg: SVGSVGElement | null = null
      let maxPaths = 0

      // Find the SVG with the most paths (that's the connections SVG)
      allSvgs.forEach((svgElement, index) => {
        const pathCount = svgElement.querySelectorAll('path[d]').length
        console.log(`SVG ${index}: ${pathCount} paths`)
        if (pathCount > maxPaths) {
          maxPaths = pathCount
          svg = svgElement
        }
      })

      if (!svg) {
        console.log('No SVG with paths found')
        return
      }

      const paths = svg.querySelectorAll('path[d]')
      console.log('Selected SVG has', paths.length, 'paths')

      if (paths.length === 0) return

      // Find a visible connection path
      // Based on the HTML structure, we want paths with stroke-width around 3px
      let targetPath: SVGPathElement | null = null
      const visiblePaths: SVGPathElement[] = []

      for (let i = 0; i < paths.length; i++) {
        const path = paths[i] as SVGPathElement

        // Skip marker paths
        if (path.closest('marker')) continue

        const style = window.getComputedStyle(path)
        const stroke = style.stroke
        const strokeWidth = parseFloat(style.strokeWidth)

        console.log(`Path ${i}: stroke=${stroke}, strokeWidth=${strokeWidth}`)

        // Look for visible connection lines (stroke-width around 3px, not transparent)
        if (stroke && stroke !== 'transparent' && strokeWidth >= 2 && strokeWidth <= 4) {
          visiblePaths.push(path)
          console.log(`Found visible path ${visiblePaths.length}`)
        }
      }

      // Pick a random visible path
      if (visiblePaths.length > 0) {
        const randomIndex = Math.floor(Math.random() * visiblePaths.length)
        targetPath = visiblePaths[randomIndex]
        console.log(`Selected random path ${randomIndex + 1} of ${visiblePaths.length}`)
      }

      if (!targetPath) {
        console.log('No target path found')
        return
      }

      // Get the actual midpoint of the path curve
      const pathLength = targetPath.getTotalLength()
      const midPoint = targetPath.getPointAtLength(pathLength / 2)

      console.log('Path midpoint (SVG coords):', midPoint.x, midPoint.y)

      // Convert SVG coordinates to screen coordinates using getScreenCTM
      const svgPoint = svg.createSVGPoint()
      svgPoint.x = midPoint.x
      svgPoint.y = midPoint.y
      const screenCTM = svg.getScreenCTM()

      if (screenCTM) {
        const screenPoint = svgPoint.matrixTransform(screenCTM)
        console.log('Screen point:', screenPoint.x, screenPoint.y)
        setTooltipPosition({
          x: screenPoint.x,
          y: screenPoint.y
        })
      }
    }
  }

  if (!isVisible || !tooltipPosition) return null

  // Hide tooltip while modal is open during step 1
  const shouldShowTooltip = !(currentStep === 1 && isModalOpen)

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
        isOpen={isVisible && shouldShowTooltip}
        clickable
        className="!max-w-[100px] !text-[8px] !px-1.5 !py-0.5 sm:!max-w-[140px] sm:!text-xs sm:!px-3 sm:!py-1.5 md:!max-w-[160px] md:!text-sm md:!px-3 md:!py-2"
        style={{ zIndex: 9999 }}
      >
        <div className="text-center">{tutorialSteps[currentStep].text}</div>
      </Tooltip>
    </>
  )
}