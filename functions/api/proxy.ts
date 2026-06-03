// functions/api/proxy.ts

export const onRequestPost = async (context: { request: Request; env: { GEMINI_API_KEY?: string } }) => {
  try {
    const { request, env } = context;
    const requestUrl = new URL(request.url);
    
    // --- LAYER 1: ORIGIN & REFERER VERIFICATION ---
    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer");
    const allowedHost = requestUrl.host; // Dynamically matches localhost:8788 or explainote-ai.pages.dev

    if (!origin || !origin.includes(allowedHost)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized access: Origin mismatch." }), 
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!referer || !referer.includes(allowedHost)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized access: Bad referrer." }), 
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --- LAYER 3: CUSTOM APP HEADER VERIFICATION ---
    const clientHeader = request.headers.get("X-App-Client");
    if (clientHeader !== "ExplaiNote-SPA-Client") {
      return new Response(
        JSON.stringify({ error: "Unauthorized access: Missing app context." }), 
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --- CORE API LOGIC ---
    const secretKey = env.GEMINI_API_KEY;
    if (!secretKey) {
      return new Response(
        JSON.stringify({ error: "Server API key configuration missing." }), 
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const requestBody = await request.json();
    const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    
    const response = await fetch(`${GEMINI_API_URL}?key=${secretKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal Proxy Error" }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};