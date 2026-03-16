'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import {
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
  UserButton,
} from '@clerk/nextjs'
import { MobileNav } from './MobileNav'

interface NavLink {
  href: string
  label: string
}

interface NavDropdownItem {
  label: string
  children: NavLink[]
}

type NavItem = NavLink | NavDropdownItem

function isDropdown(item: NavItem): item is NavDropdownItem {
  return 'children' in item
}

const navItems: NavItem[] = [
  { href: '/logs', label: 'Log Explorer' },
  { href: '/services', label: 'Services' },
  { href: '/dashboards', label: 'Dashboards' },
  { href: '/live', label: 'Live Tail' },
  {
    label: 'Alerts',
    children: [
      { href: '/alerts', label: 'Alert Rules' },
      { href: '/destinations', label: 'Destinations' },
    ],
  },
  {
    label: 'Tools',
    children: [
      { href: '/queries', label: 'Saved Queries' },
      { href: '/endpoints', label: 'Endpoints' },
    ],
  },
  {
    label: 'Integrations',
    children: [
      { href: '/integrations', label: 'Setup Guides' },
      { href: '/keys', label: 'API Keys' },
      { href: '/llms.txt', label: 'LLMs.txt' },
      { href: '/mcp-setup', label: 'MCP' },
    ],
  },
  { href: '/system', label: 'System' },
  { href: '/backups', label: 'Backups' },
]

function NavDropdown({ item, pathname }: { item: NavDropdownItem; pathname: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const isChildActive = item.children.some((child) => pathname === child.href)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // Close on route change
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`
          relative flex items-center gap-1 px-4 py-2 rounded-md text-sm font-medium transition-all duration-200
          ${isChildActive
            ? 'text-white'
            : 'text-gray-400 hover:text-white hover:bg-cannon-steel'
          }
        `}
      >
        {item.label}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        {isChildActive && (
          <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-cannon-fire rounded-full" />
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[180px] py-1 bg-cannon-charcoal border border-cannon-graphite rounded-lg shadow-xl">
          {item.children.map((child) => {
            const isActive = pathname === child.href
            return (
              <Link
                key={child.href}
                href={child.href}
                className={`
                  block px-4 py-2 text-sm transition-colors
                  ${isActive
                    ? 'text-cannon-fire bg-cannon-fire/10'
                    : 'text-gray-300 hover:text-white hover:bg-cannon-steel'
                  }
                `}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Navigation() {
  const pathname = usePathname()

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 nav-blur border-b border-cannon-graphite safe-top">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-8 h-8 relative">
                <svg viewBox="0 0 64 64" fill="none" className="w-full h-full">
                  <circle cx="32" cy="32" r="30" fill="#0A0A0B"/>
                  <rect x="12" y="24" width="24" height="16" rx="3" fill="#FF4D2A" className="group-hover:fill-cannon-ember transition-colors"/>
                  <circle cx="20" cy="40" r="7" fill="#141416" stroke="#FF4D2A" strokeWidth="2.5" className="group-hover:stroke-cannon-ember transition-colors"/>
                  <circle cx="20" cy="40" r="2" fill="#FF4D2A"/>
                  <rect x="40" y="26" width="14" height="4" rx="2" fill="#FF4D2A" opacity="0.9"/>
                  <rect x="44" y="32" width="12" height="4" rx="2" fill="#FF6B47" opacity="0.7"/>
                  <rect x="40" y="38" width="10" height="4" rx="2" fill="#FF8A65" opacity="0.5"/>
                </svg>
              </div>
              <span className="font-mono font-bold text-lg text-white tracking-tight hidden sm:block">
                LOG <span className="text-cannon-fire">CANNON</span>
              </span>
            </Link>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              if (isDropdown(item)) {
                return <NavDropdown key={item.label} item={item} pathname={pathname} />
              }
              const isActive = pathname === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    relative px-4 py-2 rounded-md text-sm font-medium transition-all duration-200
                    ${isActive
                      ? 'text-white'
                      : 'text-gray-400 hover:text-white hover:bg-cannon-steel'
                    }
                  `}
                >
                  {item.label}
                  {isActive && (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-cannon-fire rounded-full" />
                  )}
                  {item.href === '/live' && (
                    <span className="ml-2 inline-flex items-center">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cannon-tracer opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-cannon-tracer"></span>
                      </span>
                    </span>
                  )}
                </Link>
              )
            })}
          </div>

          {/* Right side - Auth + Mobile menu */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-3">
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="btn-cannon-ghost text-sm">
                    Sign In
                  </button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="btn-cannon text-sm">
                    Sign Up
                  </button>
                </SignUpButton>
              </SignedOut>
              <SignedIn>
                <UserButton
                  appearance={{
                    elements: {
                      avatarBox: 'w-8 h-8 ring-2 ring-cannon-graphite hover:ring-cannon-fire transition-all'
                    }
                  }}
                />
              </SignedIn>
            </div>

            {/* Mobile Menu Trigger */}
            <MobileNav currentPath={pathname} />
          </div>
        </div>
      </div>
    </nav>
  )
}
