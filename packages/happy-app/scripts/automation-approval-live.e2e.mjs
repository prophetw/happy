// Read-only live smoke: isolated anonymous contexts; never logs in or approves.
// Default target is the current Tailscale private entry; the retired 99.57 URL
// (https://szsp.suitbim.com.cn:7100/happy/settings/automation) now returns 410.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const url=new URL(process.env.HAPPY_APPROVAL_UI_URL ?? 'https://desktop-8ut4p0p.taild92624.ts.net/happy/settings/automation');
assert.equal(url.protocol,'https:');assert.equal(url.pathname,'/happy/settings/automation');assert(!url.username&&!url.password&&!url.hash);assert([...url.searchParams.keys()].every(k=>k==='connection'));
const artifacts=path.resolve(fileURLToPath(new URL('../../../',import.meta.url)),'.e2e-artifacts',`automation-live-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(artifacts,{recursive:true});
const profiles=[];let browser;
function safePath(value){try{const p=new URL(value);return p.origin+p.pathname;}catch{return '<non-url>';}}
try{
 browser=await chromium.launch({headless:true});
 for(const profile of [{name:'desktop',viewport:{width:1440,height:1000}},{name:'mobile',viewport:{width:390,height:844},isMobile:true,hasTouch:true}]){
  const {name,...options}=profile,context=await browser.newContext({...options,locale:'zh-CN',serviceWorkers:'block'});
  const result={name,resources:[],errors:[],warnings:[],failedRequests:[],blockedRequests:[],checks:{}};profiles.push(result);
  await context.route('**/*',route=>{const r=route.request();if(new URL(r.url()).origin!==url.origin||!['GET','HEAD'].includes(r.method())){result.blockedRequests.push({method:r.method(),path:safePath(r.url())});return route.abort();}return route.continue();});
  await context.routeWebSocket('**/*',socket=>{result.blockedRequests.push({method:'WS',path:safePath(socket.url())});socket.close();});
  const page=await context.newPage();
  page.on('pageerror',e=>result.errors.push(e.name));page.on('console',m=>{if(m.type()==='error')result.errors.push('console-error');if(m.type()==='warning')result.warnings.push(m.text().startsWith('[Layout children]: No route named "dev/masked-progress"')?'existing-dev-route-warning':'unexpected-console-warning');});
  page.on('response',r=>result.resources.push({path:safePath(r.url()),status:r.status(),type:r.request().resourceType(),contentType:r.headers()['content-type']||''}));
  page.on('requestfailed',r=>result.failedRequests.push({path:safePath(r.url()),error:r.failure()?.errorText}));
  const response=await page.goto(url.href,{waitUntil:'networkidle',timeout:45000});
  await page.getByRole('heading',{name:'由你决定助手能做什么',exact:true}).waitFor();
  result.checks.document200=response.status()===200;
  result.checks.loginBoundaryVisible=await page.getByRole('button',{name:'前往 Happy 登录',exact:true}).count()===1;
  result.checks.approvalAbsent=await page.getByRole('button',{name:'确认批准以上权限',exact:true}).count()===0;
  result.checks.manualReviewDisabled=await page.getByRole('button',{name:'审查连接',exact:true}).isDisabled();
  result.checks.noProtectedRestRequest=result.resources.every(r=>!r.path.startsWith(url.origin+'/happy-control/'));
  result.checks.connectionIDPreserved=await page.getByLabel('助手连接 ID',{exact:true}).inputValue()===(url.searchParams.get('connection')||'');
  result.checks.noHorizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('*')].every(e=>e.getBoundingClientRect().width===0||e.getBoundingClientRect().right<=innerWidth+1));
  result.checks.staticAssetsValid=result.resources.some(r=>r.type==='script')&&result.resources.every(r=>r.status<400&&(!['script','font','stylesheet','image'].includes(r.type)||!r.contentType.includes('text/html')));
  result.checks.noRuntimeOrNetworkError=result.errors.length===0&&result.failedRequests.length===0&&result.blockedRequests.length===0;
  result.checks.noNewWarnings=result.warnings.every(w=>w==='existing-dev-route-warning');
  await page.screenshot({path:path.join(artifacts,`${name}.png`),fullPage:true,mask:[page.locator('canvas')]});
  await context.close();
 }
 assert(profiles.every(p=>Object.values(p.checks).every(Boolean)), 'Live anonymous approval smoke failed; inspect local report');
} finally {
 if(browser)await browser.close();
 await writeFile(path.join(artifacts,'report.json'),JSON.stringify({timestamp:new Date().toISOString(),anonymousOnly:true,realLogin:false,realApproval:false,browserClosed:true,profiles},null,2)+'\n');
 console.log(JSON.stringify({artifacts,profiles:profiles.map(p=>({name:p.name,checks:p.checks,errors:p.errors,warnings:p.warnings})),browserClosed:true}));
}
