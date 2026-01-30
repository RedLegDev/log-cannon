/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        cannon: {
          black: '#0A0A0B',
          charcoal: '#141416',
          steel: '#1E1E22',
          graphite: '#2A2A2F',
          slate: '#3A3A42',
          fire: '#FF4D2A',
          ember: '#FF6B47',
          glow: '#FF8A65',
          tracer: '#00D4AA',
          warning: '#FFB020',
          critical: '#FF3366',
          success: '#22C55E',
        },
        text: {
          primary: '#F9FAFB',
          secondary: '#9CA3AF',
          muted: '#6B7280',
          code: '#E5E7EB',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flash': 'flash 500ms ease-out',
        'slide-down': 'slideDown 200ms ease-out',
        'slide-in-left': 'slideInLeft 300ms ease-out',
        'fade-in': 'fadeIn 200ms ease-out',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
      },
      keyframes: {
        flash: {
          '0%': { backgroundColor: 'rgba(255, 77, 42, 0.3)' },
          '100%': { backgroundColor: 'transparent' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-100%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(255, 77, 42, 0.3)' },
          '50%': { boxShadow: '0 0 30px rgba(255, 77, 42, 0.5)' },
        },
      },
      boxShadow: {
        'cannon': '0 4px 20px rgba(0, 0, 0, 0.5)',
        'cannon-lg': '0 8px 40px rgba(0, 0, 0, 0.6)',
        'fire': '0 0 20px rgba(255, 77, 42, 0.3)',
        'fire-lg': '0 0 40px rgba(255, 77, 42, 0.4)',
      },
      backdropBlur: {
        'xs': '2px',
      },
    },
  },
  plugins: [],
}
