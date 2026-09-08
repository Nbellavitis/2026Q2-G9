import type { NextConfig } from 'next'

/**
 * The app ships as a pure static SPA: `next build` writes `out/`, which is served straight from an
 * S3 bucket with no server and no idle compute.
 *
 * Every id travels in the query string - `/q/?id={queueId}`, `/t/?token={ticketToken}`, and the
 * staff pages under `/panel`. A path segment would read better on the printed QR poster, but a
 * static export cannot pre-render those ids, so each shell would need a rewrite rule in whatever
 * serves the site. Only a CDN can express that; plain static hosting on S3 cannot, and this
 * deployment has no CDN available. The query string costs nothing and keeps the hosting
 * configuration down to zero rules.
 */
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
}

export default nextConfig
