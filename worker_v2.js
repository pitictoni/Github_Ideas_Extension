export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // Parse extension IDs
    const extensionIds = env.EXTENSION_IDS.split(",").map(id => id.trim())

    // Get Origin header from request
    const requestOrigin = request.headers.get("Origin")

    // Check if request comes from an allowed extension
    const isAllowedOrigin = extensionIds.some(id =>
      requestOrigin === `chrome-extension://${id}`
    )

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowedOrigin ? requestOrigin : "",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true"
    }

    // ---- Preflight ----
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // ---- Health check ----
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString()
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // ---- GitHub token exchange ----
    if (url.pathname === "/api/github/token" && request.method === "POST") {
      try {
        const body = await request.json()
        const { code, redirect_uri } = body

        if (!code) {
          return jsonError("Authorization code is required", 400, "error", corsHeaders)
        }

        if (!redirect_uri) {
          return jsonError("Redirect URI is required", 400, "error", corsHeaders)
        }

        // Validate redirect against ALL extension IDs
        const isValidRedirect = extensionIds.some(id =>
          redirect_uri.startsWith(`https://${id}.chromiumapp.org/`) ||
          redirect_uri.startsWith(`chrome-extension://${id}`)
        )

        if (!isValidRedirect) {
          return jsonError("Invalid redirect URI", 400, "invalid_redirect", corsHeaders)
        }

        if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
          return jsonError("Server configuration error", 500, "error", corsHeaders)
        }

        const githubRes = await fetch(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json"
            },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code,
              redirect_uri
            })
          }
        )

        const result = await githubRes.json()

        if (result.error) {
          return jsonError(
            result.error_description || "OAuth exchange failed",
            400,
            result.error,
            corsHeaders
          )
        }

        return new Response(
          JSON.stringify(result),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )

      } catch (err) {
        return jsonError(
          "Failed to exchange authorization code for token",
          500,
          "server_error",
          corsHeaders
        )
      }
    }

    return new Response("Not Found", { status: 404 })
  }
}