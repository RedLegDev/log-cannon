'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@clerk/nextjs'
import { SignInButton } from '@clerk/nextjs'
import { LogIn, Loader2 } from 'lucide-react'

interface AuthGateProps {
  children: React.ReactNode
  hasServerData?: boolean
}

export function AuthGate({ children, hasServerData = true }: AuthGateProps) {
  const { isLoaded, isSignedIn } = useAuth()
  const hasRefreshed = useRef(false)

  // If client-side auth succeeds but server didn't fetch data, refresh to get it
  useEffect(() => {
    if (isLoaded && isSignedIn && !hasServerData && !hasRefreshed.current) {
      hasRefreshed.current = true
      window.location.reload()
    }
  }, [isLoaded, isSignedIn, hasServerData])

  // Show loading state while Clerk initializes
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-cannon-fire animate-spin" />
      </div>
    )
  }

  // Show sign-in prompt if not authenticated
  if (!isSignedIn) {
    return (
      <div className="animate-fade-in">
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
          <div className="card-cannon p-8 max-w-md">
            <LogIn className="w-12 h-12 text-cannon-fire mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-text-primary font-mono mb-2">
              Sign In Required
            </h1>
            <p className="text-text-secondary mb-6">
              Please sign in to access the Log Explorer.
            </p>
            <SignInButton mode="modal">
              <button className="btn-cannon w-full">
                Sign In
              </button>
            </SignInButton>
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
