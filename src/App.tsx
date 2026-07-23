import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Building2, CheckCircle2, ExternalLink, Loader2, Plus, Radar, Search, Sparkles, Target, X } from 'lucide-react'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type Status = 'draft' | 'analyzing' | 'ready' | 'failed'
type OpportunityType = 'Active Purchase' | 'Expansion Trigger' | 'Recurring Buyer' | 'Supplier Replacement' | 'Channel Partner' | 'Strategic Fit'

type Project = {
  id: string; partner_name: string; website: string; offer: string; target_geography: string; target_customer: string
  advantages: string; competitors: string; exclusions: string; status: Status; created_at: string; error_message?: string | null
}

type Opportunity = {
  company_name: string; website: string; location: string; company_type: string; opportunity_type: OpportunityType
  fit_reason: string; current_trigger: string; likely_need: string; evidence_title: string; evidence_url: string
  evidence_snippet: string; buyer_role: string; outreach_angle: string; opportunity_score: number; confidence: number
}

type FormData = Omit<Project, 'id' | 'status' | 'created_at' | 'error_message'>
const emptyForm: FormData = { partner_name: '', website: '', offer: '', target_geography: '', target_customer: '', advantages: '', competitors: '', exclusions: '' }
const demoProjects: Project[] = [{ id: 'demo-1', partner_name: 'Northstar Packaging', website: 'https://example.com', offer: 'Custom sustainable packaging for mid-market food brands', target_geography: 'United States', target_customer: 'Food manufacturers and DTC brands', advantages: 'Low minimum order, multilingual support, fast sampling', competitors: 'Traditional packaging distributors', exclusions: 'Cannabis, tobacco', status: 'ready', created_at: new Date().toISOString() }]
const demoOpportunities: Opportunity[] = [
  { company_name:'Freshly Rooted Foods', website:'https://example.com', location:'California, US', company_type:'Food manufacturer', opportunity_type:'Expansion Trigger', fit_reason:'A growing packaged-food operator whose new retail distribution increases packaging volume and SKU complexity.', current_trigger:'Recently announced expansion into regional grocery stores.', likely_need:'Short-run sustainable pouches and faster sampling for new SKUs.', evidence_title:'Retail distribution expansion announcement', evidence_url:'https://example.com', evidence_snippet:'The company plans to launch multiple new products across regional retail locations.', buyer_role:'Director of Operations / Packaging Manager', outreach_angle:'Lead with fast sampling and lower minimums for new-product launches.', opportunity_score:91, confidence:86 },
  { company_name:'Harvest Table Co.', website:'https://example.com', location:'Texas, US', company_type:'DTC food brand', opportunity_type:'Recurring Buyer', fit_reason:'Its subscription model creates recurring packaging consumption and frequent seasonal design changes.', current_trigger:'Hiring a supply chain manager and launching a new subscription line.', likely_need:'Reliable recurring packaging supply with flexible order quantities.', evidence_title:'Supply chain hiring and new product line', evidence_url:'https://example.com', evidence_snippet:'The role will manage vendors, packaging inventory and product launch readiness.', buyer_role:'Supply Chain Manager / Founder', outreach_angle:'Position the offer as a flexible second source that reduces launch risk.', opportunity_score:87, confidence:82 }
]
const statusLabel: Record<Status, string> = { draft: 'Draft', analyzing: 'Analyzing', ready: 'Ready', failed: 'Failed' }

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => { void loadProjects() }, [])
  useEffect(() => { setOpportunities(selected?.id === 'demo-1' ? demoOpportunities : []) }, [selected?.id])

  async function loadProjects() {
    setLoading(true)
    if (!supabase) { setProjects(demoProjects); setSelected(demoProjects[0]); setLoading(false); return }
    const { data, error } = await supabase.from('prospecting_projects').select('*').order('created_at', { ascending: false })
    if (error) setNotice(error.message)
    const rows = (data ?? []) as Project[]
    setProjects(rows); setSelected(rows[0] ?? null); setLoading(false)
  }

  async function createProject(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice('')
    if (!supabase) {
      const item: Project = { ...form, id: crypto.randomUUID(), status: 'draft', created_at: new Date().toISOString() }
      setProjects(p => [item, ...p]); setSelected(item); setShowForm(false); setForm(emptyForm); setSaving(false); return
    }
    const { data, error } = await supabase.from('prospecting_projects').insert({ ...form, status: 'draft' }).select().single()
    if (error) setNotice(error.message)
    else { const item = data as Project; setProjects(p => [item, ...p]); setSelected(item); setShowForm(false); setForm(emptyForm) }
    setSaving(false)
  }

  async function analyze(project: Project) {
    const updated = { ...project, status: 'analyzing' as Status }
    setSelected(updated); setProjects(all => all.map(p => p.id === project.id ? updated : p))
    if (!supabase) { setTimeout(() => { const ready = { ...updated, status: 'ready' as Status }; setSelected(ready); setProjects(all => all.map(p => p.id === ready.id ? ready : p)) }, 900); return }
    const { error } = await supabase.functions.invoke('analyze-prospecting-project', { body: { project_id: project.id } })
    if (error) { const failed = { ...project, status: 'failed' as Status, error_message: error.message }; setSelected(failed); setProjects(all => all.map(p => p.id === project.id ? failed : p)); return }
    await loadProjects()
  }

  async function findOpportunities(project: Project) {
    setSearching(true); setNotice(''); setOpportunities([])
    if (!supabase) { setTimeout(() => { setOpportunities(demoOpportunities); setSearching(false) }, 1100); return }
    const { data, error } = await supabase.functions.invoke('find-opportunities', { body: { project_id: project.id, target_count: 15 } })
    if (error) setNotice(error.message)
    else setOpportunities((data?.opportunities ?? []) as Opportunity[])
    setSearching(false)
  }

  const stats = useMemo(() => ({ total: projects.length, ready: projects.filter(p => p.status === 'ready').length, opportunities: opportunities.length }), [projects, opportunities])

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Radar size={20}/></div><div><strong>Opportunity Agent</strong><span>B2B Revenue Intelligence</span></div></div>
      <nav><button className="nav-item active"><Building2 size={18}/> Projects</button><button className="nav-item"><Search size={18}/> Opportunity Search</button><button className="nav-item"><Target size={18}/> Signal Library</button></nav>
      <div className="sidebar-note"><Sparkles size={18}/><p>Find the companies most worth contacting and show the commercial reason behind every recommendation.</p></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">B2B OPPORTUNITY INTELLIGENCE</p><h1>Prospecting workspace</h1><p className="subtitle">Turn a partner offer into a ranked, evidence-backed opportunity list.</p></div><button className="primary" onClick={() => setShowForm(true)}><Plus size={18}/> New project</button></header>
      {!hasSupabaseConfig && <div className="demo-banner">Demo mode is active. The complete opportunity-search flow can be previewed without API keys.</div>}
      {notice && <div className="error-banner">{notice}</div>}
      <section className="stats"><div><span>Projects</span><strong>{stats.total}</strong></div><div><span>Ready</span><strong>{stats.ready}</strong></div><div><span>Ranked opportunities</span><strong>{stats.opportunities}</strong></div></section>
      <section className="workspace">
        <div className="project-list panel"><div className="panel-head"><h2>Projects</h2><span>{projects.length}</span></div>
          {loading ? <div className="empty"><Loader2 className="spin"/> Loading</div> : projects.length === 0 ? <div className="empty">No projects yet.</div> : projects.map(project => <button key={project.id} onClick={() => setSelected(project)} className={`project-row ${selected?.id === project.id ? 'selected' : ''}`}><div><strong>{project.partner_name}</strong><span>{project.offer}</span></div><i className={`status ${project.status}`}>{statusLabel[project.status]}</i></button>)}
        </div>
        <div className="detail panel">
          {!selected ? <div className="empty large"><Radar size={40}/><h2>Select a project</h2><p>Project details and ranked opportunities will appear here.</p></div> : <>
            <div className="detail-top"><div><div className="title-line"><h2>{selected.partner_name}</h2><i className={`status ${selected.status}`}>{statusLabel[selected.status]}</i></div><a href={selected.website} target="_blank" rel="noreferrer">{selected.website}</a></div><div className="action-row"><button className="secondary" disabled={selected.status === 'analyzing'} onClick={() => void analyze(selected)}>{selected.status === 'analyzing' ? <Loader2 className="spin" size={18}/> : <Sparkles size={18}/>} Analyze offer</button><button className="primary" disabled={searching} onClick={() => void findOpportunities(selected)}>{searching ? <Loader2 className="spin" size={18}/> : <Search size={18}/>} Find opportunities</button></div></div>
            <div className="info-grid"><Info label="Offer" value={selected.offer}/><Info label="Geography" value={selected.target_geography}/><Info label="Target customer" value={selected.target_customer}/><Info label="Advantages" value={selected.advantages}/></div>
            <div className="results"><div className="results-head"><div><p className="eyebrow">RANKED RESULTS</p><h3>High-intent partnership opportunities</h3></div>{opportunities.length > 0 && <span>{opportunities.length} companies</span>}</div>
              {searching ? <div className="result-placeholder"><Loader2 className="spin" size={22}/><span>Searching public sources, checking commercial signals and ranking candidates…</span></div> : opportunities.length === 0 ? <div className="result-placeholder"><CheckCircle2 size={22}/><span>Click “Find opportunities” to generate a ranked list with evidence, buyer role and outreach angle.</span></div> : <div className="opportunity-list">{opportunities.sort((a,b) => b.opportunity_score-a.opportunity_score).map((item,index) => <OpportunityCard key={`${item.company_name}-${index}`} item={item} rank={index+1}/>)}</div>}
            </div>
          </>}
        </div>
      </section>
    </main>
    {showForm && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><p className="eyebrow">NEW PROSPECTING PROJECT</p><h2>Describe the partner offer</h2></div><button className="icon" onClick={() => setShowForm(false)}><X/></button></div><form onSubmit={createProject}><div className="form-grid"><Field label="Partner name" required value={form.partner_name} onChange={v => setForm({...form, partner_name:v})}/><Field label="Website" required value={form.website} onChange={v => setForm({...form, website:v})}/><Field area label="Offer" required value={form.offer} onChange={v => setForm({...form, offer:v})}/><Field label="Target geography" required value={form.target_geography} onChange={v => setForm({...form, target_geography:v})}/><Field area label="Target customer" required value={form.target_customer} onChange={v => setForm({...form, target_customer:v})}/><Field area label="Advantages" value={form.advantages} onChange={v => setForm({...form, advantages:v})}/><Field area label="Competitors" value={form.competitors} onChange={v => setForm({...form, competitors:v})}/><Field area label="Exclusions" value={form.exclusions} onChange={v => setForm({...form, exclusions:v})}/></div><div className="form-actions"><button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancel</button><button className="primary" disabled={saving}>{saving && <Loader2 className="spin" size={18}/>} Create project <ArrowRight size={18}/></button></div></form></div></div>}
  </div>
}

