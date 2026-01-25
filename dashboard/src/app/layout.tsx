import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Link from 'next/link'
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
  UserButton,
} from '@clerk/nextjs'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Log Dashboard',
  description: 'Self-hosted log aggregation dashboard',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={inter.className}>
          <div className="min-h-screen bg-gray-900">
            <nav className="bg-gray-800 border-b border-gray-700">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                  <div className="flex items-center">
                    <span className="text-white font-bold text-xl">Log Dashboard</span>
                    <div className="ml-10 flex items-baseline space-x-4">
                      <Link href="/" className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium">
                        Log Explorer
                      </Link>
                      <Link href="/services" className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium">
                        Services
                      </Link>
                      <Link href="/live" className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium">
                        Live Tail
                      </Link>
                      <Link href="/keys" className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium">
                        API Keys
                      </Link>
                    </div>
                  </div>
                  <div className="flex items-center space-x-4">
                    <SignedOut>
                      <SignInButton mode="modal">
                        <button className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium">
                          Sign In
                        </button>
                      </SignInButton>
                      <SignUpButton mode="modal">
                        <button className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-md text-sm font-medium">
                          Sign Up
                        </button>
                      </SignUpButton>
                    </SignedOut>
                    <SignedIn>
                      <UserButton
                        appearance={{
                          elements: {
                            avatarBox: 'w-8 h-8'
                          }
                        }}
                      />
                    </SignedIn>
                  </div>
                </div>
              </div>
            </nav>
            <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
              {children}
            </main>
          </div>
        </body>
      </html>
    </ClerkProvider>
  )
}
