import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Building2, CheckCircle2, Loader2, Plus, Radar, Search, Sparkles, Target, X } from 'lucide-react'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type Status = 'draft' | 'analyzing' | 'ready' | 'failed'

type Project = {
  id: string
  partner_name: string
  website: string
  offer: string
  target_geography: string
  target_customer: string
  advantages: string
  competitors: string
  exclusions: string
  status: Status
  created_at: string
  error_message?: string | null
}

type FormData = Omit<Project, 'id' | 'status' | 'created_at' | 'error_message'>

const emptyForm: FormData = {
  partner_name: '', website: '', offer: '', target_geography: '', target_customer: '', advantages: '', competitors: '', exclusions: '',
}

const demoProjects: Project[] = [{
  id: 'demo-1', partner_name: 'Northstar Packaging', website: 'https://example.com', offer: 'Custom sustainable packaging for mid-market food brands', target_geography: 'United States', target_customer: 'Food manufacturers and DTC brands', advantages: 'Low minimum order, multilingual support, fast sampling', competitors: 'Traditional packaging distributors', exclusions: 'Cannabis, tobacco', status: 'ready', created_at: new Date().toISOString(),
}]

const statusLabel: Record<Status, string> = { draft: 'Draft', analyzing: 'Analyzing', ready: 'Ready', failed: 'Failed' }

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => { void loadProjects() }, [])

  async function loadProjects() {
    setLoading(true)
    if (!supabase) {
      setProjects(demoProjects); setSelected(demoProjects[0]); setLoading(false); return
    }
    const { data, error } = await supabase.from('prospecting_projects').select('*').order('created_at', { ascending: false })
    if (error) setNotice(error.message)
    const rows = (data ?? []) as Project[]
    setProjects(rows); setSelected(rows[0] ?? null); setLoading(false)
  }

  async function createProject(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice('')
    if (!supabase) {
      const item: Project = { ...form, id: crypto.randomUUID(), status: 'draft', created_at: new Date().toISOString() }
      setProjects((p) => [item, ...p]); setSelected(item); setShowForm(false); setForm(emptyForm); setSaving(false); return
    }
    const { data, error } = await supabase.from('prospecting_projects').insert({ ...form, status: 'draft' }).select().single()
    if (error) setNotice(error.message)
    else { const item = data as Project; setProjects((p) => [item, ...p]); setSelected(item); setShowForm(false); setForm(emptyForm) }
    setSaving(false)
  }

  async function analyze(project: Project) {
    const updated = { ...project, status: 'analyzing' as Status }
    setSelected(updated); setProjects((all) => all.map((p) => p.id === project.id ? updated : p))
    if (!supabase) {
      setTimeout(() => {
        const ready = { ...updated, status: 'ready' as Status }
        setSelected(ready); setProjects((all) => all.map((p) => p.id === ready.id ? ready : p))
      }, 1300)
      return
    }
    const { error } = await supabase.functions.invoke('analyze-prospecting-project', { body: { project_id: project.id } })
    if (error) {
      const failed = { ...project, status: 'failed' as Status, error_message: error.message }
      setSelected(failed); setProjects((all) => all.map((p) => p.id === project.id ? failed : p)); return
    }
    await loadProjects()
  }

  const stats = useMemo(() => ({ total: projects.length, ready: projects.filter(p => p.status === 'ready').length, active: projects.filter(p => p.status === 'analyzing').length }), [projects])

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Radar size={20}/></div><div><strong>Demand Signal</strong><span>Prospecting Agent</span></div></div>
      <nav><button className="nav-item active"><Building2 size={18}/> Projects</button><button className="nav-item"><Search size={18}/> Prospect Search</button><button className="nav-item"><Target size={18}/> Signal Library</button></nav>
      <div className="sidebar-note"><Sparkles size={18}/><p>Find companies showing real buying intent, not just static fit.</p></div>
    </aside>

    <main>
      <header><div><p className="eyebrow">B2B REVENUE INTELLIGENCE</p><h1>Prospecting workspace</h1><p className="subtitle">Turn a partner offer into an evidence-backed demand map.</p></div><button className="primary" onClick={() => setShowForm(true)}><Plus size={18}/> New project</button></header>

      {!hasSupabaseConfig && <div className="demo-banner">Demo mode is active. Add your Supabase keys to connect live data.</div>}
      {notice && <div className="error-banner">{notice}</div>}

      <section className="stats">
        <div><span>Projects</span><strong>{stats.total}</strong></div><div><span>Ready</span><strong>{stats.ready}</strong></div><div><span>Analyzing</span><strong>{stats.active}</strong></div>
      </section>

      <section className="workspace">
        <div className="project-list panel"><div className="panel-head"><h2>Projects</h2><span>{projects.length}</span></div>
          {loading ? <div className="empty"><Loader2 className="spin"/> Loading</div> : projects.length === 0 ? <div className="empty">No projects yet.</div> : projects.map(project => <button key={project.id} onClick={() => setSelected(project)} className={`project-row ${selected?.id === project.id ? 'selected' : ''}`}><div><strong>{project.partner_name}</strong><span>{project.offer}</span></div><i className={`status ${project.status}`}>{statusLabel[project.status]}</i></button>)}
        </div>

        <div className="detail panel">
          {!selected ? <div className="empty large"><Radar size={40}/><h2>Select a project</h2><p>Project details and AI analysis will appear here.</p></div> : <>
            <div className="detail-top"><div><div className="title-line"><h2>{selected.partner_name}</h2><i className={`status ${selected.status}`}>{statusLabel[selected.status]}</i></div><a href={selected.website} target="_blank" rel="noreferrer">{selected.website}</a></div><button className="primary" disabled={selected.status === 'analyzing'} onClick={() => void analyze(selected)}>{selected.status === 'analyzing' ? <Loader2 className="spin" size={18}/> : <Sparkles size={18}/>} {selected.status === 'ready' ? 'Run again' : 'Start analysis'}</button></div>
            <div className="info-grid"><Info label="Offer" value={selected.offer}/><Info label="Geography" value={selected.target_geography}/><Info label="Target customer" value={selected.target_customer}/><Info label="Advantages" value={selected.advantages}/><Info label="Competitors" value={selected.competitors || 'Not specified'}/><Info label="Exclusions" value={selected.exclusions || 'None'}/></div>
            <div className="results"><h3>Analysis output</h3>{selected.status === 'ready' ? <div className="result-grid"><ResultCard title="Offer profile" text="Clear commercial offer, differentiators, buying context and exclusion rules."/><ResultCard title="Ideal customer profile" text="Mid-market operators with active packaging demand and visible growth signals."/><ResultCard title="Demand signals" text="RFQs, supplier searches, expansion, hiring, funding and new product launches."/></div> : <div className="result-placeholder"><CheckCircle2 size={22}/><span>{selected.status === 'analyzing' ? 'The agent is analyzing this project.' : 'Run analysis to generate the offer profile, ICP and demand signal map.'}</span></div>}</div>
          </>}
        </div>
      </section>
    </main>

    {showForm && <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><p className="eyebrow">NEW PROSPECTING PROJECT</p><h2>Describe the partner offer</h2></div><button className="icon" onClick={() => setShowForm(false)}><X/></button></div><form onSubmit={createProject}><div className="form-grid"><Field label="Partner name" required value={form.partner_name} onChange={v => setForm({...form, partner_name:v})}/><Field label="Website" required value={form.website} onChange={v => setForm({...form, website:v})}/><Field area label="Offer" required value={form.offer} onChange={v => setForm({...form, offer:v})}/><Field label="Target geography" required value={form.target_geography} onChange={v => setForm({...form, target_geography:v})}/><Field area label="Target customer" required value={form.target_customer} onChange={v => setForm({...form, target_customer:v})}/><Field area label="Advantages" value={form.advantages} onChange={v => setForm({...form, advantages:v})}/><Field area label="Competitors" value={form.competitors} onChange={v => setForm({...form, competitors:v})}/><Field area label="Exclusions" value={form.exclusions} onChange={v => setForm({...form, exclusions:v})}/></div><div className="form-actions"><button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancel</button><button className="primary" disabled={saving}>{saving && <Loader2 className="spin" size={18}/>} Create project <ArrowRight size={18}/></button></div></form></div></div>}
  </div>
}

function Info({ label, value }: { label: string; value: string }) { return <div className="info"><span>{label}</span><p>{value}</p></div> }
function ResultCard({ title, text }: { title: string; text: string }) { return <article><span className="result-icon"><Sparkles size={17}/></span><h4>{title}</h4><p>{text}</p></article> }
function Field({ label, value, onChange, required, area }: { label:string; value:string; onChange:(v:string)=>void; required?:boolean; area?:boolean }) { return <label className={area ? 'wide' : ''}><span>{label}{required && ' *'}</span>{area ? <textarea value={value} required={required} onChange={e => onChange(e.target.value)}/> : <input value={value} required={required} onChange={e => onChange(e.target.value)}/>}</label> }
