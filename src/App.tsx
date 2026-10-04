import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Bot, CheckCircle2, CircleDollarSign, Database, Radar, Search, ShieldCheck } from 'lucide-react'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type PreviewResult = {
  supplied_count: number
  new_entities_found: number
  verified_new_entities: number
  search_passes: number
  saturation: 'not_reached' | 'approaching' | 'reached'
  known_gaps: string[]
  sample_new_entities: { name: string; url?: string; reason?: string }[]
  full_price_usd: number
  note?: string
}

const capability = {
  name: 'coverage_check',
  purpose: 'Find important entities an AI research task may have missed.',
  useWhen: 'Use when comprehensive coverage matters: market maps, competitor research, suppliers, companies, products, candidates, or exhaustive discovery.',
  avoidWhen: 'Do not use for simple facts, a few examples, or casual recommendations.',
}

async function logEvent(eventType: string, metadata: Record<string, unknown> = {}) {
  if (!supabase) return
  try {
    await supabase.functions.invoke('log-agent-event', {
      body: { event_type: eventType, path: window.location.pathname, metadata },
    })
  } catch {
    // Analytics must never block the experiment UI.
  }
}

function App() {
  const [task, setTask] = useState('')
  const [resultsText, setResultsText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [error, setError] = useState('')
  const path = window.location.pathname
  const isAgentPage = path === '/agent'
  const isDashboard = path === '/dashboard'

  useEffect(() => {
    logEvent(isAgentPage ? 'capability_read' : isDashboard ? 'dashboard_view' : 'landing_view')
  }, [isAgentPage, isDashboard])

  const parsedResults = useMemo(() => resultsText.split('\n').map((x) => x.trim()).filter(Boolean), [resultsText])

  async function runPreview(e: FormEvent) {
    e.preventDefault()
    if (!task.trim()) return
    setLoading(true)
    setError('')
    setResult(null)
    await logEvent('preview_requested', { task_length: task.length, supplied_count: parsedResults.length })

    if (!supabase) {
      await new Promise((r) => setTimeout(r, 700))
      setResult({
        supplied_count: parsedResults.length,
        new_entities_found: 0,
        verified_new_entities: 0,
        search_passes: 0,
        saturation: 'not_reached',
        known_gaps: ['Live search is disabled until Supabase and OPENAI_API_KEY are configured.'],
        sample_new_entities: [],
        full_price_usd: 0.25,
        note: 'Demo mode: the public experiment UI is working, but live coverage search is not configured.',
      })
      setLoading(false)
      return
    }

    const { data, error: fnError } = await supabase.functions.invoke('coverage-preview', {
      body: { task: task.trim(), current_results: parsedResults.slice(0, 100) },
    })
    if (fnError) setError(fnError.message)
    else setResult(data as PreviewResult)
    setLoading(false)
  }

  async function showPaidIntent() {
    await logEvent('pricing_requested', { price_usd: result?.full_price_usd ?? 0.25 })
    alert('Paid full search is intentionally not enabled in phase 1. This click has been recorded as commercial intent.')
  }

  if (isDashboard) return <Dashboard />

  return (
    <main>
      <nav className="nav">
        <a className="brand" href="/"><Radar size={20} /> AgentCoverage</a>
        <div className="navlinks"><a href="/agent">Agent spec</a><a href="#preview">Preview</a><a href="/dashboard">Experiment</a></div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><Bot size={15} /> Built for agents first</div>
        <h1>Know when your research<br />has <span>missed something.</span></h1>
        <p className="lede">A coverage-checking service for AI agents. Bring a research task and the entities you already found. We search for what is missing and report the gaps without pretending the open web is 100% complete.</p>
        <div className="actions"><a className="primary" href="#preview">Run free preview <ArrowRight size={17} /></a><a className="secondary" href="/agent">Read machine spec</a></div>
      </section>

      <section className="metrics">
        <div><strong>1</strong><span>focused capability</span></div>
        <div><strong>Free</strong><span>2-pass preview</span></div>
        <div><strong>$0.25</strong><span>proposed full check</span></div>
        <div><strong>JSON</strong><span>machine-readable output</span></div>
      </section>

      <section className="grid3">
        <article><Search /><h3>Search beyond the first answer</h3><p>Expand queries and source angles instead of treating the first relevant results as the whole market.</p></article>
        <article><Database /><h3>Compare against what you have</h3><p>Normalize and deduplicate candidate entities, then surface additions rather than repeating known results.</p></article>
        <article><ShieldCheck /><h3>Report uncertainty honestly</h3><p>Return known gaps, search saturation and source limitations instead of a fake 97.3% completeness score.</p></article>
      </section>

      {isAgentPage && <section className="spec">
        <div className="eyebrow">MACHINE CAPABILITY</div>
        <h2>{capability.name}</h2>
        <pre>{JSON.stringify({
          capability: capability.name,
          purpose: capability.purpose,
          use_when: capability.useWhen,
          do_not_use_when: capability.avoidWhen,
          input: ['task', 'current_results[]'],
          output: ['new_entities', 'known_gaps', 'search_passes', 'saturation', 'sources'],
          preview: 'free',
          full_search: { status: 'phase_1_intent_test', proposed_price_usd: 0.25 },
        }, null, 2)}</pre>
      </section>}

      <section className="preview" id="preview">
        <div className="sectionHead"><div><div className="eyebrow">LIVE EXPERIMENT</div><h2>Ask: “What did I miss?”</h2></div><p>The preview intentionally runs a shallow check. Phase 1 measures whether agents progress from discovery → preview → pricing intent.</p></div>
        <form onSubmit={runPreview}>
          <label>Research task<textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="Example: Find US pet-tech companies making connected hardware for consumers." required /></label>
          <label>Current findings <span>(one entity per line, optional)</span><textarea value={resultsText} onChange={(e) => setResultsText(e.target.value)} placeholder={'Whistle\nFi\nPetSafe'} /></label>
          <button className="primary button" disabled={loading}>{loading ? 'Checking coverage…' : 'Run free coverage preview'} <ArrowRight size={17} /></button>
        </form>
        {error && <div className="error">{error}</div>}
        {result && <div className="result">
          <div className="resultTop"><CheckCircle2 /><div><strong>Preview complete</strong><span>{result.note || 'This is an experimental coverage assessment, not a claim of total web completeness.'}</span></div></div>
          <div className="resultStats"><div><strong>{result.supplied_count}</strong><span>supplied</span></div><div><strong>{result.new_entities_found}</strong><span>new candidates</span></div><div><strong>{result.verified_new_entities}</strong><span>verified new</span></div><div><strong>{result.search_passes}</strong><span>passes</span></div></div>
          {result.sample_new_entities.length > 0 && <div className="samples"><h4>Sample additions</h4>{result.sample_new_entities.map((x) => <div className="sample" key={x.name}><strong>{x.name}</strong><span>{x.reason}</span>{x.url && <a href={x.url} target="_blank" rel="noreferrer">source</a>}</div>)}</div>}
          <div className="gaps"><h4>Known gaps</h4>{result.known_gaps.map((g) => <p key={g}>— {g}</p>)}</div>
          <button className="paid" onClick={showPaidIntent}><CircleDollarSign size={18} /> Full coverage check · ${result.full_price_usd.toFixed(2)} <span>intent test</span></button>
        </div>}
      </section>

      <footer><span>AgentCoverage · public discovery experiment</span><span>Not claiming mathematical completeness of the open web.</span></footer>
    </main>
  )
}

function Dashboard() {
  return <main><nav className="nav"><a className="brand" href="/"><Radar size={20} /> AgentCoverage</a></nav><section className="spec"><div className="eyebrow">EXPERIMENT STATUS</div><h1>Discovery funnel</h1><p className="lede">The event pipeline is designed to distinguish discovery, capability reading, preview use and pricing intent.</p><div className="funnel"><div><strong>01</strong><span>landing_view</span></div><div><strong>02</strong><span>capability_read</span></div><div><strong>03</strong><span>preview_requested</span></div><div><strong>04</strong><span>pricing_requested</span></div></div><p className="notice">{hasSupabaseConfig ? 'Supabase is configured in this build. Query agent_events in Supabase for live counts.' : 'Demo mode: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable live event logging.'}</p></section></main>
}

export default App
