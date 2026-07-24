import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Building2, CheckCircle2, ExternalLink, Loader2, Plus, Radar, Search, Sparkles, Target, X } from 'lucide-react'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type Status = 'draft' | 'analyzing' | 'ready' | 'failed'
type Opportunity = { company_name:string; website:string; location:string; company_type:string; opportunity_type:string; fit_reason:string; current_trigger:string; likely_need:string; evidence_title:string; evidence_url:string; evidence_snippet:string; buyer_role:string; outreach_angle:string; opportunity_score:number; confidence:number }
type Profile = { partner_name?:string; offer_description?:string; target_customer?:string; key_advantages?:string[]; industries?:string[]; buyer_roles?:string[]; opportunity_types?:string[] }
type DbProject = { id:string; partner_name:string; website_url:string; offer_description:string; target_geography:string[]; target_customer:string; key_advantages:string[]; status:Status; created_at:string; settings?:{profile?:Profile} }
type Project = { id:string; partner_name:string; website:string; offer:string; geography:string; target_customer:string; advantages:string; status:Status; created_at:string; profile?:Profile }

const statusLabel:Record<Status,string>={draft:'Draft',analyzing:'Researching',ready:'Ready',failed:'Failed'}
const mapProject=(p:DbProject):Project=>({id:p.id,partner_name:p.partner_name,website:p.website_url,offer:p.offer_description,geography:(p.target_geography||[]).join(', '),target_customer:p.target_customer,advantages:(p.key_advantages||[]).join(', '),status:p.status,created_at:p.created_at,profile:p.settings?.profile})

