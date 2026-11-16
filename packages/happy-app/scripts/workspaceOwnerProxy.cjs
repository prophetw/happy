const http = require('node:http');
const prefix = '/api/workspace-owner/v1/';
/** Local development same-origin API. No cookies, arbitrary target, shell or
 * credential persistence; the owner API authenticates every request itself. */
module.exports = function workspaceOwnerProxy(next, raw) {
    let target;
    if (raw) {
        target = new URL(raw);
        if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/'
            || target.username || target.password || target.search || target.hash) throw Error('WORKSPACE_OWNER_PROXY_TARGET_INVALID');
    }
    return (req, res, done) => {
        if (!req.url?.startsWith(prefix)) return next(req, res, done);
        if (!target) { res.writeHead(503, { 'Content-Type':'application/json' });res.end(JSON.stringify({version:1,ok:false,error:{code:'WORKSPACE_MANAGER_UNAVAILABLE'}}));return; }
        const headers = { origin:req.headers.origin ?? `http://${req.headers.host}`, accept:'application/json' };
        for (const key of ['authorization','content-type']) if (req.headers[key]) headers[key] = req.headers[key];
        const upstream=http.request({host:'127.0.0.1',port:target.port,method:req.method,path:req.url,headers},reply=>{
            res.writeHead(reply.statusCode ?? 503, {'Content-Type':'application/json','Cache-Control':'no-store'});reply.pipe(res);
        });
        upstream.setTimeout(25000,()=>upstream.destroy());
        upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({version:1,ok:false,error:{code:'WORKSPACE_RESULT_UNKNOWN'}}));});
        req.pipe(upstream);
    };
};
