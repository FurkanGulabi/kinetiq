import type { NextConfig } from 'next';

// Kinetiq runs through a custom server (server.ts). Do NOT enable `output: 'standalone'`:
// it does not trace the custom server or the embedded CNCjs backend.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
