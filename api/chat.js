export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response('API key not configured', { status: 500 });
  }

  try {
    const body = await req.json();

    // Convert Anthropic message format to Groq/OpenAI format
    const messages = [];

    // Add system message if present
    if (body.system) {
      messages.push({ role: 'system', content: body.system });
    }

    // Add conversation messages
    for (const msg of body.messages || []) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const groqBody = {
      model: 'openai/gpt-oss-120b',
      messages: messages,
      max_tokens: Math.min(body.max_tokens || 2000, 4000),
      temperature: typeof body.temperature === 'number' ? body.temperature : (body.json ? 0.15 : 0.7),
      reasoning_effort: 'low'
    };
    // JSON mode: guarantees valid JSON output and hides reasoning traces.
    // The client sets json:true for structured requests (risk reports, portfolios).
    if (body.json) {
      groqBody.response_format = { type: 'json_object' };
      groqBody.reasoning_format = 'hidden';
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(groqBody)
    });

    const data = await response.json();

    // Surface Groq API errors clearly (e.g. bad model id, rate limit)
    if (data.error) {
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'The AI service returned an error. Please try again in a moment.' }],
        _groq_error: data.error.message || String(data.error)
      }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // gpt-oss-120b is a reasoning model. The final answer is in message.content.
    // Some responses may also expose a separate reasoning field; we only want content.
    const msg = data.choices?.[0]?.message || {};
    let text = msg.content || '';
    // Safety: if content is empty but a reasoning field carried the answer, fall back to it
    if (!text && typeof msg.reasoning === 'string') text = msg.reasoning;
    if (!text) text = 'Sorry, I could not generate a response.';

    // Convert Groq response back to Anthropic format so the app works unchanged
    const converted = {
      content: [
        {
          type: 'text',
          text: text
        }
      ]
    };

    return new Response(JSON.stringify(converted), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Proxy error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export const config = { runtime: 'edge' };