function OpportunityCard({ item, rank }: { item: Opportunity; rank: number }) { return <article className="opportunity-card"><div className="rank">#{rank}</div><div className="opportunity-main"><div className="opportunity-title"><div><h4>{item.company_name}</h4><p>{item.company_type} · {item.location}</p></div><span className="opportunity-type">{item.opportunity_type}</span></div><p className="fit-reason">{item.fit_reason}</p><div className="opportunity-grid"><Info label="Current trigger" value={item.current_trigger}/><Info label="Likely need" value={item.likely_need}/><Info label="Best buyer role" value={item.buyer_role}/><Info label="Outreach angle" value={item.outreach_angle}/></div><div className="evidence"><div><strong>{item.evidence_title}</strong><p>{item.evidence_snippet}</p></div><a href={item.evidence_url || item.website} target="_blank" rel="noreferrer">Evidence <ExternalLink size={14}/></a></div></div><div className="score-box"><strong>{item.opportunity_score}</strong><span>Opportunity</span><small>{item.confidence}% confidence</small></div></article> }
function Info({ label, value }: { label: string; value: string }) { return <div className="info"><span>{label}</span><p>{value || 'Not available'}</p></div> }
function Field({ label, value, onChange, required, area }: { label:string; value:string; onChange:(v:string)=>void; required?:boolean; area?:boolean }) { return <label className={area ? 'wide' : ''}><span>{label}{required && ' *'}</span>{area ? <textarea value={value} required={required} onChange={e => onChange(e.target.value)}/> : <input value={value} required={required} onChange={e => onChange(e.target.value)}/>}</label> }