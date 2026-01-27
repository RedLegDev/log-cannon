'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu, X, Search, Server, Radio, Key, Bookmark, Zap, LayoutDashboard } from 'lucide-react'
import {
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
  UserButton,
} from '@clerk/nextjs'

const navLinks = [
  { href: '/', label: 'Log Explorer', icon: Search },
  { href: '/services', label: 'Services', icon: Server },
  { href: '/dashboards', label: 'Dashboards', icon: LayoutDashboard },
  { href: '/live', label: 'Live Tail', icon: Radio },
  { href: '/queries', label: 'Saved Queries', icon: Bookmark },
  { href: '/endpoints', label: 'Endpoints', icon: Zap },
  { href: '/keys', label: 'API Keys', icon: Key },
]

interface MobileNavProps {
  currentPath: string
}

export function MobileNav({ currentPath }: MobileNavProps) {
  const [isOpen, setIsOpen] = useState(false)

  // Close menu on route change
  useEffect(() => {
    setIsOpen(false)
  }, [currentPath])

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  return (
    <div className="md:hidden">
      {/* Hamburger Button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 rounded-md text-gray-400 hover:text-white hover:bg-cannon-steel transition-colors touch-target"
        aria-label="Open menu"
      >
        <Menu className="w-6 h-6" />
      </button>

      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-fade-in"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Drawer */}
      <div
        className={`
          fixed top-0 left-0 bottom-0 w-72 bg-cannon-charcoal z-50
          transform transition-transform duration-300 ease-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          border-r border-cannon-graphite
          safe-top safe-bottom
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-cannon-graphite">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8">
              <svg viewBox="0 0 64 64" fill="none" className="w-full h-full">
                <circle cx="32" cy="32" r="30" fill="#0A0A0B"/>
                <rect x="12" y="24" width="24" height="16" rx="3" fill="#FF4D2A"/>
                <circle cx="20" cy="40" r="7" fill="#141416" stroke="#FF4D2A" strokeWidth="2.5"/>
                <circle cx="20" cy="40" r="2" fill="#FF4D2A"/>
                <rect x="40" y="26" width="14" height="4" rx="2" fill="#FF4D2A" opacity="0.9"/>
                <rect x="44" y="32" width="12" height="4" rx="2" fill="#FF6B47" opacity="0.7"/>
                <rect x="40" y="38" width="10" height="4" rx="2" fill="#FF8A65" opacity="0.5"/>
              </svg>
            </div>
            <span className="font-mono font-bold text-white">
              LOG <span className="text-cannon-fire">CANNON</span>
            </span>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 rounded-md text-gray-400 hover:text-white hover:bg-cannon-steel transition-colors"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="p-4 space-y-2">
          {navLinks.map((link) => {
            const isActive = currentPath === link.href
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setIsOpen(false)}
                className={`
                  flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-all
                  touch-target
                  ${isActive
                    ? 'bg-cannon-fire/10 text-cannon-fire border-l-2 border-cannon-fire'
                    : 'text-gray-300 hover:bg-cannon-steel hover:text-white'
                  }
                `}
              >
                <Icon className="w-5 h-5" />
                <span>{link.label}</span>
                {link.href === '/live' && (
                  <span className="ml-auto relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cannon-tracer opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-cannon-tracer"></span>
                  </span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Auth Section */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-cannon-graphite bg-cannon-charcoal safe-bottom">
          <SignedOut>
            <div className="flex flex-col gap-2">
              <SignInButton mode="modal">
                <button className="w-full btn-cannon-secondary text-sm py-3">
                  Sign In
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="w-full btn-cannon text-sm py-3">
                  Sign Up
                </button>
              </SignUpButton>
            </div>
          </SignedOut>
          <SignedIn>
            <div className="flex items-center gap-3 px-2">
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: 'w-10 h-10 ring-2 ring-cannon-graphite'
                  }
                }}
              />
              <span className="text-sm text-gray-400">Account Settings</span>
            </div>
          </SignedIn>
        </div>
      </div>
    </div>
  )
}
