/**
 * Sentinel: local-only web server.
 * DEMO_MODE=true: sample reports and in-memory demo scans, no AWS requests.
 * DEMO_MODE=false: S3 uploads + S3 report reads + read-only CloudWatch metrics.
 * Bind 127.0.0.1 only. Never expose this unauthenticated local server to the internet.
 */
import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch(err) { if (err.code !== 'ENOENT') throw err; }

const CONFIG = {
  demo: String(process.env.DEMO_MODE ?? 'true').toLowerCase() !== 'false',
  region: process.env.AWS_REGION || 'us-east-1',
  bucket: process.env.AWS_BUCKET || 'depi-security-part4-demo-83921',
  functionName: process.env.AWS_LAMBDA_FUNCTION || 'depi-data-protection-scanner',
  alarmName: process.env.AWS_ERROR_ALARM || 'DEPI-Lambda-Error-Alarm',
  port: Number(process.env.PORT || 3000),
};
const readFileAsync = promisify(readFile);
const send = (res,status,obj) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(obj));
};
const errorMessage = err => String(err?.message || err || 'Unknown error').slice(0,280);
const isMissing = value => value === undefined || value === null;

let s3, cloudwatch, commandsS3, commandsCW;
if (!CONFIG.demo) {
  try {
    commandsS3 = await import('@aws-sdk/client-s3');
    commandsCW = await import('@aws-sdk/client-cloudwatch');
    s3 = new commandsS3.S3Client({region:CONFIG.region});
    cloudwatch = new commandsCW.CloudWatchClient({region:CONFIG.region});
  } catch(err) {
    console.error('AWS SDK packages are missing. Run "npm install", then restart.');
    console.error(errorMessage(err));
    process.exit(1);
  }
}

let demoReports = [
  {source_key:'incoming/customers_demo.csv', classification:'Confidential',total_patterns_detected:6,counts_by_type:{EMAIL_ADDRESS:3,EGYPTIAN_MOBILE_NUMBER:3},scanned_at_utc:new Date(Date.now()-13*60000).toISOString(),alert_eligible:true},
  {source_key:'incoming/clean_test.csv', classification:'Internal',total_patterns_detected:0,counts_by_type:{},scanned_at_utc:new Date(Date.now()-54*60000).toISOString(),alert_eligible:false},
  {source_key:'incoming/partner_contacts.csv', classification:'Confidential',total_patterns_detected:4,counts_by_type:{EMAIL_ADDRESS:4},scanned_at_utc:new Date(Date.now()-180*60000).toISOString(),alert_eligible:true},
  {source_key:'incoming/team_roster.csv', classification:'Internal',total_patterns_detected:0,counts_by_type:{},scanned_at_utc:new Date(Date.now()-570*60000).toISOString(),alert_eligible:false},
].map((report,i)=>({...report,report_key:`reports/demo-${i+1}.json`,engine:'DEMO SAMPLE DATA (not AWS)',alert_threshold:1}));

function getDemoReport(key){ return demoReports.find(r=>r.report_key===key); }
function demoScan(buffer, filename){
  const content=buffer.toString('utf8');
  if (!content.split(/\r?\n/,1)[0]?.trim()) throw Object.assign(new Error('CSV file must have a header row.'),{status:400});
  const email=(content.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)||[]).length;
  const mobile=(content.match(/(?<!\d)01[0125]\d{8}(?!\d)/g)||[]).length;
  const total=email+mobile;
  const key=`incoming/${randomUUID().slice(0,8)}-${filename}`;
  const report={source_key:key,classification:total?'Confidential':'Internal',total_patterns_detected:total,counts_by_type:{...(email?{EMAIL_ADDRESS:email}:{}),...(mobile?{EGYPTIAN_MOBILE_NUMBER:mobile}:{})},alert_eligible:total>0,alert_threshold:1,scanned_at_utc:new Date().toISOString(),report_key:`reports/${randomUUID()}.json`,engine:'DEMO ONLY - Browser demonstration; not processed in AWS',note:'Simulated demonstration classification. No actual upload to AWS.'};
  demoReports.unshift(report);
  return {mode:'demo',key,classification:report.classification,detected:total};
}

