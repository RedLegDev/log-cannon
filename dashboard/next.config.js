/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['recharts', 'recharts-scale', 'd3-scale', 'd3-shape'],
}

module.exports = nextConfig
