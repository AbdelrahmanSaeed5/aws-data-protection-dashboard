'use strict';

const state = { view:'overview', mode:'loading', reports:[], total:0, selectedFile:null, filter:'all', selectedReport:null, bucket:'', loading:false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const label = (classification) => `<span class="status-pill ${classification === 'Confidential' ? 'confidential' : classification === 'Internal' ? 'internal' : 'pending'}">${esc(classification || 'Pending')}</span>`;
const shortFile = (key) => String(key || '').split('/').pop() || 'Unknown file';
const timeLabel = (value) => { if(!value) return '—'; const d=new Date(value); return Number.isNaN(d.valueOf())?'—':d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); };
const toast = (message,error=false) => {const el=document.createElement('div');el.className=`toast${error?' error':''}`;el.textContent=message;$('#toast-stack').append(el);setTimeout(()=>el.remove(),5300);};

async function api(path, options={}) {
  const res = await fetch(path, { cache:'no-store', ...options });
  let data;
  try { data = await res.json(); } catch { throw new Error(`Server returned HTTP ${res.status}`); }
  if(!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function navigate(view) {
  state.view=view;
  $$('.view').forEach(el => el.classList.toggle('active',el.id === `view-${view}`));
  $$('.nav-link').forEach(el => el.classList.toggle('active',el.dataset.view === view));
  $('#crumb-title').textContent=({overview:'Overview',upload:'Upload & Scan',reports:'Scan Reports',security:'Security Controls',activity:'Monitoring'})[view] || 'Overview';
  $('#sidebar').classList.remove('open');
  window.scrollTo({top:0,behavior:'smooth'});
}

function showOverview(data) {
  state.mode=data.mode;
  state.bucket=data.bucket;
  state.reports=data.reports || [];
  state.total=data.total ?? state.reports.length;
  $('#mode-tag').textContent=data.mode==='demo'?'● Demo Data':'● AWS Connected';
  $('#mode-tag').classList.toggle('demo',data.mode==='demo');
  $('#env-bucket').textContent=data.bucket || 'Local demonstration';
  const reportList=state.reports;
  $('#metric-total').textContent=String(state.total);
  $('#metric-confidential').textContent=String(reportList.filter(r=>r.classification==='Confidential').length);
  $('#metric-internal').textContent=String(reportList.filter(r=>r.classification==='Internal').length);
  $('#metric-patterns').textContent=String(reportList.reduce((sum,r)=>sum+(Number(r.total_patterns_detected)||0),0));
  const recent=reportList.slice(0,5);
  $('#recent-table').innerHTML=recent.length?recent.map(r=>`<tr><td><span class="filename"><span class="file-dot">${icon('file')}</span>${esc(shortFile(r.source_key))}</span></td><td>${label(r.classification)}</td><td>${esc(r.total_patterns_detected)}</td><td>${esc(timeLabel(r.scanned_at_utc))}</td><td><button class="row-action" type="button" data-report="${esc(r.report_key)}">View</button></td></tr>`).join(''):'<tr><td class="empty-table" colspan="5">No scan reports yet. Upload a CSV to get started.</td></tr>';
  const chartList=reportList.slice(0,7).reverse();
  $('#chart-empty').classList.toggle('hidden',!!chartList.length);
  $('#mini-chart').classList.toggle('hidden',!chartList.length);
  const max=Math.max(1,...chartList.map(r=>Number(r.total_patterns_detected)||0));
  $('#mini-chart').innerHTML=chartList.map((r,i)=>{const n=Number(r.total_patterns_detected)||0;return `<div class="chart-bar-wrap" title="${esc(shortFile(r.source_key))}: ${n} patterns"><div class="chart-bar" style="height:${Math.max(4,Math.round(n/max*110))}px;${n===0?'background:#314a55;':''}"></div><span class="chart-label">Scan ${i+1}</span></div>`;}).join('');
  updateReports();updateActivity();
}

function updateReports(){
  const query=$('#report-search').value.trim().toLowerCase();
  const filtered=state.reports.filter(r => (state.filter==='all'||(r.classification||'').toLowerCase()===state.filter) && (shortFile(r.source_key).toLowerCase().includes(query)));
  $('#reports-table').innerHTML=filtered.length?filtered.map(r=>`<tr><td><span class="filename"><span class="file-dot">${icon('file')}</span>${esc(shortFile(r.source_key))}</span></td><td>${label(r.classification)}</td><td>${esc(r.total_patterns_detected)}</td><td>${esc(timeLabel(r.scanned_at_utc))}</td><td><button class="row-action" data-report="${esc(r.report_key)}" type="button">Open report ${icon('arrow')}</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty-table">No matching reports.</td></tr>';
  $('#report-count').textContent=`Showing ${filtered.length} recent scan report${filtered.length!==1?'s':''}`;
}

function updateActivity(){
  const rows=state.reports.slice(0,9);
  $('#activity-list').innerHTML=rows.length?rows.map(r=>`<div class="activity-entry"><span class="activity-dot ${r.classification==='Confidential'?'warn':''}">${icon(r.classification==='Confidential'?'alert':'check')}</span><div class="activity-body"><strong>${esc(shortFile(r.source_key))}</strong><p>${esc(r.classification)} · ${esc(r.total_patterns_detected)} sensitive patterns detected</p></div><span class="activity-time">${esc(timeLabel(r.scanned_at_utc))}</span></div>`).join(''):'<p class="empty-message">No classification activity yet.</p>';
}

function statusText(value){return value === true?'<span class="check-state">✓ Enabled</span>':value===false?'<span class="check-state fail">✕ Not enabled</span>':'<span class="check-state warn">Not verified</span>';}
function showSecurity(data){
  $('#security-region').textContent=`S3 • ${data.bucket || state.bucket}`;
  const checks=[{title:'Amazon S3',iconName:'cloud',rows:[['Block public access',data.publicAccessBlocked],['Bucket versioning',data.versioningEnabled],['HTTPS-only bucket policy',data.httpsOnlyPolicy]]},{title:'Data Encryption',iconName:'lock',rows:[['SSE-KMS default encryption',data.sseKmsEnabled],['Project customer-managed key',data.customerManagedKey]]}];
  const values=checks.flatMap(c=>c.rows.map(r=>r[1]));
  $('#security-overall').textContent=values.every(v=>v===true)?'● All checked controls enabled':values.includes(false)?'● Attention required':'● Some checks unavailable';
  $('#security-grid').innerHTML=checks.map(c=>`<div class="surface-card security-card"><div class="security-title">${icon(c.iconName)}<strong>${c.title}</strong></div>${c.rows.map(row=>`<div class="security-item"><span>${esc(row[0])}</span>${statusText(row[1])}</div>`).join('')}</div>`).join('');
}
function showMonitoring(data){
  $('#monitor-invocations').textContent=data.invocations24h ?? '—';
  $('#monitor-errors').textContent=data.errors24h ?? '—';
  const a=$('#monitor-alarm');a.textContent=data.alarmState || 'Unavailable';a.className=`alarm-state ${data.alarmState==='OK'?'ok':data.alarmState==='ALARM'?'alarm':''}`;
  $('#monitor-alarm-caption').textContent=data.alarmName || 'Lambda error alarm';
}

async function refresh(silent=false){
  if(state.loading)return;
  state.loading=true;
  try{
    const [overview,security,monitoring]=await Promise.allSettled([api('/api/overview'),api('/api/security'),api('/api/monitoring')]);
    if(overview.status==='fulfilled')showOverview(overview.value); else throw overview.reason;
    if(security.status==='fulfilled')showSecurity(security.value);else {showSecurity({bucket:state.bucket}); if(!silent)toast(`Security checks: ${security.reason.message}`,true);}
    if(monitoring.status==='fulfilled')showMonitoring(monitoring.value);else showMonitoring({});
    if(!silent)toast('Dashboard refreshed successfully.');
  }catch(err){toast(`Unable to load dashboard: ${err.message}`,true);$('#recent-table').innerHTML=`<tr><td colspan="5" class="empty-table">${esc(err.message)}</td></tr>`;}
  finally{state.loading=false;}
}

async function viewReport(key){
  try{
    const r=await api(`/api/report?key=${encodeURIComponent(key)}`);
    state.selectedReport=r;
    $('#report-modal-title').textContent=shortFile(r.source_key);
    const items=Object.entries(r.counts_by_type||{});
    $('#modal-body').innerHTML=`<div class="detail-grid"><div class="detail-box"><span>CLASSIFICATION</span>${label(r.classification)}</div><div class="detail-box"><span>PATTERNS DETECTED</span><strong>${esc(r.total_patterns_detected)}</strong></div><div class="detail-box"><span>SCAN TIME</span><strong style="font-size:12px">${esc(timeLabel(r.scanned_at_utc))}</strong></div><div class="detail-box"><span>ALERT ELIGIBLE</span><strong>${r.alert_eligible?'Yes':'No'}</strong></div></div><div class="detail-section"><h3>Detection breakdown</h3>${items.length?items.map(([name,value])=>`<div class="detail-row"><span>${esc(name.replace(/_/g,' '))}</span><strong>${esc(value)}</strong></div>`).join(''):'<div class="detail-row"><span>No sensitive patterns detected</span><strong>0</strong></div>'}</div><div class="detail-section"><h3>Report metadata</h3><div class="detail-row"><span>Source object</span><strong>${esc(r.source_key)}</strong></div><div class="detail-row"><span>Detection engine</span><strong>Custom pattern scanner</strong></div></div><div class="detail-notice">This sanitized report describes pattern matches in synthetic data and doesn't include the original personal-information values.</div>`;
    $('#report-modal').showModal();
  } catch(err){ toast(`Cannot open report: ${err.message}`,true); }
}

function selectFile(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith('.csv')){toast('Please choose a .csv file.',true);return;}
  if(file.size>1024*1024){toast('Maximum file size is 1 MB.',true);return;}
  if(file.size===0){toast('CSV file is empty.',true);return;}
  state.selectedFile=file;
  $('#selected-file').classList.remove('hidden');$('#selected-name').textContent=file.name;$('#selected-size').textContent=`${Math.max(1,Math.ceil(file.size/1024))} KB`;
  $('#upload-button').disabled=false;$('#upload-feedback').classList.add('hidden');
}

async function upload(){
  const file=state.selectedFile;if(!file)return;
  const button=$('#upload-button');button.disabled=true;button.textContent='Uploading securely...';
  try{
    const response=await api('/api/upload',{method:'POST',headers:{'Content-Type':'text/csv; charset=utf-8','X-Filename':encodeURIComponent(file.name)},body:file});
    const feedback=$('#upload-feedback');feedback.className='upload-feedback';
    feedback.textContent=response.mode==='demo'?`Demo scan completed: ${response.classification} · ${response.detected} matched patterns. No AWS resources were changed.`:`Uploaded to S3: ${response.key}. Lambda will scan it automatically; waiting for a new report...`;
    state.selectedFile=null;$('#file-input').value='';$('#selected-file').classList.add('hidden');
    await refresh(true);
    if(response.mode!=='demo'){
      let found=state.reports.some(r=>r.source_key===response.key);
      for(let retry=0;!found&&retry<8;retry++){
        await new Promise(resolve=>setTimeout(resolve,2500));
        await refresh(true);
        found=state.reports.some(r=>r.source_key===response.key);
      }
      feedback.textContent=found?'Scan complete! The classification report is now available under Scan Reports.':'Upload succeeded. Lambda is still processing, or a permission error occurred. Check CloudWatch logs and refresh reports.';
    }
    toast(response.mode==='demo'?'Demo scan completed.':'File uploaded to S3 successfully.');
  }catch(err){const feedback=$('#upload-feedback');feedback.className='upload-feedback error';feedback.textContent=err.message;toast(`Upload failed: ${err.message}`,true);}
  finally{button.disabled=!state.selectedFile;button.innerHTML=`Upload & start scan ${icon('arrow')}`;}
}

$$('.nav-link').forEach(el=>el.addEventListener('click',()=>navigate(el.dataset.view)));
$$('[data-go]').forEach(el=>el.addEventListener('click',()=>navigate(el.dataset.go)));
$$('[data-refresh]').forEach(el=>el.addEventListener('click',()=>refresh()));
$('#refresh-button').addEventListener('click',()=>refresh());
$('#mobile-nav-button').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#report-search').addEventListener('input',updateReports);
$$('.filter-btn').forEach(el=>el.addEventListener('click',()=>{$$('.filter-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');state.filter=el.dataset.filter;updateReports();}));
document.addEventListener('click',event=>{const button=event.target.closest('[data-report]');if(button)viewReport(button.dataset.report);});
$('#modal-close').addEventListener('click',()=>$('#report-modal').close());
$('#modal-done').addEventListener('click',()=>$('#report-modal').close());
$('#modal-download').addEventListener('click',()=>{if(!state.selectedReport)return;const blob=new Blob([JSON.stringify(state.selectedReport,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`${shortFile(state.selectedReport.source_key).replace(/[^a-z0-9_.-]/gi,'_')}-security-report.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#dropzone').addEventListener('click',()=>$('#file-input').click());
$('#dropzone').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('#file-input').click();}});
$('#file-input').addEventListener('change',event=>selectFile(event.target.files?.[0]));
$('#remove-file').addEventListener('click',()=>{state.selectedFile=null;$('#file-input').value='';$('#selected-file').classList.add('hidden');$('#upload-button').disabled=true;});
for(const type of ['dragenter','dragover'])$('#dropzone').addEventListener(type,event=>{event.preventDefault();$('#dropzone').classList.add('dragover')});
for(const type of ['dragleave','drop'])$('#dropzone').addEventListener(type,event=>{event.preventDefault();$('#dropzone').classList.remove('dragover')});
$('#dropzone').addEventListener('drop',event=>selectFile(event.dataTransfer?.files?.[0]));
$('#upload-button').addEventListener('click',upload);
refresh(true);
