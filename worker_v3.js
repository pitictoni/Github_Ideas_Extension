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

    // Results endpoints are called by you directly (curl/Postman), not the extension
    const isResultsRoute = url.pathname.startsWith("/api/benchmark/results") ||
      url.pathname.startsWith("/api/benchmark/raw")

    const corsHeaders = {
      "Access-Control-Allow-Origin": isResultsRoute ? "*" : (isAllowedOrigin ? requestOrigin : ""),
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": isResultsRoute ? "false" : "true"
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

    // ---- Benchmark: receive a completed run from the extension ----
    if (url.pathname === "/api/benchmark" && request.method === "POST") {
      return handleBenchmark(request, env, corsHeaders)
    }

    // ---- Benchmark: aggregated results per task/platform ----
    // Protected by RESULTS_SECRET env var: ?secret=YOUR_SECRET
    if (url.pathname === "/api/benchmark/results" && request.method === "GET") {
      return handleBenchmarkResults(request, env, corsHeaders)
    }

    // ---- Benchmark: raw log export for statistical analysis ----
    // Protected by RESULTS_SECRET env var: ?secret=YOUR_SECRET
    if (url.pathname === "/api/benchmark/raw" && request.method === "GET") {
      return handleBenchmarkRaw(request, env, corsHeaders)
    }

    return new Response("Not Found", { status: 404 })
  }
}

// ============================================================================
// POST /api/benchmark
// Receives a single completed benchmark run from the extension
// ============================================================================

async function handleBenchmark(request, env, corsHeaders) {
  let body

  try {
    body = await request.json()
  } catch {
    return jsonError("Invalid JSON", 400, "invalid_json", corsHeaders)
  }

  const { id, participantId, task, platform, clickCount, durationMs, success } = body

  // Validate required fields
  if (!id || !participantId || !task || !platform) {
    return jsonError(
      "Missing required fields: id, participantId, task, platform",
      400,
      "missing_fields",
      corsHeaders
    )
  }

  if (!["extension", "web"].includes(platform)) {
    return jsonError(
      'platform must be "extension" or "web"',
      400,
      "invalid_platform",
      corsHeaders
    )
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(participantId)) {
    return jsonError("Invalid participantId format", 400, "invalid_participant", corsHeaders)
  }

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO benchmark_logs (
        id, participant_id, task, platform,
        click_count, raw_click_count, duration_ms,
        success, cancelled, cancel_reason,
        input_fields, steps,
        started_at, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      participantId,
      task,
      platform,
      clickCount ?? null,
      body.rawClickCount ?? null,
      durationMs ?? null,
      success ? 1 : 0,
      body.cancelled ? 1 : 0,
      body.cancelReason ?? null,
      JSON.stringify(body.inputFields ?? []),
      JSON.stringify(body.steps ?? []),
      body.startedAt ?? null,
      body.completedAt ?? null,
      Date.now()
    ).run()

    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error("D1 insert error:", err)
    return jsonError("Database error", 500, "db_error", corsHeaders)
  }
}

// ============================================================================
// GET /api/benchmark/results?secret=X&task=Y
// Aggregated stats — avg clicks & time per task per platform
// ============================================================================

async function handleBenchmarkResults(request, env, corsHeaders) {
  const url = new URL(request.url)

  const secret = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (env.RESULTS_SECRET && secret !== env.RESULTS_SECRET) {
    return jsonError("Unauthorized", 401, "unauthorized", corsHeaders)
  }

  const taskFilter = url.searchParams.get("task")

  try {
    let query = `
      SELECT
        task,
        platform,
        COUNT(*)                        AS total_runs,
        COUNT(DISTINCT participant_id)  AS unique_participants,
        ROUND(AVG(click_count), 2)      AS avg_clicks,
        ROUND(MIN(click_count), 2)      AS min_clicks,
        ROUND(MAX(click_count), 2)      AS max_clicks,
        ROUND(AVG(duration_ms), 0)      AS avg_duration_ms,
        ROUND(MIN(duration_ms), 0)      AS min_duration_ms,
        ROUND(MAX(duration_ms), 0)      AS max_duration_ms
      FROM benchmark_logs
      WHERE success = 1
    `

    const params = []
    if (taskFilter) {
      query += ` AND task = ?`
      params.push(taskFilter)
    }

    query += ` GROUP BY task, platform ORDER BY task, platform`

    const { results: aggregated } = await env.DB.prepare(query).bind(...params).all()

    // Per-participant breakdown for variance/significance testing
    let perParticipantQuery = `
      SELECT participant_id, task, platform, click_count, duration_ms
      FROM benchmark_logs
      WHERE success = 1
    `
    const ppParams = []
    if (taskFilter) {
      perParticipantQuery += ` AND task = ?`
      ppParams.push(taskFilter)
    }
    perParticipantQuery += ` ORDER BY task, platform, participant_id`

    const { results: perParticipant } = await env.DB.prepare(perParticipantQuery)
      .bind(...ppParams)
      .all()

    return new Response(JSON.stringify({ aggregated, perParticipant }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error("D1 query error:", err)
    return jsonError("Database error", 500, "db_error", corsHeaders)
  }
}

// ============================================================================
// GET /api/benchmark/raw?secret=X
// All raw logs — export to CSV / R / Python for statistical analysis
// ============================================================================

async function handleBenchmarkRaw(request, env, corsHeaders) {
  const url = new URL(request.url)

  const secret = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (env.RESULTS_SECRET && secret !== env.RESULTS_SECRET) {
    return jsonError("Unauthorized", 401, "unauthorized", corsHeaders)
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        id, participant_id, task, platform,
        click_count, raw_click_count, duration_ms,
        success, cancelled, cancel_reason,
        input_fields,
        started_at, completed_at, created_at
      FROM benchmark_logs
      ORDER BY created_at DESC
      LIMIT 5000
    `).all()

    return new Response(JSON.stringify({ count: results.length, logs: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error("D1 query error:", err)
    return jsonError("Database error", 500, "db_error", corsHeaders)
  }
}

// ============================================================================
// Shared helper — already exists in your worker, kept for consistency
// ============================================================================

function jsonError(message, status, code, corsHeaders) {
  return new Response(
    JSON.stringify({ error: message, code }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  )
}