import { useState, useEffect } from 'react'
import { XMarkIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'

interface TutorialStep {
  title: string
  description: string
  gifSrc: string
}

export function GraphTutorial() {
  const [isVisible, setIsVisible] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)

  const tutorialSteps: TutorialStep[] = [
    {
      title: "Click on a node",
      description: "Click any node to highlight it and see its connections",
      gifSrc: "/tutorial/node-click.gif"
    },
    {
      title: "Click the info button",
      description: "Click on the info button to see detailed node information",
      gifSrc: "/tutorial/info-button.gif"
    },
    {
      title: "Click on an edge",
      description: "Click on connection lines to see edge details",
      gifSrc: "/tutorial/edge-click.gif"
    }
  ]

  useEffect(() => {
    // Check if user has seen the tutorial before
    const hasSeenTutorial = localStorage.getItem('graph-tutorial-seen')
    if (!hasSeenTutorial) {
      // Show tutorial after a brief delay
      const timer = setTimeout(() => {
        setIsVisible(true)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  const handleClose = () => {
    setIsVisible(false)
    localStorage.setItem('graph-tutorial-seen', 'true')
  }

  const nextStep = () => {
    if (currentStep < tutorialSteps.length - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      setIsVisible(false)
      localStorage.setItem('graph-tutorial-seen', 'true')
    }
  }

  const prevStep = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  if (!isVisible) return null

  const step = tutorialSteps[currentStep]

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl mx-4 p-12">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-gray-900">How to Use This Graph</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="mb-8">
          {/* GIF container */}
          <div className="bg-gray-100 rounded-lg h-96 flex items-center justify-center mb-6 overflow-hidden">
            <img
              src={step.gifSrc}
              alt={step.title}
              className="max-w-full max-h-full rounded-lg object-contain"
              onError={(e) => {
                // Fallback if GIF doesn't exist
                e.currentTarget.style.display = 'none'
                const fallback = e.currentTarget.nextElementSibling as HTMLElement
                if (fallback) fallback.style.display = 'flex'
              }}
            />
            <div className="text-gray-500 text-center hidden flex-col">
              <div className="text-4xl mb-2">🎬</div>
              <div>Tutorial: {step.title}</div>
            </div>
          </div>

          <h3 className="text-2xl font-semibold text-gray-900 mb-4">{step.title}</h3>
          <p className="text-lg text-gray-600">{step.description}</p>
        </div>

        <div className="flex justify-between items-center">
          <button
            onClick={prevStep}
            disabled={currentStep === 0}
            className="flex items-center space-x-1 px-4 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeftIcon className="h-4 w-4" />
            <span>Previous</span>
          </button>

          <div className="flex space-x-2">
            {tutorialSteps.map((_, index) => (
              <div
                key={index}
                className={`w-2 h-2 rounded-full transition-colors ${
                  index === currentStep ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              />
            ))}
          </div>

          <button
            onClick={nextStep}
            className="flex items-center space-x-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <span>{currentStep === tutorialSteps.length - 1 ? 'Got it!' : 'Next'}</span>
            {currentStep < tutorialSteps.length - 1 && <ChevronRightIcon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}