async function readStream(body,maxBytes=512*1024){
  const chunks=[];let total=0;
  for await (const c of body){total+=c.length;if(total>maxBytes)throw Object.assign(new Error('Report is unexpectedly large.'),{status:413});chunks.push(c);}
  return Buffer.concat(chunks);
}
async function s3Json(key){
  const response=await s3.send(new commandsS3.GetObjectCommand({Bucket:CONFIG.bucket,Key:key}));
  const json=JSON.parse((await readStream(response.Body)).toString('utf8'));
  if (!json || typeof json !== 'object' || !json.source_key) throw new Error(`Invalid report data: ${key}`);
  return {...json,report_key:key};
}
async function getReports(){
  if(CONFIG.demo)return demoReports.slice(0,40);
  const response=await s3.send(new commandsS3.ListObjectsV2Command({Bucket:CONFIG.bucket,Prefix:'reports/',MaxKeys:300}));
  const recent=(response.Contents||[]).filter(item=>item.Key?.endsWith('.json')).sort((a,b)=>new Date(b.LastModified)-new Date(a.LastModified)).slice(0,30);
  const reports=await Promise.all(recent.map(async item=>{try{return await s3Json(item.Key)}catch(err){console.error(`Skipping ${item.Key}: ${errorMessage(err)}`);return null;}}));
  return reports.filter(Boolean).sort((a,b)=>new Date(b.scanned_at_utc)-new Date(a.scanned_at_utc));
}
async function overview(){
  const reports=await getReports();
  return {mode:CONFIG.demo?'demo':'aws',bucket:CONFIG.bucket,reports,total:reports.length,limitNote:'Latest 30 reports, not a lifetime count'};
}

async function security(){
  if(CONFIG.demo)return {bucket:CONFIG.bucket,publicAccessBlocked:null,versioningEnabled:null,httpsOnlyPolicy:null,sseKmsEnabled:null,customerManagedKey:null};
  const results=await Promise.allSettled([
    s3.send(new commandsS3.GetPublicAccessBlockCommand({Bucket:CONFIG.bucket})),
    s3.send(new commandsS3.GetBucketVersioningCommand({Bucket:CONFIG.bucket})),
    s3.send(new commandsS3.GetBucketEncryptionCommand({Bucket:CONFIG.bucket})),
    s3.send(new commandsS3.GetBucketPolicyCommand({Bucket:CONFIG.bucket})),
  ]);
  const unwrap=i=>results[i].status==='fulfilled'?results[i].value:null;
  const publicBlock=unwrap(0)?.PublicAccessBlockConfiguration;
  const encrypted=unwrap(2)?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
  const policy=unwrap(3)?.Policy;
  let httpsOnlyPolicy=null;
  if(policy){try{const parsed=JSON.parse(policy);httpsOnlyPolicy=(Array.isArray(parsed.Statement)?parsed.Statement:[parsed.Statement]).some(s=>s?.Effect==='Deny'&&s?.Condition?.Bool?.['aws:SecureTransport']==='false'&&([].concat(s.Action||[]).includes('s3:*')||[].concat(s.Action||[]).includes('s3:GetObject')));}catch{httpsOnlyPolicy=null;}}
  return {bucket:CONFIG.bucket,
    publicAccessBlocked:publicBlock?Object.values(publicBlock).every(Boolean):null,
    versioningEnabled:unwrap(1)?unwrap(1)?.Status==='Enabled':null,
    httpsOnlyPolicy,
    sseKmsEnabled:encrypted?encrypted.SSEAlgorithm==='aws:kms':null,
    customerManagedKey:encrypted?encrypted.SSEAlgorithm==='aws:kms'&&Boolean(encrypted.KMSMasterKeyID)&&!String(encrypted.KMSMasterKeyID).includes('alias/aws/s3'):null,
  };
}

async function monitoring(){
  if(CONFIG.demo)return {mode:'demo',invocations24h:'—',errors24h:'—',alarmState:'Demo only',alarmName:CONFIG.alarmName};
  const now=new Date();const earlier=new Date(now-24*60*60*1000);
  const getMetric = async metric => {
    const data=await cloudwatch.send(new commandsCW.GetMetricStatisticsCommand({Namespace:'AWS/Lambda',MetricName:metric,Dimensions:[{Name:'FunctionName',Value:CONFIG.functionName}],StartTime:earlier,EndTime:now,Period:3600,Statistics:['Sum']}));
    return Math.round((data.Datapoints||[]).reduce((acc,p)=>acc+(p.Sum||0),0));
  };
  const results=await Promise.allSettled([getMetric('Invocations'),getMetric('Errors'),cloudwatch.send(new commandsCW.DescribeAlarmsCommand({AlarmNames:[CONFIG.alarmName]}))]);
  return {mode:'aws',invocations24h:results[0].status==='fulfilled'?results[0].value:null,errors24h:results[1].status==='fulfilled'?results[1].value:null,alarmState:results[2].status==='fulfilled'?results[2].value.MetricAlarms?.[0]?.StateValue||'Not found':'Unavailable',alarmName:CONFIG.alarmName};
}