export default function App(){
  const [projects,setProjects]=useState<Project[]>([])
  const [selected,setSelected]=useState<Project|null>(null)
  const [opportunities,setOpportunities]=useState<Opportunity[]>([])
  const [showForm,setShowForm]=useState(false)
  const [website,setWebsite]=useState('')
  const [geography,setGeography]=useState('United States')
  const [loading,setLoading]=useState(true)
  const [running,setRunning]=useState(false)
  const [notice,setNotice]=useState('')

  useEffect(()=>{void loadProjects()},[])

  async function loadProjects(preferredId?:string){
    setLoading(true)
    if(!supabase){setProjects([]);setSelected(null);setLoading(false);return}
    const {data,error}=await supabase.from('prospecting_projects').select('*').order('created_at',{ascending:false})
    if(error)setNotice(error.message)
    const rows=((data||[]) as DbProject[]).map(mapProject)
    setProjects(rows);setSelected(rows.find(x=>x.id===preferredId)??rows[0]??null);setLoading(false)
  }

  async function createAndResearch(e:FormEvent){
    e.preventDefault();setRunning(true);setNotice('');setOpportunities([])
    if(!supabase){setNotice('Supabase is not configured');setRunning(false);return}
    let normalized=website.trim();if(!/^https?:\/\//i.test(normalized))normalized=`https://${normalized}`
    let host='New website';try{host=new URL(normalized).hostname.replace(/^www\./,'')}catch{setNotice('Please enter a valid website');setRunning(false);return}
    const payload={partner_name:host,website_url:normalized,offer_description:'AI is analyzing this website',target_geography:geography.split(',').map(x=>x.trim()).filter(Boolean),target_customer:'AI will infer the best B2B targets',key_advantages:[],competitors:[],exclusion_criteria:[],status:'draft'}
    const {data,error}=await supabase.from('prospecting_projects').insert(payload).select().single()
    if(error){setNotice(error.message);setRunning(false);return}
    setShowForm(false);setWebsite('');await research(mapProject(data as DbProject))
  }

  async function research(project:Project){
    setRunning(true);setNotice('');setOpportunities([])
    const researching={...project,status:'analyzing' as Status};setSelected(researching);setProjects(all=>all.map(p=>p.id===project.id?researching:p))
    if(!supabase){setRunning(false);return}
    const {data,error}=await supabase.functions.invoke('research-opportunities-v2',{body:{project_id:project.id,target_count:12}})
    if(error||data?.error){setNotice(data?.error||error?.message||'Research failed');setRunning(false);return}
    setOpportunities((data.opportunities||[]) as Opportunity[])
    await loadProjects(project.id);setRunning(false)
  }

  const stats=useMemo(()=>({projects:projects.length,ready:projects.filter(p=>p.status==='ready').length,results:opportunities.length}),[projects,opportunities])

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Radar size={20}/></div><div><strong>Opportunity Agent</strong><span>Private B2B Research Tool</span></div></div><nav><button className="nav-item active"><Building2 size={18}/> Projects</button><button className="nav-item"><Search size={18}/> Opportunity Search</button><button className="nav-item"><Target size={18}/> Evidence</button></nav><div className="sidebar-note"><Sparkles size={18}/><p>Paste a partner website. The agent builds the offer profile, searches the market and ranks the companies most worth contacting.</p></div></aside>
    <main><header><div><p className="eyebrow">WEBSITE-TO-PROSPECT PIPELINE</p><h1>Your private B2B opportunity agent</h1><p className="subtitle">One website in. A researched, evidence-backed cooperation list out.</p></div><button className="primary" onClick={()=>setShowForm(true)}><Plus size={18}/> Research a website</button></header>
      {!hasSupabaseConfig&&<div className="demo-banner">Add Supabase keys to run live research.</div>}{notice&&<div className="error-banner">{notice}</div>}
      <section className="stats"><div><span>Projects</span><strong>{stats.projects}</strong></div><div><span>Ready</span><strong>{stats.ready}</strong></div><div><span>Current results</span><strong>{stats.results}</strong></div></section>
      <section className="workspace"><div className="project-list panel"><div className="panel-head"><h2>Research projects</h2><span>{projects.length}</span></div>{loading?<div className="empty"><Loader2 className="spin"/> Loading</div>:projects.length===0?<div className="empty">Start with a partner website.</div>:projects.map(p=><button key={p.id} onClick={()=>{setSelected(p);setOpportunities([])}} className={`project-row ${selected?.id===p.id?'selected':''}`}><div><strong>{p.partner_name}</strong><span>{p.offer}</span></div><i className={`status ${p.status}`}>{statusLabel[p.status]}</i></button>)}</div>
        <div className="detail panel">{!selected?<div className="empty large"><Radar size={40}/><h2>Paste a website to begin</h2><p>The agent will infer the offer and ideal buyers automatically.</p></div>:<><div className="detail-top"><div><div className="title-line"><h2>{selected.partner_name}</h2><i className={`status ${selected.status}`}>{statusLabel[selected.status]}</i></div><a href={selected.website} target="_blank" rel="noreferrer">{selected.website}</a></div><button className="primary" disabled={running} onClick={()=>void research(selected)}>{running?<Loader2 className="spin" size={18}/>:<Search size={18}/>} {running?'Researching…':'Run research again'}</button></div>
          <div className="info-grid"><Info label="Detected offer" value={selected.offer}/><Info label="Target geography" value={selected.geography}/><Info label="Likely B2B customers" value={selected.target_customer}/><Info label="Detected advantages" value={selected.advantages}/></div>
          {selected.profile&&<div className="results"><p className="eyebrow">AI BUSINESS PROFILE</p><div className="result-grid"><ProfileCard title="Industries" value={(selected.profile.industries||[]).join(', ')}/><ProfileCard title="Buyer roles" value={(selected.profile.buyer_roles||[]).join(', ')}/><ProfileCard title="Opportunity paths" value={(selected.profile.opportunity_types||[]).join(', ')}/></div></div>}
          <div className="results"><div className="results-head"><div><p className="eyebrow">RANKED RESULTS</p><h3>High-intent cooperation opportunities</h3></div>{opportunities.length>0&&<span>{opportunities.length} companies</span>}</div>{running?<div className="result-placeholder"><Loader2 className="spin" size={22}/><span>Reading the website, building the profile, searching the market and ranking evidence…</span></div>:opportunities.length===0?<div className="result-placeholder"><CheckCircle2 size={22}/><span>Run research to generate the opportunity list.</span></div>:<div className="opportunity-list">{[...opportunities].sort((a,b)=>b.opportunity_score-a.opportunity_score).map((x,i)=><OpportunityCard key={`${x.company_name}-${i}`} item={x} rank={i+1}/>)}</div>}</div></>}</div>
      </section>
    </main>
    {showForm&&<div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><p className="eyebrow">NEW RESEARCH PROJECT</p><h2>Paste the partner website</h2><p className="subtitle">The agent will infer the offer, target customers, advantages and search strategy.</p></div><button className="icon" onClick={()=>setShowForm(false)}><X/></button></div><form onSubmit={createAndResearch}><div className="form-grid"><Field label="Partner website" required value={website} onChange={setWebsite}/><Field label="Target geography" required value={geography} onChange={setGeography}/></div><div className="form-actions"><button type="button" className="secondary" onClick={()=>setShowForm(false)}>Cancel</button><button className="primary" disabled={running}>{running&&<Loader2 className="spin" size={18}/>} Analyze and find opportunities <ArrowRight size={18}/></button></div></form></div></div>}
  </div>
}

function OpportunityCard({item,rank}:{item:Opportunity;rank:number}){return <article className="opportunity-card"><div className="rank">#{rank}</div><div className="opportunity-main"><div className="opportunity-title"><div><h4>{item.company_name}</h4><p>{item.company_type} · {item.location}</p></div><span className="opportunity-type">{item.opportunity_type}</span></div><p className="fit-reason">{item.fit_reason}</p><div className="opportunity-grid"><Info label="Current trigger" value={item.current_trigger}/><Info label="Likely need" value={item.likely_need}/><Info label="Best buyer role" value={item.buyer_role}/><Info label="Outreach angle" value={item.outreach_angle}/></div><div className="evidence"><div><strong>{item.evidence_title}</strong><p>{item.evidence_snippet}</p></div><a href={item.evidence_url||item.website} target="_blank" rel="noreferrer">Evidence <ExternalLink size={14}/></a></div></div><div className="score-box"><strong>{item.opportunity_score}</strong><span>Opportunity</span><small>{item.confidence}% confidence</small></div></article>}
function Info({label,value}:{label:string;value:string}){return <div className="info"><span>{label}</span><p>{value||'Not available'}</p></div>}
function ProfileCard({title,value}:{title:string;value:string}){return <article><span className="result-icon"><Sparkles size={17}/></span><h4>{title}</h4><p>{value||'Not available'}</p></article>}
function Field({label,value,onChange,required}:{label:string;value:string;onChange:(v:string)=>void;required?:boolean}){return <label><span>{label}{required&&' *'}</span><input value={value} required={required} onChange={e=>onChange(e.target.value)}/></label>}
