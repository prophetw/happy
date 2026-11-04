import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Loopback metadata only. No token, cookie, task or response body is logged. */
export function probeReady({ port = 9010, timeoutMs = 2500 } = {}) {
    return new Promise(resolve => {
        let bytes = 0, body = '';
        const req = request({ host: '127.0.0.1', port, path: '/readyz', timeout: timeoutMs }, response => {
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 2048) { req.destroy(); resolve(false); } else body += chunk;
            });
            response.on('end', () => {
                try { const value = JSON.parse(body); resolve(response.statusCode === 200 && value.version === 1 && value.ok === true && value.data?.ready === true && value.data?.protocol === 1); }
                catch { resolve(false); }
            });
            response.on('error', () => resolve(false));
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.end();
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await probeReady() ? 0 : 1;
