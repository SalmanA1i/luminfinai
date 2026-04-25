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
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      max_tokens: 1000,
      temperature: 0.7
    };
 
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(groqBody)
    });
 
    const data = await response.json();
 
    // Convert Groq response back to Anthropic format so the app works unchanged
    const converted = {
      content: [
        {
          type: 'text',
          text: data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.'
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
 
export const config = { runtime: 'edge' }
