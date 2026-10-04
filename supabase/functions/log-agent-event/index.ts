import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  try {
    const body = await req.json()
    const allowed = new Set(['landing_view', 'capability_read', 'dashboard_view', 'preview_requested', 'pricing_requested'])
    if (!allowed.has(body.event_type)) return new Response(JSON.stringify({ error: 'invalid event' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    const url = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(url, serviceKey)
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || ''
    const ipHash = forwarded ? (await sha256(`agentcoverage-v1:${forwarded}`)).slice(0, 24) : null

    const { error } = await supabase.from('agent_events').insert({
      event_type: body.event_type,
      path: String(body.path || '').slice(0, 300),
      session_id: String(body.session_id || '').slice(0, 100) || null,
      user_agent: (req.headers.get('user-agent') || '').slice(0, 500),
      ip_hash: ipHash,
      metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
    })
    if (error) throw error
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
