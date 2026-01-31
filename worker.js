export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // ---- CORS headers ----
    const corsHeaders = {
      "Access-Control-Allow-Origin": `chrome-extension://${env.EXTENSION_ID}`,
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

        const isValidRedirect = 
          redirect_uri.startsWith(`https://${env.EXTENSION_ID}.chromiumapp.org/`) ||
          redirect_uri.startsWith(`chrome-extension://${env.EXTENSION_ID}`)

        if (!isValidRedirect) {
          console.error("Invalid redirect URI:", redirect_uri)
          console.error("Expected to start with:", `https://${env.EXTENSION_ID}.chromiumapp.org/`)
          return jsonError("Invalid redirect URI", 400, "invalid_redirect", corsHeaders)
        }


        if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
          console.error("Missing required environment variables")
          return jsonError("Server configuration error", 500, "error", corsHeaders)
        }

        const postData = {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri
        }

        console.log("Sending to GitHub:", {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: "***hidden***",
          code: code.substring(0, 2) + "...",
          redirect_uri
        })

        const githubRes = await fetch(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "User-Agent": "Chrome-Extension-OAuth-App"
            },
            body: JSON.stringify(postData)
          }
        )

        const result = await githubRes.json()

        if (result.error) {
          console.error("GitHub OAuth error:", result)
          return jsonError(
            result.error_description || "OAuth exchange failed",
            400,
            result.error,
            corsHeaders
          )
        }

        if (!result.access_token) {
          console.error("No access token in response:", result)
          return jsonError("No access token received from GitHub", 400, "no_token", corsHeaders)
        }

        return new Response(
          JSON.stringify({
            access_token: result.access_token,
            token_type: result.token_type || "bearer",
            scope: result.scope,
            expires_in: result.expires_in
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      } catch (err) {
        console.error("Unhandled error:", err)
        return jsonError(
          "Failed to exchange authorization code for token",
          500,
          "server_error",
          corsHeaders
        )
      }
    }

    // ---- Not found ----
    return new Response("Not Found", { status: 404 })
  }
}

function jsonError(message, status = 500, error = "error", corsHeaders = {}) {
  return new Response(
    JSON.stringify({ error, message }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      }
    }
  )
}