function getFilename(header){
  let text='';try{text=decodeURIComponent(String(header||''));}catch{throw Object.assign(new Error('Invalid filename encoding.'),{status:400});}
  const file=path.basename(text.replace(/\\/g,'/')).replace(/[^a-zA-Z0-9._-]/g,'_');
  if (!file || file.length>90 || !file.toLowerCase().endsWith('.csv') || file.startsWith('.')) throw Object.assign(new Error('Upload a valid .csv file with a short filename.'),{status:400});
  return file;
}
async function getPostBody(req){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('text/csv')) throw Object.assign(new Error('Only text/csv uploads are supported.'),{status:415});
  const limit=1024*1024;
  if(Number(req.headers['content-length']||0)>limit)throw Object.assign(new Error('CSV must be less than 1 MB.'),{status:413});
  const chunks=[];let total=0;
  for await(const buf of req){total+=buf.length;if(total>limit)throw Object.assign(new Error('CSV must be less than 1 MB.'),{status:413});chunks.push(buf);}
  const buffer=Buffer.concat(chunks);
  if(!buffer.length)throw Object.assign(new Error('CSV cannot be empty.'),{status:400});
  if(buffer.includes(0))throw Object.assign(new Error('CSV must be plain text, not binary.'),{status:400});
  return buffer;
}
async function upload(req){
  const filename=getFilename(req.headers['x-filename']);
  const file=await getPostBody(req);
  if(CONFIG.demo)return demoScan(file,filename);
  const key=`incoming/${Date.now()}-${randomUUID().slice(0,8)}-${filename}`;
  // Upload to incoming/ triggers the user's EXISTING S3 -> Lambda workflow.
  // KMS encryption is applied by the bucket's SSE-KMS default configuration.
  await s3.send(new commandsS3.PutObjectCommand({Bucket:CONFIG.bucket,Key:key,Body:file,ContentType:'text/csv'}));
  return {mode:'aws',key,status:'uploaded'};
}

const staticPaths = new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.js','app.js']]);
const types={'index.html':'text/html; charset=utf-8','styles.css':'text/css; charset=utf-8','app.js':'text/javascript; charset=utf-8'};
const server=http.createServer(async (req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'");
  let url;
  try{url=new URL(req.url,'http://127.0.0.1');}catch{return send(res,400,{error:'Invalid URL'});}
  if(req.method==='GET'&&staticPaths.has(url.pathname)){
    const name=staticPaths.get(url.pathname);
    try{const content=await readFileAsync(path.join(root,'public',name));res.writeHead(200,{'Content-Type':types[name],'Cache-Control':'no-cache'});res.end(content);}catch{send(res,500,{error:'Unable to read static file.'});}
    return;
  }
  if(!url.pathname.startsWith('/api/'))return send(res,404,{error:'Not found'});
  try{
    if(req.method==='GET'&&url.pathname==='/api/overview')return send(res,200,await overview());
    if(req.method==='GET'&&url.pathname==='/api/security')return send(res,200,await security());
    if(req.method==='GET'&&url.pathname==='/api/monitoring')return send(res,200,await monitoring());
    if(req.method==='GET'&&url.pathname==='/api/report'){
      const key=url.searchParams.get('key')||'';
      if(!key.startsWith('reports/')||!key.endsWith('.json')||key.length>512)return send(res,400,{error:'Invalid report key.'});
      const result=CONFIG.demo?getDemoReport(key):await s3Json(key);
      if(!result)return send(res,404,{error:'Report not found.'});
      return send(res,200,result);
    }
    if(req.method==='POST'&&url.pathname==='/api/upload'){
      const origin=req.headers.origin;
      if(origin && origin!==`http://127.0.0.1:${CONFIG.port}`&&origin!==`http://localhost:${CONFIG.port}`)return send(res,403,{error:'Cross-origin uploads are not allowed.'});
      return send(res,200,await upload(req));
    }
    return send(res,404,{error:'API endpoint not found.'});
  }catch(err){
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: ${errorMessage(err)}`);
    // Do not expose underlying AWS credentials, private ARNs, or call stack to the browser.
    const safeMessage=err.status?err.message:CONFIG.demo?'Unexpected error.':'AWS operation failed. Check the local server console and the AWS permissions.';
    return send(res,err.status||500,{error:safeMessage});
  }
});
server.listen(CONFIG.port,'127.0.0.1',()=>{
  console.log(`\nSentinel Dashboard running at http://127.0.0.1:${CONFIG.port}`);
  console.log(`Mode: ${CONFIG.demo?'DEMO (local sample data only)':'LIVE AWS (S3 + CloudWatch)'}`);
  console.log(`Bucket: ${CONFIG.bucket}\n`);
});
