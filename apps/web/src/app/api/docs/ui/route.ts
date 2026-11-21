import { NextResponse } from 'next/server'

/**
 * GET /api/docs/ui
 * Serves an interactive Swagger UI backed by /api/docs (openapi.yaml).
 *
 * The playground is enabled in staging and non-production environments.
 * In production it is hidden (404) unless ALLOW_API_PLAYGROUND is set.
 */
export async function GET() {
  const isProduction =
    process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  const allowPlayground = process.env.ALLOW_API_PLAYGROUND === 'true'

  if (isProduction && !allowPlayground) {
    return new NextResponse('Not Found', { status: 404 })
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SolarProof API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      tryItOutEnabled: true,
      supportedSubmitMethods: ['get', 'post', 'put', 'patch', 'delete'],
    })
  </script>
</body>
</html>`

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}